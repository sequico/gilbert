# ADR 0001 — Admin group and the administration surface

Status: Accepted (2026-09-07)

> **Scope confirmed by the owner (2026-09-07):**
> administration here means product-level administration only — offered
> **inside Gilbert** as a gated section for users whose admin status is
> granted by membership of the admin group in Stalwart. Membership **is** the
> grant — no account is fixed by Gilbert, multiple admins come from the
> group.
>
> **Multi-domain rule (recorded 2026-09-07, owner):** one admin group per
> Stalwart server. The operator registers `gilbert-admin` once per server (on
> any domain, conventionally the primary), and membership grants admin to
> principals on **every domain that server serves** — the grant must not be
> tied to the domain of a single registration or of the signing-in user.
>
> Shipping order, decided by the owner:
>
> 1. **First** — the administration interface for the **installation-wide
>    settings policy** (upstream's defaults/enforced/changes shape, issue
>    #207). The policy stays on **upstream's own channel** — host file/env
>    read at boot, served by `/api/config` — and the admin edits that same
>    policy from the surface: validate, replace the running copy, publish.
>    No group-owned policy document, no server credential: either would have
>    changed the unauthenticated boot channel upstream defines.
> 2. **Second** — the **per-user settings policy** (values and enforced
>    flags in each user's own hidden folder), named **profiles** (owned by
>    the admin group), and **publishing per user or per group of users**
>    (there is no publish-to-everyone operation). The per-user layer sits on
>    the same mechanism: the per-user document is read after sign-in and
>    pushed through the same client door, and per-user wins over install-wide
>    with a visible marker on administered controls.
> 3. **Security directives** such as forced password change (ADR 0005) are
>    already per-user, live in the target user's own hidden folder, and are
>    enforced by the server per request.
>
> Enforcement stance for settings: the server is the authority that holds and
> validates the policy; the client applies enforced values through the
> existing door. Admin *actions* and security directives are server-enforced;
> ordinary settings remain client-behaviour conveniences.
>
> Stalwart-system administration (accounts, aliases, quotas, directory) is
> out of scope: it is not JMAP-reachable, stays in Stalwart's own tooling,
> and would need a separate decision (Management API) if it ever changes.

## Context

Gilbert's direction is centralized administration of many accounts. The
installation-wide knob is the settings policy, read at boot from a file or
the environment (`readSettingsPolicy` in `server/src/config.ts`) into
`config.settingsPolicy`, served by the unauthenticated `GET /api/config`,
and applied client-side. Until the administration surface exists it is
static deploy configuration, and no account is special.

The product direction wants:

- an administration grant for the accounts that run the installation, stored
  inside Stalwart;
- an administration surface inside the product that appears only to granted
  admins — editing the installation-wide policy, later per-user policies,
  security directives, force sign-out, later more;
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
- The admin group check (`server/src/upstream.ts`: `ADMIN_GROUP_LOCAL`,
  `adminGroupName`, `isAdminSession`) derives the group name from the
  **signing-in user's own domain** and looks for a non-personal account of
  that exact name in the session. That per-user-domain rule only grants
  admins whose own domain hosts the group; the multi-domain rule in this ADR
  replaces it with a per-server local-part match.
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
  replaces `settings.json` on save, so server-owned documents must be
  separate files in the same folder.
- The settings policy is fetched once per page lifetime and cached client-side
  (`web/src/lib/settingsPolicy.ts`); enforced values are re-applied at
  boot/hydrate and on every settings update (`web/src/store/settings.ts`).
  This is upstream code (issue #207).

## Decision

### 1. The grant is one group mailbox per Stalwart server, matching across domains

Administration is granted by **membership of a group mailbox with the
constant local part `gilbert-admin`**, created once per Stalwart server by
the operator in Stalwart's own administration (on any domain — conventionally
the primary one). Membership **is** the grant: no list document, no special
account identity, no secret, no environment.

**The grant is server-scoped, not domain-scoped.** A principal is an admin
when their JMAP session accounts contain **any** non-personal account named
`gilbert-admin@…` — matched by local part, whatever domain the group was
registered on and whatever domain the principal's own address uses. Members
on every domain of the server are admins; revocation is removing them from
the group; adding a member from another domain needs nothing but the
membership.

First-install sequence:

1. The operator creates the group mailbox once per server and adds the first
   admins as members (Stalwart's own administration; no Gilbert involved
   yet), from any domain the server serves.
2. Any member signs in to Gilbert; the server sees the group among their
   accounts and treats them as admin.
3. From the administration surface the first admin edits the installation
   policy or a security directive.
4. Membership is managed in Stalwart afterwards; an account is admin while it
   is a member and only while it is.

The rule rests on the group account appearing in each member's JMAP session
accounts whatever the member's domain (verified against a real 0.16 server at
implementation time with a dated comment, per repo convention).

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

