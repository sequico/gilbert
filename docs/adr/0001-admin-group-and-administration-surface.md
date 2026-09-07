# ADR 0001 — Admin group, per-user policy and the administration surface

Status: Accepted (2026-09-07)

> **Scope confirmed by the owner (2026-09-06, revised 2026-09-07):**
> administration here means product-level administration only — offered
> **inside Gilbert** as a gated section for users whose admin status is
> granted by membership of the admin group in Stalwart. The first features
> are the **per-user policy editor** (for every key of `DEFAULT_SETTINGS` an
> admin sets the user's value and whether it is `enforced`, saved as named
> profiles and copied onto other users) and **security directives** such as
> forced password change (ADR 0005).
>
> Per-user policy documents and security directives live **in each user's own
> account**, in the hidden `gilbert` app folder, next to `settings.json` —
> not in the admin group's Files. The admin writes them through Stalwart's
> JMAP **impersonation** (composite `{target}%{admin}`), the same mechanism
> the future administration panel uses for every per-user write. The admin
> group stays the **grant**: membership of `gilbert-admin@` is what makes a
> user an admin; the group itself no longer owns documents.
>
> Enforcement is soft by design and stated as such: the app folder is hidden
> from the Files view but is not a security boundary (the account owner can
> write it with any JMAP client or the browser's own session), so a
> determined user can alter their own policy or directives only by acting
> outside the product, deliberately and detectably.
>
> Stalwart-system administration (accounts, aliases, quotas, directory) is
> out of scope: it is not JMAP-reachable, stays in Stalwart's own tooling,
> and would need a separate decision (Management API) if it ever changes.

## Context

Gilbert's direction is centralized administration of many accounts, but
until the per-user surface exists no account is special: every session is
equal, and the only installation-wide knob is the settings policy, read at
boot from a file or the environment (`readSettingsPolicy` in
`server/src/config.ts`) and applied client-side.

The product direction wants:

- an administration grant for the accounts that run the installation, stored
  inside Stalwart (architecture law: everything durable lives in Stalwart,
  no own database, disposable container);
- an administration surface inside the product that appears only to granted
  admins (manage settings/privileges, security directives, force sign-out,
  later more);
- standard behaviour for everyone else, unchanged.

Facts from the current machinery:

- The browser never holds credentials. Sign-in Basic-auths to Stalwart through
  the Node server, which keeps a sealed session and proxies every JMAP call
  behind `requireSession` (`server/src/app.ts`, `POST /api/jmap`).
- The session seal stores `{username, password}` encrypted
  (`server/src/sessions.ts`), so the server can rebuild a `Basic`
  authorization for upstream calls — including Stalwart 0.16's **composite
  impersonation username** `{target}%{admin}`, which authenticates as the
  target using the master's credentials. App passwords are refused for
  impersonation; the impersonation right is granted in Stalwart's directory,
  like the group membership itself.
- Sessions live in a server-side store (`server/src/sessions.ts`) that already
  has the primitive `destroyAllForUser` (used by "sign out other sessions" and
  on credential change).
- Any 401 from an API call makes the client stop push and settings sync,
  clear signed-in data and return to the sign-in screen by itself
  (`web/src/jmap/client.ts` `handleUnauthenticated`;
  `web/src/store/session.ts` `onUnauthenticated`).
- The client session object carries `username` plus a `gilbert` extension
  object (`web/src/jmap/types.ts`) — the natural place for an `isAdmin` flag.
- Per-account durable settings live as `settings.json` in the account's own
  JMAP Files under the hidden `gilbert` app folder
  (`web/src/lib/appFolder.ts`); the Files view filters that folder out of
  everything it shows (`web/src/store/files.ts`). The client whole-file-
  replaces `settings.json` on save, so server-owned per-user documents must
  be separate files in the same folder.
- The settings policy is fetched once per page lifetime and cached client-side
  (`web/src/lib/settingsPolicy.ts`); enforced values are re-applied at
  boot/hydrate and on every settings update (`web/src/store/settings.ts`).

## Decision

### 1. The grant is a group mailbox in Stalwart's own directory

Administration is granted by **membership of a dedicated Stalwart group
mailbox** (conventionally `gilbert-admin@<domain>`), created and managed by
the operator in Stalwart's own administration — the same surface that creates
accounts. Membership **is** the grant: no list document, no special account
identity, no file or environment. Multiple admins come for free (add whoever
to the group); revocation is removing them from the group.

The server learns who is admin from the user's own JMAP session at
sign-in/refresh: among the accounts Stalwart exposes to the authenticated
principal, the presence of the configured admin group (a non-personal
account that only its members can see) means `isAdmin`. The admin group's
name is plain configuration beside `STALWART_URL`; it is not a secret.

First-install sequence:

1. The operator creates the group mailbox in Stalwart and adds the first
   admins as members (Stalwart's own administration; no Gilbert involved
   yet).
2. Any member signs in to Gilbert; the server sees the admin group among
   their accounts and treats them as admin.
3. From the administration surface the first admin creates the first per-user
   policy or security directive.
4. Membership is managed in Stalwart afterwards; an account is admin while it
   is a member and only while it is.

An upgrade of an existing installation needs no migration: there is no
pre-existing grant to move; the operator creates the group and membership
defines admin from then on.

### 2. The server enforces, per request; the client only shows

`isAdmin` is computed server-side from the presence of the admin group in the
principal's session accounts on every relevant request (short-TTL in-memory
cache of the account set), never sealed into the session at sign-in, so a
demotion is effective on the very next privileged request of an already open
session. Admin endpoints get a `requireAdmin` guard beside `requireSession`.
The client receives only `isAdmin: boolean` on the session's `gilbert`
extension (added to the login and `/api/auth/session` responses), which shows
or hides the admin entry point. UI gating is cosmetic; the server is the
door.

