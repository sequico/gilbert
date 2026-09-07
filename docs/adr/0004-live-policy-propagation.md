# ADR 0004 — Rule changes reach signed-in clients by re-login (kick v0)

Status: Proposed (2026-09-07)

> **Scope confirmed by the owner (2026-09-07):** when the admin changes the
> rules, clients that are already open learn it by being signed out — the
> admin publishes, the sessions are kicked, and the next sign-in applies the
> new policy at boot. No refresh machinery, no polling. Cost of a re-login per
> publish is accepted ("2 accettabile"); kick and refresh stay distinct tools
> ("3 ok, documenta").
>
> The published policy is the **installation-wide policy on upstream's own
> channel** (ADR 0001 §4): the running `config.settingsPolicy` is replaced,
> the `SETTINGS_POLICY_FILE` file is rewritten when configured and writable,
> and sessions are kicked. No group-owned document and no server credential:
> the admin edits the same policy the server already serves at boot. The
> admin group is hardcoded to the local part `gilbert-admin` and grants on
> every domain of the server (ADR 0001 §1); membership enables the admin
> functions. Per-user policy publishing (ADR 0001 §5) is the v2 of the same
> step.

## Context

Facts from the current machinery:

- The installation-wide policy is read at boot from a file or the environment
  (`SETTINGS_POLICY_FILE` in `server/src/config.ts`) into
  `config.settingsPolicy` and served by `GET /api/config`; the client applies
  it at the sign-in boot sequence (`web/src/App.tsx`: policy → settings file
  → enforced → `changes` with a toast). The administration surface (ADR 0001)
  edits that same policy at runtime.
- ADR 0001 (Accepted, 2026-09-07) defines the surface: admin is membership of
  the `gilbert-admin` group mailbox, one per server, granting across all the
  domains the server serves (ADR 0001 §1); the install-wide policy stays on
  the boot file/env channel (ADR 0001 §4); per-user policy documents and
  security directives live in each user's own hidden `gilbert` app folder
  (ADR 0001 §5, ADR 0005); the settings enforcement door is client-side, and
  **kick** ("forced sign-out") is an existing tool
  (`sessions.destroyAllForUser`, 401 → sign-in screen) kept distinct from
  refresh on purpose.
- An earlier draft of this ADR designed a polling/refresh mechanism (mtime
  re-read + version + keep-warm poll). The owner chose the simpler path
  instead: publish → kick → re-login.

## Decision

1. **Admin group is hardcoded by local part: `gilbert-admin`.** A principal
   is an admin exactly when their JMAP session accounts contain a
   non-personal group account named `gilbert-admin@…` — matched by local
   part, on any domain of the server, whatever domain the principal's own
   address uses (ADR 0001 §1). No configuration, no env: the grant has one
   shape per server. Group members need no external email alias — membership
   alone enables the functions. `isAdmin` is computed server-side per request
   (a demotion is effective on the next privileged request, as in ADR 0001)
   and travels to the client under the `gilbert` session extension
   (`session.gilbert.isAdmin`) — a new field goes in the `gilbert` namespace,
   never the legacy one.
2. **Publishing is an explicit admin action: `POST /api/admin/policy`**
   (behind a `requireAdmin` guard that re-checks group membership). It takes
   the full installation-wide policy, validates it with the same parser
   semantics the boot path uses (invalid → 400, no crash), **replaces the
   running `config.settingsPolicy`** — effective immediately, no restart —
   and, when `SETTINGS_POLICY_FILE` is configured and writable, **rewrites
   the file atomically** so a restart keeps the change. It then kicks every
   session except the caller's (`destroyAll(exceptId)`). The boot file/env
   keeps its seed meaning; the publish endpoint is the supported way to
   change rules once the surface is in use. Manual edits to the raw file
   while the server runs still need a restart — the running copy is replaced
   only by publishing.
