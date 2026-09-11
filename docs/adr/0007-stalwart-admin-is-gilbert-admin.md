# ADR 0007 — Stalwart admin is the Gilbert admin (the `gilbert-admin` group is removed)

Status: Accepted (2026-09-09)

> Owner direction (2026-09-09): keep it simple. A signed-in user who is a
> Stalwart admin becomes a Gilbert admin — the shield and every admin
> function, no exceptions. There is no `gilbert-admin` group, no `gilbert-*`
> capability groups, and no Gilbert-side capability registry. Per-user writes
> such as force-password additionally require the `Impersonate` permission,
> which the operator grants on the Stalwart side by hand.

## Context

ADR 0001 granted product administration by membership of the `gilbert-admin`
group mailbox, because Stalwart's own roles and principal attributes are not
exposed over JMAP. This decision removes that group grant and makes "Stalwart
admin" the single source of truth for Gilbert admin.

Source verification (2026-09-09, Stalwart v0.16.21) pins the runtime facts
this decision rests on:

- JMAP exposes no role or principal attribute: `Principal/get` returns only
  Id, Type (Individual/Group), Name, Description, Email and capabilities
  (`crates/jmap/src/principal/get.rs`).
- The REST Management API (`/api/*`) is auth, calendar/rsvp, discover,
  account, schema, token/{delivery,tracing,metrics} and live/{…} only — no
  principal endpoints and no read of another principal's attributes
  (`crates/http/src/api/mod.rs`).
- SCIM (`/scim/v2/Users|Groups`) is the provisioning surface (bearer auth,
  `ScimAccess` + `SysAccount*`), but it renders and writes only profile,
  active and groups — never roles or permissions (`crates/scim/src/users/*`).
- The native role model exists (`UserRoles = User | Admin | Custom(role_ids)`,
  plus a per-method `Permission` enum), but it lives on the config side. The
  one runtime self-read is `/api/account`, which returns the *authenticated
  account's own* resolved permission list (and edition and locale), not the
  role name (`crates/http/src/auth/permissions.rs`).

So "is Stalwart admin" has no JMAP-visible boolean; the non-forgeable runtime
signal is the user's own permission set, read by self-introspection at
sign-in.

## Decision

1. **Gilbert admin equals Stalwart admin.** During sign-in the Gilbert server
   calls Stalwart's `/api/account` with the user's in-flight credentials — one
   extra self-introspection call, no stored secret, no service credential.
   Admin-ness is resolved from the returned permission list: the recovery
   admin (`RECOVERY_ADMIN_ID`, an all-permissions token) and any principal
   whose permissions carry the configured admin marker (default
   `sysAccountCreate`, live-verified 2026-09-09) are Stalwart admins and
   become Gilbert admins (shield + every admin function). There is no
   `gilbert-*` group and no Gilbert-side registry to forge.
2. **Per-user writes need `Impersonate`, not just admin.** Force-password and
   the other per-user documents keep the existing per-action impersonation
   probe: an admin must hold Stalwart's `Impersonate` permission, which the
   operator grants on the Stalwart side. Admin without `Impersonate` can
   administer the install but cannot act as another user.
3. **Agents: granting is JMAP, creation stays Stalwart-side.** An admin grants
   an agent access to resources through the existing JMAP `shareWith`
   (`ShareDialog`), unchanged from ADR 0003. Creating the agent principal is
   not possible over JMAP (no principal-creation method) and SCIM would need a
   service credential; in this decision it stays a manual Stalwart-side step
   by the operator, exactly like `Impersonate`. In-product agent creation, if
   ever wanted, is a separate decision (a SCIM service credential).
4. **No Management API service credential.** The only Management-API touch is
   the `/api/account` self-introspection using the user's own credentials.
   There is no `managementApiKey`, no SCIM client, no `server/src/management.ts`.
5. **Migration.** The replacement landed in one change: `isAdminSession`,
   `ADMIN_GROUP_LOCAL` and the group's role are gone from code, and the
   operator may now delete or repurpose the `gilbert-admin` mailbox. Nothing
   else moves: the install-wide policy is a config file
   (`SETTINGS_POLICY_FILE`), the forced-password directive lives in each
   user's own Files (ADR 0005), and ADR 0001 §5's admin-owned "profiles" were
   never implemented — the group holds no documents to relocate.

## Removal list

The group grant left gates in three layers. Removing them is part of this
decision; nothing below is behaviour to preserve.

### Server (`server/src`)

- `upstream.ts`: delete `ADMIN_GROUP_LOCAL` and `isAdminSession()` — the
  grant they encoded is gone; admin is resolved by the `/api/account`
  introspection instead.
- `upstream.ts`: in `hasChatGroupAccounts()` drop the `!== ADMIN_GROUP_LOCAL`
  clause — with no admin group, any non-personal account counts for the chat
  push rail.
- `app.ts`: repoint `requireAdmin` from `isAdminSession` to the new admin
  check; the 403 copy "This needs membership of the gilbert-admin@… group"
  goes away with it.
- `app.ts`: `sessionExtras(…, isAdminSession(upstream), …)` — the `isAdmin`
  flag now comes from the introspection, not the session accounts.
- `app.ts` (force-password): drop the `target === ADMIN_GROUP_LOCAL` guard
  ("The admin group is not an account to force") — the group no longer
  exists. The `target_is_admin` guard stays, but detects admin by the new
  check, not by group membership.