### 3. Admin writes go through impersonation of the document owner

Every privileged write from the administration surface — per-user policy
documents and security directives (§5), admin-owned documents such as named
profiles (§5), anything later — goes through one server-side path: the
server authenticates to Stalwart as the composite `{target}%{<admin>}`,
rebuilding the admin's `Basic` authorization from the sealed session, and
performs ordinary JMAP (FileNode/blob) operations on the target's own hidden
`gilbert` app folder. The target is a **user account** for per-user documents
(ADR 0005) or **the admin group account itself** for admin-owned documents.
No Management API and no second secret: the impersonation right is the write
grant, granted in Stalwart's directory exactly like the membership itself.
Admin-owned documents are only ever read by authenticated admins, so no
pre-sign-in channel and no server credential are involved.

The client never holds the admin's credentials in a form it can use; the
impersonation happens only inside the server, for the duration of the admin
action.

### 4. The installation-wide policy stays on upstream's channel — no document, no credential

The install-wide policy is upstream's `{ defaults, enforced, changes }`,
read at boot from `SETTINGS_POLICY_FILE`/env into `config.settingsPolicy`
and served by `/api/config`. That channel is upstream's and stays exactly as
it is: the boot read is untouched, the file is never forked, and no second
source of truth exists.

The administration surface edits **the same policy**:

- the admin edits the policy text in the surface (§"the editor");
- `POST /api/admin/policy` (behind `requireAdmin`) validates the whole policy
  with the same parser semantics as the boot path (invalid → 400, no crash),
  replaces the running `config.settingsPolicy` — effective immediately, no
  restart — and publishes to signed-in clients (ADR 0004);
- when `SETTINGS_POLICY_FILE` is configured and the file is writable, the
  publish also rewrites it atomically, so a restart of the process keeps the
  change; otherwise the change is runtime state for the life of the process.
  Which of the two a deployment gets is a deployment knob, not a design fork;
  the policy is installation configuration, the acknowledged host-channel
  exception to "everything durable lives in Stalwart" (which governs account
  data).

A group-owned policy document with a server credential was considered and
rejected: it would have changed the unauthenticated boot channel upstream
defines (`/api/config` answering from a Stalwart document read with a
service credential) and added a server identity upstream does not have —
maintenance conflict on the very file this feature must not fork.

### 5. Per-user and admin-owned documents live in hidden app folders

The per-user layer (v2 of the shipping order) uses the same mechanism, one
level down. Per-user documents are separate files inside the **target
account's** hidden `gilbert` app folder, beside `settings.json`:

- per-user settings policy (values + `enforced` flags);
- security directives (ADR 0005: the forced-password-change marker), read
  and enforced by the server, not by the client — already implemented.

**Admin-owned** documents — named **profiles** for per-user settings — live
in the admin group account's hidden folder, written and read by admins
through impersonation of the group (§3). They are only ever accessed by
authenticated admins.

A user with no per-user policy document has none: the install-wide policy
applies. A missing document is the normal first-boot state, not an error.

