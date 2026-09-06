# ADR 0001 — Admin group, per-user policy and the administration surface

Status: Accepted (2026-09-06)

> **Scope confirmed by the owner (2026-09-06):** administration here means
> product-level administration only ("A puro") — offered **inside Gilbert** as
> a gated section for users whose admin status is granted by membership of the
> admin group in Stalwart. The first feature is the **per-user policy
> editor**: for every key of `DEFAULT_SETTINGS` an admin sets the user's
> value and whether it is `enforced` (the user cannot change it), and can
> **save a user's policy as a named profile** and **copy it onto other
> users**. The policy documents (`user-policies.json`, `profiles.json`) live
> in the admin group's own JMAP Files — everything durable in Stalwart, no
> file/env exception. New identifiers introduced by this work are named
> `gilbert` (never `gilbert`); existing gilbert-named data stays.
>
> Stalwart-system administration (accounts, aliases, quotas, directory) is out
> of scope: it is not JMAP-reachable, stays in Stalwart's own tooling, and
> would need a separate decision (Management API) if it ever changes.

## Context

Gilbert's direction is centralized administration of many accounts, but today
no account is special: every session is equal, and the only installation-wide
knob is the settings policy, read at boot from a file or the environment
(`readSettingsPolicy` in `server/src/config.ts`) and applied client-side.
There is no concept of "who administers this installation" anywhere durable.

The product direction wants:

- an administration grant for the accounts that run the installation, stored
  inside Stalwart (architecture law: everything durable lives in Stalwart, no
  own database, disposable container);
- an administration surface inside the product that appears only to granted
  admins (manage settings/privileges, force sign-out, later more);
- standard behaviour for everyone else, unchanged.

Facts from the current machinery:

- The browser never holds credentials. Sign-in Basic-auths to Stalwart through
  the Node server, which keeps a sealed session and proxies every JMAP call
  behind `requireSession` (`server/src/app.ts`, `POST /api/jmap`).
- Sessions live in a server-side store (`server/src/sessions.ts`) that already
  has the primitive `destroyAllForUser` (used by "sign out other sessions" and
  on credential change).
- Any 401 from an API call makes the client stop push and settings sync, clear
  signed-in data and return to the sign-in screen by itself
  (`web/src/jmap/client.ts` `handleUnauthenticated`;
  `web/src/store/session.ts` `onUnauthenticated`).
- The client session object carries `username` plus an `gilbert` extension
  object (`web/src/jmap/types.ts`) — the natural place for an `isAdmin` flag.
- The settings policy is fetched once per page lifetime and cached client-side
  (`web/src/lib/settingsPolicy.ts`); enforced values are re-applied at
  boot/hydrate and on every settings update (`web/src/store/settings.ts`).
- Per-account durable settings live as `settings.json` in the account's own
  JMAP Files (`web/src/lib/settingsSync.ts`).
- JMAP has no cross-account namespace: a system-wide document cannot live in
  every account; it must be owned by one.

## Decision

### 1. The grant is a group mailbox in Stalwart's own directory

Administration is granted by **membership of a dedicated Stalwart group
mailbox** (the "admin group", conventionally `admins@<domain>`), created and
managed by the operator in Stalwart's own administration — the same surface
that creates accounts. Membership **is** the grant: no list document, no
special account identity, no file or environment. Multiple admins come for
free (add whoever to the group); revocation is removing them from the group.

The server learns who is admin from the user's own JMAP session at
sign-in/refresh: among the accounts Stalwart exposes to the authenticated
principal, the presence of the configured admin group (a non-personal
account that only its members can see) means `isAdmin`. The admin group's
name is plain configuration beside `STALWART_URL` (e.g. `ADMIN_GROUP`); it is
not a secret. The admin group also plays the role every system document needs
an owner for: its own JMAP Files host the per-user policy documents
(`user-policies.json`, `profiles.json`, below), and the server holds the
group's credentials as the one bootstrap secret, used only to read and write
those documents — never to decide who is admin.

First-install sequence:

1. The operator creates the group mailbox in Stalwart and adds the first
   admins as members (again: Stalwart's own administration; no Gilbert
   involved yet).
2. Any member signs in to Gilbert; the server sees the admin group among
   their accounts and treats them as admin. The policy documents do not
   exist yet — the normal first-boot state (no user has a policy).
3. From the administration surface the first admin creates the first user
   policy, and can save it as a profile.
4. Membership is managed in Stalwart afterwards; an account is admin while it
   is a member and only while it is. There is no permanent admin-by-identity
   account.

An upgrade of an existing installation needs no migration: upstream gilbert
has no admin concept, so there is no pre-existing grant to move; the operator
creates the group and membership defines admin from then on.

### 2. The server enforces, per request; the client only shows