- `mock/index.ts`: drop the admin-group emulation — `ADMIN_GROUP_NAME`,
  `HAS_ADMIN_GROUP`, `MOCK_ADMIN_GROUP`, `MOCK_NO_ADMIN_GROUP`, the
  `gilbert-admin@…` account injected into the session accounts, and the
  "membership of the admin group" impersonation right. The mock instead
  answers the new `/api/account` introspection and treats the demo user as an
  admin when it holds the marker permission (`MOCK_ADMIN=1`), with
  `MOCK_TARGET_IS_ADMIN` kept as the "target holds the marker" case.

### Web (`web/src`)

- `lib/mailAccounts.ts`: delete `isAdminGroupAccountName()`; drop the
  `gilbert-admin` exclusions in `mailAccountCandidates()` and
  `groupMailboxAccounts()` — an account named `gilbert-admin@…`, if an
  operator ever has one, is just another group mailbox now.
- `jmap/types.ts`: the `isAdmin` field stays, but its comment no longer names
  the group — it reports the Stalwart-admin state resolved at sign-in.
- `views/AppShell.tsx` and `views/AdminView.tsx`: the shield and the
  administration panel stay; only their doc copy stops naming the group.
- No locale-catalog change: the only `gilbert-admin` strings are server-side
  error messages and code comments, not `t()` keys.

### Tests

- `admin-nonadmin.test.ts`, `admin.test.ts`, `admin-force-guard.test.ts`,
  `admin-policy.test.ts`, `admin-users.test.ts`,
  `forced-password-admin-guard.test.ts`, `groups.test.ts`,
  `mock/impersonation.test.ts`, `web/src/lib/__tests__/mailAccounts.test.ts`
  and `web/src/lib/__tests__/chat.test.ts`: rewrite against the new model
  (admin by marker permission, no group in the session accounts, no
  `gilbert-admin` exclusion).
- New coverage: `/api/account` introspection, marker-permission resolution
  (admin and non-admin, and an empty or missing list resolving to non-admin),
  and mock parity for all of the above.

## Consequences

- The admin grant is the operator's Stalwart role/permission configuration —
  a single, non-forgeable source of truth in Stalwart, with no second
  Gilbert-side surface to drift out of sync.
- Admin state for the client (shield, admin panel) is a server-computed
  boolean from the sign-in introspection; enforcement stays server-side and
  UI gating stays cosmetic, as in ADR 0001 §2. Only the *source* changes.
- Fails closed: if `/api/account` is unreachable or the marker is absent, the
  user resolves to non-admin; no privilege is ever inferred.
- Self-introspection leaks nothing beyond what the user already is, and no
  credential is stored on the Gilbert side.
- Granular `gilbert.*` capabilities do not exist in this decision — admin is a
  single grant. If granularity is ever wanted, it is a new ADR.
- Agent creation remains an operator task; the product gains no SCIM
  dependency.

## Alternatives considered

- **Management-API service credential + granular capabilities**: rejected —
  the read surface does not exist in Stalwart 0.16.x (source-verified
  2026-09-09).
- **One capability group per grant**: rejected — the owner wants no
  `gilbert-*` groups at all.
- **Gilbert-side capability registry**: rejected — forgeable by its writers
  unless signed with a server secret, which is complexity the owner asked to
  drop.

## Verification (live 2026-09-09)

Against a real instance (community edition, 0.16.x), Basic auth to
`/api/account` returns `{ edition, locale, permissions }`. The admin marker is
**`sysAccountCreate`**, confirmed on both sides of the boundary: a
`gilbert-admin` group member holds 244 user permissions with no
`sysAccountCreate`, `impersonate` or `scimAccess`; after the operator set the
admin role on the same principal, the list grew to 642 permissions and
`sysAccountCreate` (plus `impersonate` and `scimAccess`) appeared. The admin
role therefore bundles `impersonate` — a Stalwart admin can force a password
with no extra grant — while a non-admin could still be given `impersonate`
alone. `sysBootstrap*` never appears (the endpoint always strips it), so it
is not a usable marker.

The implementation is covered by the mock suite (admin by marker, non-admin
resolution, the refuse-to-force-another-admin guard). Live, against the same
server, an app password authenticates to `/api/account` exactly like a
password (verified 2026-09-09), so a session re-sealed onto an app password
by the 2FA switch-over still introspects as itself. The operator runs the
final sign-in-through-the-server confirmation on the deployment.

## References

- ADR 0001 — admin group grant (superseded by this decision)
- ADR 0003 — agent worker fleet (creation stays operator-side)
- ADR 0005 — forced password change (the per-action impersonation probe)
- ADR 0006 — group chat (admin-group exclusion, moot once the group is gone)
- `server/src/upstream.ts` — `isAdminSession`, `ADMIN_GROUP_LOCAL` (removed in this change)
- `server/src/app.ts` — `requireAdmin`, `/admin/*` (re-gated on the new admin check)
- `server/src/account.ts`, `server/src/app.ts` — sign-in; where the `/api/account` introspection plugs in
- `server/src/config.ts` — `GILBERT_ADMIN_PERMISSION` marker
- `server/src/mock/index.ts` — admin-group emulation (replaced by the permission model)