Delivery to the client: the effective per-user policy is read from the
user's own folder **after sign-in**, merged over the install-wide policy
(per-user wins), and enforced through the existing door (`update()`
re-applies `policyEnforced`). Controls the per-user policy administers carry
a visible marker and go dead when `enforced`, like the install-wide ones.

### 6. Enforcement model

Settings enforcement is the existing upstream door: the server is the
authoritative holder and distributor of the policy (`/api/config` now serves
the running copy), and the client applies `enforced` values on every load
and every update. That door protects enforced keys from the user's own UI,
imports and mistakes — it is not a boundary against a hostile client (soft
enforcement, as recorded below). Security directives are the server-enforced
exception, because they gate access rather than guide behaviour.

### 7. Propagation semantics

- **Privilege change**: enforcement is immediate at the next privileged
  request, judged against the principal's account set as Stalwart last
  reported it (the server caches the upstream session for a few minutes, so
  a revocation lands within that window). Visible UI follows at the next
  session refresh (`GET /api/auth/session?refresh=1`, exposed as
  `session.refresh()` in `web/src/store/session.ts`), triggered on window
  focus and after a membership change.
- **Install-wide policy change (v1)**: the admin publishes (ADR 0004) — the
  running copy is replaced, optionally the file is rewritten, and signed-in
  sessions are kicked so the next sign-in applies the new policy at boot.
  Reload and refresh alone also pick the change up at the next policy fetch.
- **Per-user policy change (v2)**: reaches the affected signed-in user at the
  next session/policy refresh; publishing may kick only the affected accounts
  once the document lives in the user's own folder.
- **Security directives**: read by the server per request (short-TTL cache)
  and enforced by the proxy, as in ADR 0005 — a forced user is stopped at
  their next request whether or not their client cooperates.
- **Forced sign-out ("kick")**: an admin endpoint destroys the target user's
  sessions through the existing session-store primitive. The open client
  lands on the sign-in screen on its next request via the existing
  401 → `handleUnauthenticated` path — immediate on interaction, and for an
  idle background tab within the push reconnect backoff (≤ ~60 s) or on the
  next visibility change. No new client machinery is required.
- Reload or refresh propagates changes; kick terminates sessions. The two
  tools are kept distinct on purpose.

## Consequences

- The grant has one shape per server and works across every domain the server
  serves: multi-domain installations need one group, not one per domain.
- The install-wide policy keeps upstream's exact channel; the surface only
  adds a write path to the policy the server already serves. Upstream merges
  touching `config.ts` or the client policy code stay cheap.
- Publishing replaces the running policy immediately; persistence across a
  restart depends on the deployment giving the server a writable policy file
  (a deployment knob, not a design fork).
- **Soft enforcement is the standing stance for settings.** The hidden folder
  is hidden from the Files UI but is not a security boundary: the account
  owner can write it with any JMAP client, so a determined user can alter
  their own per-user policy or directive. Doing so means acting outside the
  product, deliberately, and directives carry `setAt`/`setBy`, so removal is
  detectable by an admin. Absolute enforcement of settings is only possible
  inside Stalwart itself; the door protects enforced keys from ordinary use.
- A **corrupt** policy or directive document must not refuse boot or
  sign-in: the server logs loudly and treats it as absent (degraded, visible
  to admins) until it is repaired through the surface.
- Admin *actions* and security directives are server-enforced; settings
  remain per-account conveniences, client-enforced. The hidden folder is a
  data location, never a security boundary.

## Alternatives considered

- **A reserved holder account, admin by identity, with an `admin.json` roster
  in its Files**: rejected — it made one account permanently special and the
  first admin a matter of identity rather than of an explicit grant.
- **Admin grant as an env list of usernames**: rejected — a second
  configuration surface that drifts from the in-Stalwart grant, and it would
  need reworking of the shipped directive guard.
- **One admin group per domain** (the per-user-domain rule): rejected by the
  owner on 2026-09-07 — multi-domain servers must grant from a single
  registration across all their domains.