3. **Rule changes propagate by re-login in v0.** The existing 401 → sign-in
   path does the work: the kicked client lands on the sign-in screen on its
   next request, and the fresh sign-in applies the new policy at boot (same
   sequence as any sign-in: policy → enforced → `changes` toast). An idle
   background tab lands within the existing push-reconnect/visibility bound.
   No client refresh, no polling, no version header.
4. **Kick stays distinct from revocation** (ADR 0001): same primitive, but
   this trigger is a deliberate admin publish. Refresh-without-logout remains
   a possible later option if re-login per publish proves too noisy —
   documented, not built.
5. **Per-user publishing is v2 of the same step.** When ADR 0001's per-user
   documents land (each in the owning user's hidden folder), a per-user
   policy write goes through the same shape: the impersonation write of the
   document, then the affected sessions are kicked so the next sign-in
   re-reads it. Publishing is per user or per group of users; there is no
   publish-to-everyone operation (ADR 0001).

## Consequences

- Every signed-in session is ended once per publish; 2FA accounts re-enter an
  app password. Accepted cost ("2 accettabile").
- No new client machinery: the propagation path is the one every logout
  already uses.
- Granularity in v0 is every session, because the installation-wide policy
  applies to everyone by definition. When per-user documents land, publish
  can kick only the affected accounts.
- Whether a publish survives a restart is a deployment knob: with a writable
  `SETTINGS_POLICY_FILE` the change is durable; without one it is runtime
  state for the life of the process. The policy is installation configuration
  on upstream's channel (ADR 0001 §4).
- Policy remains client-enforced guidance, not a security boundary (ADR
  0001): enforcement keeps protecting enforced keys from the user, not from
  whoever can write the account. Security directives (ADR 0005) are the
  server-enforced exception.

## Client entry point (v0 scaffold, 2026-09-07)

While the surface is being built, the admin entry point already has a home:
a **shield icon in the top-bar action cluster**, immediately left of the
Settings gear and the account avatar (top right), rendered only when the
session carries `gilbert.isAdmin` — membership of the `gilbert-admin` group
on any domain of the server (ADR 0001 §1). It links to `/admin`, which is a
stub page today (the install-wide policy editor of ADR 0001 §4 and this
ADR's publish flow land there; the per-user editor follows in v2). One entry
point only: the icon is always visible where the other top-bar icons are
(including on mobile), so nothing duplicates it in the account menu. The
icon is cosmetic UI; the server stays the door (`requireAdmin` when the
publish endpoint ships). The label is the English word "Admin", which Italian
keeps as-is.

## Alternatives considered

- **Polling/refresh (previous draft of this ADR)**: mtime re-read + keep-warm
  poll + policy version. Rejected — machinery for an event that happens
  rarely, when a kick primitive already exists and the cost is one re-login.
- **True push**: out for the same reason ADR 0001 records (JMAP push only
  carries the user's own account state).
- **Publishing to a group-owned Stalwart document**: rejected by the owner on
  2026-09-07 — it changes the unauthenticated boot channel upstream defines
  and needs a server credential (ADR 0001 §4, Alternatives).
- **Kick only the affected accounts**: needs the per-user documents; deferred
  to ADR 0001 §5 (v2).

## References

- `docs/adr/0001-admin-group-and-administration-surface.md` — admin group
  (§1), install-wide policy on the boot channel (§4), enforcement door, kick
  vs refresh, per-user layer (§5)
- `server/src/config.ts` — `readSettingsPolicy` (shape and validation the
  editor shares; boot seed)
- `server/src/sessions.ts` — `destroyAllForUser`, session store
- `server/src/app.ts` — `requireSession`, 401 path, `/api/config`
- `web/src/App.tsx` — boot policy sequence, `changes` toast
- `web/src/store/session.ts` — sign-in/refresh, `onUnauthenticated`
- ADR 0005 — forced password change (server-enforced directive, publish
  shape at §2)