`/api/config` stays unauthenticated and must never carry who administers the
installation — membership is only ever answered for an authenticated session.

### 3. The admin writes per-user documents through impersonation

Every per-user write from the administration surface — a policy document
(defaults/enforced per user, saved profiles), a security directive (ADR
0005), anything later — goes through one server-side path: the server
authenticates to Stalwart as the composite `{target}%{<admin>}`, rebuilding
the admin's `Basic` authorization from the sealed session, and performs
ordinary JMAP (FileNode/blob) operations on the target's own `gilbert` app
folder. No Management API and no second secret: the impersonation right on
the admin group is the write grant, granted in Stalwart's directory exactly
like the membership itself.

The client never holds the admin's credentials in a form it can use; the
impersonation happens only inside the server, for the duration of the admin
action.

### 4. Per-user policy documents and security directives live in the user's own hidden folder

The per-user documents are separate files inside the target account's hidden
`gilbert` app folder, beside `settings.json`:

- per-user settings policy (values + `enforced` flags) and named profiles;
- security directives (ADR 0005: the forced-password-change marker), read
  and enforced by the server, not by the client.

A user with no policy document has no policy: the code's own defaults apply.
A missing document is the normal first-boot state, not an error.

Delivery to the client: the effective per-user policy is read from the
user's own folder **after sign-in** and enforced through the existing door
(`update()` re-applies `policyEnforced`). The folder is hidden from the
Files view, which is what keeps the policy out of the way of ordinary use.

### 5. Propagation semantics

- **Privilege change**: enforcement is immediate at the next privileged
  request, judged against the principal's account set as Stalwart last
  reported it (the server caches the upstream session for a few minutes, so
  a revocation lands within that window). Visible UI follows at the next
  session refresh (`GET /api/auth/session?refresh=1`, exposed as
  `session.refresh()` in `web/src/store/session.ts`), triggered on window
  focus and after a membership change.
