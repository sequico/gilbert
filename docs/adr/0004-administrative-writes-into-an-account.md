# ADR 0004 — Administrative writes into a user's account

Status: Accepted (2026-09-09)

> **Scope confirmed by the owner (2026-09-07):** the administration surface
> changes rules in two shapes, and both are writes over ordinary JMAP.
>
> **The installation-wide policy stays on upstream's own channel** (ADR 0001
> §4): the admin publishes it, the running `config.settingsPolicy` is
> replaced, `SETTINGS_POLICY_FILE` is rewritten when configured and writable,
> and sessions are kicked. Clients already open learn it by being signed out
> — the next sign-in applies the new policy at boot. No refresh machinery,
> no polling; a re-login per publish is the accepted cost ("2 accettabile"),
> and kick and refresh stay distinct tools ("3 ok, documenta").
>
> **A security directive lives in the target user's own account Files** (its
> `gilbert` app folder), not in an admin's folder. The privileged write is
> solved by Stalwart 0.16's JMAP **impersonation**: the admin role carries
> the impersonation right (granted in Stalwart's directory), and the server
> authenticates as the composite `{target}%{admin}` to set and clear the
> directive. The user's own session clears it on a successful password
> change. Stalwart has **no native** force-change attribute (code + issues
> search, 2026-09-07; #3181 closed `not_planned`), so this is **soft
> enforcement**, stated plainly: the account owner can write their own Files
> with any JMAP client, so a determined user can delete the directive. The
> wall stops everyone who uses the product, which is the point; absolute
> enforcement is only possible inside Stalwart, which offers no hook for it.

## Context

- The installation-wide policy is read at boot from a file or the
  environment (`SETTINGS_POLICY_FILE` in `server/src/config.ts`) into
  `config.settingsPolicy` and served by `GET /api/config`; the client applies
  it at the sign-in boot sequence (`web/src/App.tsx`: policy → settings file
  → enforced → `changes` with a toast).
- Admin is resolved from the principal's own permission list, read from
  `/api/account` with the user's in-flight credentials (ADR 0001 §1); every
  admin endpoint sits behind `requireAdmin`, which repeats that check per
  request (ADR 0001 §2).
- Every privileged write goes through one server-side path: the composite
  impersonation username `{target}%{admin}`, whose `Basic` authorization is
  rebuilt from the sealed session (ADR 0001 §3). App passwords are refused
  for impersonation, and the grant lives in Stalwart's directory.
- Per-account durable state lives in the account's own JMAP Files under the
  `gilbert` app folder (`settings.json`, signature files); the client
  whole-file-replaces `settings.json` on save, so a server-only directive
  must be a **separate file**, or the next settings save would drop it.
- Credential self-service runs over `urn:stalwart:jmap` with the user's own
  session (`server/src/account.ts` `x:AccountPassword/set`), and a successful
  password change revokes every other session (`sessions.destroyAllForUser`).
- Any 401 makes the client return to sign-in
  (`web/src/jmap/client.ts` `handleUnauthenticated`); the kick reuses it.

## Decision

### 1. Publishing the installation policy replaces the running copy

`POST /api/admin/policy`, behind `requireAdmin`, takes the full
installation-wide policy, validates it with the same parser semantics the
boot path uses (invalid → 400, no crash), **replaces the running
`config.settingsPolicy`** — effective immediately, no restart — and, when
`SETTINGS_POLICY_FILE` is configured and writable, **rewrites the file
atomically** so a restart keeps the change. It then kicks every session
except the caller's (`destroyAll(exceptId)`). The boot file/env keeps its
seed meaning; publishing is the supported way to change rules once the
surface is in use, and a manual edit of the raw file while the server runs
still needs a restart.

### 2. Rule changes reach signed-in clients by re-login

The existing 401 → sign-in path does the work: a kicked client lands on the
sign-in screen on its next request, and the fresh sign-in applies the new
policy at boot (policy → enforced → `changes` toast). An idle background tab
lands within the existing push-reconnect/visibility bound. No client
refresh, no polling, no version header.

### 3. Kick stays distinct from revocation

Same primitive, different trigger: this one is a deliberate admin publish.
Refresh-without-logout stays a possible later option if a re-login per publish
proves too noisy — documented, not built. Per-user publishing is the same
shape one level down: the per-user policy document is written into the owning
user's hidden `gilbert` app folder (ADR 0001 §5) and the affected sessions are
kicked, so the next sign-in re-reads it. Publishing is per user or per group
of users; there is no publish-to-everyone operation (ADR 0001).

### 4. The forced-password directive is a file in the target user's own app folder

`must-change-password.json` inside the user's `gilbert` app folder, beside
`settings.json` — a separate file so the client's whole-file settings writes
never touch it. Content: `{ "setAt": "<ISO>", "setBy": "<admin username>" }`
for auditability. A missing file is the not-forced state.

### 5. Admin sets and clears the directive through impersonation

`POST /api/admin/force-password-change`, behind `requireAdmin` (the check is
repeated per request, ADR 0001 §2), takes the target username and a `clear`
boolean. The server authenticates to Stalwart as `{target}%{<admin>}` —
rebuilding the admin's `Basic` from the sealed session — and writes or removes
the file in the target's app folder with ordinary JMAP (FileNode
create/update/destroy + blob). A target with no `gilbert` app folder yet gets
one created by the same write. No Management API and no second secret: the
impersonation right is the grant (ADR 0001 §3).

### 6. The server enforces, per request; the client only shows

- At sign-in, right after credential validation and the `/api/account`
  introspection, the server reads the directive from the user's own Files with
  that same upstream session and marks the new session
  `gilbert.mustChangePassword: true`.
- A middleware on the `/api` router answers `403 { error:
  "password_change_required" }` for every data route (`/api/jmap`, `/upload`,
  `/blob`, `/image`, `/ics`, `/events`, `/account/*` except
  `/account/password`) while the directive exists for the session's user. The
  check is judged per request against a short-TTL cache of the directive, so a
  user forced while already signed in is stopped at their next request.
  `/auth/login`, `/auth/logout`, `/auth/session`, `/api/config`, `/api/health`
  and `/api/account/password` stay open.
- The client shows the wall when the session says `mustChangePassword` and
  when a mid-session 403 `password_change_required` arrives: a full-screen
  view reusing the change-password form of `SecuritySettings` (current + new +
  confirm), whose only exits are a successful change or sign-out. New copy
  follows gilbert-i18n (English keys, catalog fallback).
- Enforcement is the middleware, not the view: a client that never renders the
  wall still cannot reach a data byte through the proxy.

### 7. Clearing on change; app passwords exempt

`POST /api/account/password` already verifies the current password and changes
it; when the user was forced, the handler additionally deletes the directive
file with the user's own session — no impersonation needed for the clear —
before returning. Other sessions are revoked by the existing
`destroyAllForUser`. Interactive sign-in with password/TOTP is what the wall
gates; sign-in with an **app password** (no UI; workers and scripts, ADR 0003)
is not gated.

### 8. Mock parity and tests

The mock gains composite-username authentication (`{target}%{master}` acting
as the target) on the paths the feature uses, the per-account directive file,
the 403 door and the clear-on-change flow, with comments saying what it
reproduces and what a real 0.16 server does differently. Tests cover: a
sign-in with the directive set returns a flagged session and a blocked
`/api/jmap`; the change endpoint clears the directive and unblocks; a user
forced while already signed in is stopped at the next request; admin set and
clear via impersonation; an app-password session is not gated; a missing or
corrupt directive file behaves as the not-forced state.

## Consequences

- Every signed-in session is ended once per publish; 2FA accounts re-enter an
  app password. Accepted cost ("2 accettabile"). No new client machinery for
  the policy: the propagation path is the one every logout already uses.
- Granularity is every session, because the installation-wide policy applies
  to everyone by definition; per-user publishes kick only the affected
  accounts (§3).
- Whether a publish survives a restart is a deployment knob: with a writable
  `SETTINGS_POLICY_FILE` the change is durable, without one it is runtime
  state for the life of the process.
- The server gains two small admin endpoints and one per-request cached check.
  The only new power is the impersonation right, managed in Stalwart's
  directory like the admin role itself.
- The forced-password door is the first **server-enforced** per-user rule;
  settings stay client-enforced conveniences (ADR 0001). It is soft
  enforcement by design, and its value is stopping normal use of the product
  until the password changes, plus the audit trail of who forced whom and when.
- The forced view is the only usable screen for that session: no mail, no
  settings, no way around except changing the password or signing out. Push
  and settings sync must not run while the wall is up (the 403 stops the data
  path; the client stops its own loops on the same signal).
- The container stays disposable; everything durable is in Stalwart (the
  directive file is account data like any other).

## Alternatives considered

- **Polling/refresh**: mtime re-read + keep-warm poll + policy version.
  Rejected — machinery for an event that happens rarely, when a kick primitive
  already exists and the cost is one re-login.
- **True push**: out for the same reason ADR 0001 records (JMAP push only
  carries the user's own account state).
- **Publishing to a group-owned Stalwart document**: rejected by the owner on
  2026-09-07 — it changes the unauthenticated boot channel upstream defines
  and needs a server credential (ADR 0001 §4).
- **Kick only the affected accounts**: needs the per-user documents; that is
  the per-user shape (§3), not the install-wide one.
- **Stalwart-native force-change attribute**: verified absent (2026-09-07;
  #3181 `not_planned`). If Stalwart later ships an identity-provider hook, the
  door stays and the directive's read/clear can delegate to it.
- **Flag on `x:AccountPassword`**: rejected — the user can write it (verified:
  self-service `x:AccountPassword/set`), the same softness with no audit trail
  and no separate clear step.
- **Refuse sign-in entirely until changed (no session minted)**: changing the
  password needs a session, so it would need a new pre-auth
  credential-verifying endpoint with its own rate limiting. Rejected; the
  gated-session door reaches the same outcome.
- **Client-side gating only**: rejected — anything a client asserts another
  client can fake.

## References

- `docs/adr/0001-the-administration-surface.md` — the admin grant (§1),
  per-request enforcement (§2), the impersonation write path (§3), the
  install-wide policy on the boot channel (§4), per-user documents (§5)
- `server/src/config.ts` — `readSettingsPolicy` (shape and validation the
  editor shares; boot seed), `SETTINGS_POLICY_FILE`
- `server/src/app.ts` — `requireAdmin`, `requireSession`, `/api/jmap`,
  `/api/account/password`
- `server/src/sessions.ts` — sealed `{username, password}`,
  `destroyAllForUser`
- `server/src/upstream.ts` — `isStalwartAdmin`, upstream session fetch at
  sign-in
- `server/src/account.ts` — `jmap()`, `changePassword` over
  `urn:stalwart:jmap`
- `web/src/App.tsx` — boot policy sequence, `changes` toast
- `web/src/jmap/client.ts` — 401 → `handleUnauthenticated`; the 403
  forced-change path
- `web/src/store/session.ts` — session `gilbert` extension, sign-in/refresh
- `web/src/views/settings/SecuritySettings.tsx` — the change-password form the
  forced view reuses
- `web/src/lib/appFolder.ts` — the `gilbert` app folder in the account's Files
- ADR 0003 — the app-password sign-in the wall leaves ungated
- stalwartlabs/stalwart (checked 2026-09-07) — no native force-change
  attribute; issue #3181 closed `not_planned`