- **Install-wide policy as a group-owned Stalwart document, read with a
  server credential**: rejected by the owner on 2026-09-07 — it changes the
  unauthenticated boot channel upstream defines and adds a server identity
  upstream does not have; the policy stays on upstream's host channel (§4).
- **Per-user documents in the admin group's Files**: rejected for **per-user**
  documents — they belong to the user they describe. The group *does* own
  admin-only documents such as profiles (§5): the two classes do not share a
  home.
- **Copying the install-wide policy into every account**: rejected — no
  publish-to-everyone operation exists; the install-wide policy applies to
  everyone by definition and per-user overrides are published per user or per
  group (§5).
- **A per-account flag on `x:AccountSettings`**: rejected — it has no
  free-form field and setting it needs Stalwart-admin rights anyway, so the
  group membership is the same effort with better auditability.
- **Proxy interception of per-account settings writes** (rejecting
  non-conforming `settings.json` writes from a hostile client): deferred —
  fragile against the JMAP sync mechanics upstream ships, and only meaningful
  against a client that already bypasses the product. Revisit if the threat
  model demands it.
- **Client-side gating only** (an `isAdmin` flag on the session, no server
  check): rejected; anything a client can assert another client can fake.

## Open questions (recorded, not blocking)

- **Group-in-session facts against a real 0.16 server** (verified at
  implementation time with a dated comment, per repo convention): a member's
  JMAP session exposes the group account whatever the member's domain; only
  members see it; a member can impersonate the group account (for the
  admin-owned documents of §5).
- **Roles and principal attributes as the grant (checked 2026-09-07, source
  v0.16.21):** `roles` and the directory attributes are managed through
  Stalwart's own administration (webadmin / Management API) and are not
  exposed over JMAP — no role appears on the JMAP session, the principal
  object or the ACL path in the 0.16.21 source. Display fields such as
  `description` are JMAP-visible but public to directory queries, carry real
  display meaning, and are untyped — rejected as flag carriers. Group
  membership remains the only operator-managed, non-forgeable grant that
  materializes in the member's JMAP session. Revisit if a Stalwart version
  exposes typed principal attributes over JMAP.
- Multi-Stalwart installs (`STALWART_SERVERS_FILE`): impersonation targets a
  principal on a given Stalwart — one group per server, and an admin on one
  server administers the accounts that server serves.
- Managing admin *membership* or the impersonation *right* from Gilbert
  (rather than from Stalwart's own administration) is not reachable over
  JMAP — it would take the Stalwart Management API and a deliberate bend of
  the "JMAP only" law. Explicitly out of scope here; revisit as a separate
  ADR if an admin v2 needs it.
- Whether the documents should also feed an audit log of admin actions later
  (a natural second use of the `setAt`/`setBy` fields).

## References

- `server/src/app.ts` — `requireSession`, `/api/jmap`, sign-out-others
- `server/src/sessions.ts` — sealed `{username, password}`, `destroyAllForUser`
- `server/src/upstream.ts` — `isAdminSession`, `ADMIN_GROUP_LOCAL`,
  `adminGroupName` (per-user-domain derivation the multi-domain rule
  replaces), upstream session fetch
- `server/src/config.ts` — `readSettingsPolicy` (host channel, shape and
  validation the editor shares)
- `web/src/jmap/client.ts` — 401 → `handleUnauthenticated`
- `web/src/store/session.ts` — `refresh()`, `onUnauthenticated`
- `web/src/lib/settingsPolicy.ts` — per-page policy cache
- `web/src/store/settings.ts` — `DEFAULT_SETTINGS`, enforcement door
- `web/src/lib/appFolder.ts` — the hidden `gilbert` app folder
- `web/src/store/files.ts` — the Files view's hidden-folder filter
- `web/src/jmap/types.ts` — `JmapSession.username`, `gilbert` extension
- ADR 0004 — publish and kick (how rule changes reach signed-in clients)
- ADR 0005 — forced password change (first per-user security directive)