- **Per-user policy change**: reaches a signed-in user at the next
  session/policy refresh (the client re-fetches the session on window focus),
  and new sign-ins get it at once. A live push to open tabs is not v1 (JMAP
  push only carries the user's own account state).
- **Security directives**: read by the server per request (short-TTL cache)
  and enforced by the proxy, as in ADR 0005 — a forced user is stopped at
  their next request whether or not their client cooperates.
- **Forced sign-out ("kick")**: an admin endpoint destroys the target user's
  sessions through the existing session-store primitive. The open client
  lands on the sign-in screen on its next request via the existing
  401 → `handleUnauthenticated` path — immediate on interaction, and for an
  idle background tab within the push reconnect backoff (≤ ~60 s) or on the
  next visibility change. No new client machinery is required in v1.
- Reload or refresh propagates changes; kick terminates sessions. The two
  tools are kept distinct on purpose.

## Consequences

- The server gains the impersonation write path as its one privileged JMAP
  client, used by every per-user admin action. No bootstrap secret beyond the
  admin's own sealed session; the impersonation right is operator-managed in
  Stalwart.
- **Soft enforcement is the standing stance.** The hidden folder is hidden
  from the Files UI but is not a security boundary: the account owner can
  write it with any JMAP client or from the browser's own session, so a
  user who knows the mechanism can alter their own policy or directives.
  Doing so means acting outside the product, deliberately, and security
  directives carry `setAt`/`setBy`, so removal is detectable by an admin.
  Absolute enforcement is only possible inside Stalwart itself.
- A **corrupt** policy or directive document must not refuse boot or
  sign-in: the server logs loudly and treats it as absent (degraded, visible
  to admins) until it is repaired through the surface.
- Membership changes reach the server within the upstream-session cache
  window; per-user policy changes reach a signed-in user at the next
  session/policy refresh. The container stays disposable.
- Settings remain per-account conveniences, client-enforced; admin *actions*
  and security directives are server-enforced. The hidden folder is a data
  location, never a security boundary.

## Alternatives considered

- **A reserved holder account, admin by identity, with an `admin.json` roster
  in its Files**: rejected — it made one account permanently special and the
  first admin a matter of identity rather than of an explicit grant.
- **Per-user documents in the admin group's Files** (an earlier version of
  this ADR): rejected by the owner on 2026-09-07 — it needed a second
  privileged surface (group credentials or group-member writes) while the
  user-folder + impersonation path serves every per-user write with one
  mechanism, and the enforcement difference only matters against a user who
  already acts outside the product.
- **A per-account flag on `x:AccountSettings`**: rejected — it has no
  free-form field and setting it needs Stalwart-admin rights anyway, so the
  group membership is the same effort with better auditability.
- **Env/file list of admins**: simplest, but a second configuration surface,
  not durable in Stalwart, and it would drift from any in-Stalwart grant.
- **Client-side gating only** (an `isAdmin` flag on the session, no server
  check): rejected; anything a client can assert another client can fake.

## Open questions (recorded, not blocking v1)

- Multi-Stalwart installs (`STALWART_SERVERS_FILE`): impersonation targets a
  principal on a given Stalwart — is the admin group per server and does an
  admin on one server administer accounts on another?
- Managing admin *membership* or the impersonation *right* from Gilbert
  (rather than from Stalwart's own administration) is not reachable over
  JMAP — it would take the Stalwart Management API and a deliberate bend of
  the "JMAP only" law. Explicitly out of scope here; revisit as a separate
  ADR if an admin v2 needs it.
- Whether the per-user documents should also feed an audit log of admin
  actions later (a natural second use of the `setAt`/`setBy` fields).

## References

- `server/src/app.ts` — `requireSession`, `/api/jmap`, sign-out-others
- `server/src/sessions.ts` — sealed `{username, password}`, `destroyAllForUser`
- `server/src/upstream.ts` — `isAdminSession`, admin group name, upstream
  session fetch
- `server/src/config.ts` — `readSettingsPolicy` (file/env boot-read precedent)
- `web/src/jmap/client.ts` — 401 → `handleUnauthenticated`
- `web/src/store/session.ts` — `refresh()`, `onUnauthenticated`
- `web/src/lib/settingsPolicy.ts` — per-page policy cache
- `web/src/store/settings.ts` — `DEFAULT_SETTINGS`, enforcement door
- `web/src/lib/appFolder.ts` — the hidden `gilbert` app folder
- `web/src/store/files.ts` — the Files view's hidden-folder filter
- `web/src/jmap/types.ts` — `JmapSession.username`, `gilbert` extension
- ADR 0004 — kick (publish → destroy sessions → re-login)
- ADR 0005 — forced password change (first security directive)
