# ADR 0005 — Forced password change: a server-enforced door, directive in the user's own Files

Status: Proposed (2026-09-07)

> **Scope confirmed by the owner (2026-09-07):** the directive lives in the
> **target user's own account Files** (its `gilbert` app folder), not in the
> admin group's Files. The privileged write is solved by Stalwart 0.16's JMAP
> **impersonation**: members of the `gilbert-admin@` group carry the
> impersonation right (granted in Stalwart's directory, like the group
> membership itself), and the server authenticates as the composite
> `{target}%{admin}` to set and clear the directive. The user's own session
> clears it on a successful password change. Option A was checked first:
> Stalwart has **no native** force-change attribute (code + issues search,
> 2026-09-07; #3181 closed `not_planned`).
>
> Accepted consequence, stated plainly: this is **soft enforcement**. The
> account owner can write their own Files with any JMAP client, so a user
> determined to defeat the wall can delete the directive; the wall stops
> everyone who uses the product, which is the point. Absolute enforcement is
> only possible inside Stalwart itself, and Stalwart offers no hook for it.

## Context

Facts from the current machinery (verified 2026-09-07):

- Sign-in Basic-auths to Stalwart through the Node server, which keeps a
  sealed session and proxies every JMAP call behind `requireSession`
  (`server/src/app.ts`). Everything the browser does goes through this proxy.
- The session seal stores `{username, password}` encrypted
  (`server/src/sessions.ts` `sealedCredentials`), so the server can rebuild a
  `Basic` authorization for upstream calls — including a **composite
  impersonation username** `{target}%{admin}` that Stalwart 0.16 authenticates
  as the target using the master's credentials (app passwords are refused for
  impersonation; the grant lives in Stalwart's directory).
- Per-account durable state lives in the account's own JMAP Files under the
  `gilbert` app folder (`settings.json`, signature files); the client
  whole-file-replaces `settings.json` on save, so a server-only directive must
  be a **separate file**, or the next settings save would drop it.
- Credential self-service runs over `urn:stalwart:jmap` with the user's own
  session (`server/src/account.ts` `x:AccountPassword/set`). A successful
  password change revokes every other session
  (`sessions.destroyAllForUser`).
- Admin is membership of the `gilbert-admin@<domain>` group (ADR 0001,
  hardcoded by ADR 0004), computed server-side (`upstream.ts`
  `isAdminSession`). There are no server admin endpoints yet and no
  impersonation path in the mock.
- The directive's home and its admin write path are the per-user surface of
  ADR 0001 (§3: the impersonation write; §4: documents as separate files in
  the target's hidden `gilbert` app folder) — the same mechanism the future
  per-user policy editor uses.
- Any 401 makes the client return to sign-in
  (`web/src/jmap/client.ts` `handleUnauthenticated`); "kick" (ADR 0004)
  reuses it after `destroyAllForUser`.

## Decision

### 1. The directive is a small file in the target user's own app folder

`must-change-password.json` inside the user's `gilbert` app folder (beside
`settings.json`; a separate file so the client's whole-file settings writes
never touch it). Content: `{ "setAt": "<ISO>", "setBy": "<admin username>" }`
for auditability. Missing file = not forced. Final name and shape are settled
at implementation time; the ADR fixes the location and ownership.

### 2. Admin sets and clears it through impersonation

- New server endpoints behind `requireAdmin` (group membership re-checked per
  request, as in ADR 0001): `POST /api/admin/force-password-change` with the
  target username and a `clear` boolean (or a single toggle endpoint).
- The server authenticates to Stalwart as the composite
  `{target}%{<admin>}` — rebuilding the admin's `Basic` from the sealed
  session — and writes or removes the file in the target's app folder with
  ordinary JMAP (FileNode create/update/destroy + blob). No Management API,
  no second secret: the impersonation right is the grant, granted in
  Stalwart's directory exactly like group membership.
- A target that has no `gilbert` app folder yet gets one created by the same
  write.

### 3. The server enforces, per request; the client only shows

- At sign-in, right after credential validation (the server already opens an
  upstream session for capabilities/account info), the server reads the
  directive from the user's own Files with that same upstream session and
  marks the new session `gilbert.mustChangePassword: true`.
- A middleware on the `/api` router answers **`403 { error:
  "password_change_required" }`** for every data route (`/api/jmap`,
  `/upload`, `/blob`, `/image`, `/ics`, `/events`, `/account/*` except
  `/account/password`) while the directive exists for the session's user. The
  check is judged per request against a short-TTL cache of the directive, so
  a user forced while already signed in is stopped at their next request.
  `/auth/login`, `/auth/logout`, `/auth/session`, `/api/config`,
  `/api/health` and `/api/account/password` stay open.
- The client shows the wall when the session says `mustChangePassword` and
  when a mid-session 403 `password_change_required` arrives: a full-screen
  view reusing the change-password form (current + new + confirm, the fields
  of `SecuritySettings`), whose only exits are a successful change or
  sign-out. New copy follows gilbert-i18n (English keys, catalog fallback).
- Enforcement is the middleware, not the view: a client that never renders
  the wall still cannot reach a data byte through the proxy.

### 4. Clearing on change; app passwords exempt

- `POST /api/account/password` already verifies the current password and
  changes it; when the user was forced, the handler additionally deletes the
  directive file (with the user's own session — no impersonation needed for
  the clear) before returning. Other sessions are revoked by the existing
  `destroyAllForUser`.
- Interactive sign-in with password/TOTP is what the wall gates. Sign-in with
  an **app password** (no UI; workers and scripts, ADR 0003) is not gated.

### 5. Mock parity and tests

The mock gains: composite-username authentication (`{target}%{master}` acting
as the target) on the paths the feature uses, the per-account directive file,
the 403 door, and the clear-on-change flow — with comments saying what it
reproduces and what a real 0.16 server does differently (impersonation facts
re-verified against a live server with a dated comment, per repo convention).
Tests cover: sign-in with the directive set returns a flagged session and a
blocked `/api/jmap`; the change endpoint clears the directive and unblocks; a
user forced while already signed in is stopped at the next request; admin set
and clear via impersonation; an app-password session is not gated; a missing
or corrupt directive file behaves as the not-forced state.

## Consequences

- The server gains two small admin endpoints and one per-request cached
  check; the only new power is the impersonation grant on the admin group,
  managed in Stalwart like the membership itself. No second secret, no
  Management API.
- This is the first **server-enforced** per-user door. Settings stay
  client-enforced conveniences (ADR 0001); a forced action needed the proxy,
  and the proxy is where the guarantee now lives.
- **Soft enforcement by design**: the account owner can write their own
  Files, so a determined user can delete the directive (accepted; see the
  scope note). The feature's value is stopping normal use of the product
  until the password is changed, plus the audit trail of who forced whom and
  when.
- The forced view is the only usable screen for that session: no mail, no
  settings, no way around except changing the password or signing out. Push
  and settings sync must not run while the wall is up (the 403 stops the
  data path; the client stops its own loops on the same signal).
- The container stays disposable; everything durable is in Stalwart (the
  directive file is account data like any other).

## Alternatives considered

- **Stalwart-native attribute**: verified absent (2026-09-07; #3181
  `not_planned`). If Stalwart later ships an identity-provider hook, the door
  stays and the directive's read/clear can delegate to it.
- **Flag on `x:AccountPassword`**: rejected — the user can write it
  (verified: self-service `x:AccountPassword/set`), same softness as the
  chosen design but no audit trail and no separate clear step.
- **Directive in the admin group's Files**: rejected by the owner — it needs
  the same privileged machinery (or heavier), and the user-Files variant is
  simpler while the enforcement difference is only against a user who already
  bypasses Gilbert.
- **Refuse sign-in entirely until changed (no session minted)**: changing the
  password needs a session, so v1 would need a new pre-auth credential-
  verifying endpoint with its own rate limiting. Rejected for v1; the
  gated-session door reaches the same outcome with the existing change path.
- **Client-side gating only**: rejected — anything a client asserts another
  client can fake.

## Open questions (recorded, not blocking v1)

- Stalwart impersonation mechanics against a real 0.16 server (composite
  auth header shape, app-password refusal, how the mock should mirror it) are
  verified at implementation time with a dated comment, per repo convention.
- Directory-managed principals without a Gilbert password (OAuth-only): the
  wall has nothing to change; the admin surface should refuse to force such a
  user (detection is a Stalwart-facts question for implementation).
- Whether setting the directive should kick the target's open sessions right
  away (ADR 0004's kick is the separate tool; the middleware already stops
  them at the next request).

## References

- `server/src/app.ts` — `requireSession`, `/api/jmap`, `/api/account/password`
  (change + `destroyAllForUser`)
- `server/src/sessions.ts` — sealed `{username, password}`, `destroyAllForUser`
- `server/src/upstream.ts` — `isAdminSession`, upstream session fetch at
  sign-in, account info
- `server/src/account.ts` — `jmap()`, `changePassword` over `urn:stalwart:jmap`
- `web/src/jmap/client.ts` — 401 → `handleUnauthenticated` (model for the
  403 forced-change path)
- `web/src/store/session.ts` — session `gilbert` extension
- `web/src/views/settings/SecuritySettings.tsx` — the change-password form
  the forced view reuses
- `web/src/lib/appFolder.ts` — the `gilbert` app folder in the account's Files
- ADR 0001 — admin group, impersonation write path (§3), hidden app folder
  as the home of per-user documents (§4), kick
- ADR 0004 — kick (publish → destroy sessions → re-login)
- stalwartlabs/stalwart (checked 2026-09-07) — no native force-change
  attribute; issue #3181 closed `not_planned`
