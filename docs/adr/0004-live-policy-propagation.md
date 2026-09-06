# ADR 0004 — Rule changes reach signed-in clients by re-login (kick v0)

Status: Proposed (2026-09-07)

> **Scope confirmed by the owner (2026-09-07):** when the admin changes the
> rules, clients that are already open learn it by being signed out — the
> admin publishes, the sessions are kicked, and the next sign-in applies the
> new policy at boot. No refresh machinery, no polling. Cost of a re-login per
> publish is accepted ("2 accettabile"); kick and refresh stay distinct tools
> ("3 ok, documenta"). The admin group is hardcoded to `gilbert-admin@` and
> membership enables the admin functions.

## Context

Facts from the current machinery:

- The only admin lever today is the installation-wide file/env policy
  (`SETTINGS_POLICY_FILE`), read once at boot into `config.settingsPolicy`
  and served by `GET /api/config`; the client applies it at the sign-in boot
  sequence (`web/src/App.tsx`: policy → settings file → enforced → `changes`
  with a toast). There is no server-side admin concept yet.
- ADR 0001 (Accepted) defines the future surface: admin is membership of a
  group mailbox, per-user policy documents live in the admin group's Files,
  the enforcement door is client-side, and **kick** ("forced sign-out") is an
  existing tool (`sessions.destroyAllForUser`, 401 → sign-in screen) kept
  distinct from refresh on purpose. 0001 §3 delivered per-user policy changes
  at the next session/policy refresh and ruled out live push for v1.
- An earlier draft of this ADR designed a polling/refresh mechanism
  (mtime re-read + version + keep-warm poll). The owner chose the simpler
  path instead: publish → kick → re-login.

## Decision

1. **Admin group is hardcoded: `gilbert-admin@<domain>`.** A principal is an
   admin exactly when their JMAP session accounts contain the non-personal
   group mailbox of that name (`isPersonal === false`) for their own domain.
   No configuration, no env: the grant has one shape everywhere. Group members
   need no external email alias — membership alone enables the functions.
   `isAdmin` is computed server-side per request (a demotion is effective on
   the next privileged request, as in ADR 0001) and travels to the client
   under the `gilbert` session extension (`session.gilbert.isAdmin`) — a new
   field goes in the `gilbert` namespace, never the legacy one.
2. **Publishing is an explicit admin action: `POST /api/admin/policy`**
   (behind a `requireAdmin` guard that re-checks group membership). It takes
   the full policy, validates it with the same parser the boot path uses
   (invalid → 400, no crash), persists it to `SETTINGS_POLICY_FILE` when one
   is configured (atomic write) or keeps it in memory otherwise, and then
   kicks every session except the caller's (`destroyAll(exceptId)`).
3. **Rule changes propagate by re-login in v0.** The existing 401 → sign-in
   path does the work: the kicked client lands on the sign-in screen on its
   next request, and the fresh sign-in applies the new policy at boot (same
   sequence as any sign-in: policy → enforced → `changes` toast). An idle
   background tab lands within the existing push-reconnect/visibility bound.
   No client refresh, no polling, no version header.
4. **Kick stays distinct from revocation** (ADR 0001): same primitive, but
   this trigger is a deliberate admin publish. Refresh-without-logout remains
   a possible v1 if re-login per publish proves too noisy — documented, not
   built.
5. **Manual file edits while the server runs still need a restart.** The
   publish endpoint is the supported way to change rules; the raw file keeps
   its boot semantics.

## Consequences

- Every signed-in session is ended once per publish; 2FA accounts re-enter an
  app password. Accepted cost ("2 accettabile").
- No new client machinery: the propagation path is the one every logout
  already uses.
- Granularity in v0 is every session. When ADR 0001's per-user documents
  land, publish can kick only the affected accounts; until then the
  installation-wide policy touches everyone by definition.
- Policy remains client-enforced guidance, not a security boundary (ADR 0001):
  enforcement keeps protecting enforced keys from the user, not from whoever
  can write the account.

## Alternatives considered

- **Polling/refresh (previous draft of this ADR)**: mtime re-read + keep-warm
  poll + policy version. Rejected — machinery for an event that happens
  rarely, when a kick primitive already exists and the cost is one re-login.
- **True push**: out for v1 for the reason ADR 0001 records (JMAP push only
  carries the user's own account state).
- **Kick only the affected accounts**: needs the per-user documents; deferred
  to ADR 0001's surface.

## References

- `docs/adr/0001-admin-group-and-administration-surface.md` — admin group,
  enforcement door, kick vs refresh
- `server/src/config.ts` — `readSettingsPolicy`
- `server/src/sessions.ts` — `destroyAllForUser`, session store
- `server/src/app.ts` — `requireSession`, 401 path, `/api/config`
- `web/src/App.tsx` — boot policy sequence, `changes` toast
- `web/src/store/session.ts` — sign-in/refresh, `onUnauthenticated`