`isAdmin` is computed server-side from the presence of the admin group in the
principal's session accounts on every relevant request (short-TTL in-memory
cache of the account set), never sealed into the session at sign-in, so a
demotion is effective on the very next privileged request of an already open
session. Admin endpoints get a `requireAdmin` guard beside `requireSession`.
The client receives only `isAdmin: boolean` on the session's `gilbert`
extension (added to the login and `/api/auth/session` responses), which shows
or hides the admin entry point. UI gating is cosmetic; the server is the door.

`/api/config` stays unauthenticated and must never carry who administers the
installation — membership is only ever answered for an authenticated session.

### 3. Propagation semantics

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
- **Forced sign-out ("kick")**: an admin endpoint destroys the target user's
  sessions through the existing session-store primitive. The open client lands
  on the sign-in screen on its next request via the existing
  401 → `handleUnauthenticated` path — immediate on interaction, and for an
  idle background tab within the push reconnect backoff (≤ ~60 s) or on the
  next visibility change. No new client machinery is required in v1.
- Reload or refresh propagates changes; kick terminates sessions. The two
  tools are kept distinct on purpose.

### 4. Per-user policy documents and the administration surface, version 1

The admin group's JMAP Files hold two documents, written by the server on
behalf of the admins:

- `user-policies.json` — per user, the keys of `DEFAULT_SETTINGS` with a
  value and an `enforced` flag;
- `profiles.json` — named snapshots of a user's policy, saved from the
  surface and copyable onto other users (copy-on-apply; no live link).

A user with no entry has no policy: the code's own defaults apply. The
effective per-user policy is delivered to the client **after sign-in** (the
old pre-login, installation-wide file/env policy is removed) and enforced
through the existing door (`update()` re-applies `policyEnforced`). Admin
*membership* is managed in Stalwart's own administration, not here
(adding/removing members needs the Management API — deliberately out of
scope).

## Consequences

- The server gains one secret: the admin group's credentials (an env), used
  only to read and write the group's policy documents — never to decide who
  is admin.
- **Missing** policy documents are the normal first-boot state, not an error:
  no user has a policy until an admin creates one; `profiles.json` starts
  empty.
- A **corrupt** policy document must not refuse boot: the server logs loudly
  and treats it as absent (degraded, visible to admins) until it is repaired
  through the surface.
- Membership changes reach the server within the upstream-session cache
  window; per-user policy changes reach a signed-in user at the next
  session/policy refresh. The container stays disposable.
- Settings remain per-account conveniences, client-enforced; admin *actions*
  are server-enforced. Nothing in this ADR turns settings into a security
  boundary.
- New operational identifiers (the admin-group env name) follow the repo
  naming rule at implementation time; the ADR deliberately does not mint it.

## Alternatives considered

- **A reserved holder account, admin by identity, with an `admin.json` roster
  in its Files**: rejected — it made one account permanently special and the
  first admin a matter of identity rather than of an explicit grant.
- **A per-account flag on `x:AccountSettings`**: rejected — it has no
  free-form field and setting it needs Stalwart-admin rights anyway, so the
  group membership is the same effort with better auditability.
- **Env/file list of admins**: simplest, but a second configuration surface,
  not durable in Stalwart, and it would drift from any in-Stalwart grant.
- **Client-side gating only** (an `isAdmin` flag on the session, no server
  check): rejected; anything a client can assert another client can fake.

## Open questions (recorded, not blocking v1)

- Multi-Stalwart installs (`STALWART_SERVERS_FILE`): is the admin group per
  server (one `admins@<domain>` per Stalwart) or does one nominated server
  hold the policy document for the whole install?
- Managing admin *membership* from Gilbert (rather than from Stalwart's own
  administration) is not reachable over JMAP — it would take the Stalwart
  Management API and a deliberate bend of the "JMAP only" law. Explicitly out
  of scope here; revisit as a separate ADR if an admin v2 needs it.
- Whether the admin group's Files should also host an audit log of admin
  actions later (a natural second document).

## References

- `server/src/app.ts` — `requireSession`, `POST /api/jmap`, sign-out-others
- `server/src/sessions.ts` — sealed sessions, `destroyAllForUser`
- `server/src/config.ts` — `readSettingsPolicy` (file/env boot-read precedent)
- `web/src/jmap/client.ts` — 401 → `handleUnauthenticated`
- `web/src/store/session.ts` — `refresh()`, `onUnauthenticated`
- `web/src/lib/settingsPolicy.ts` — per-page policy cache
- `web/src/store/settings.ts` — `DEFAULT_SETTINGS`, enforcement door
- `web/src/lib/settingsSync.ts` — `settings.json` in the account's Files
- `web/src/jmap/types.ts` — `JmapSession.username`, `gilbert` extension
