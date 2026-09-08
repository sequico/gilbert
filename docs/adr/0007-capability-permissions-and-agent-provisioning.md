# ADR 0007 — Capability-based permissions and agent provisioning via the Stalwart Management API

Status: Proposed (2026-09-08)

> Decided in a working session on 2026-09-08 (owner direction): the
> `gilbert-admin` group grant of ADR 0001 is to be removed. In its place,
> Gilbert reads real Stalwart-native permissions/attributes on the signed-in
> principal, through a new scoped service credential against Stalwart's
> Management API. The same credential provisions **agent principals**
> (ADR 0003) — the piece ADR 0003 explicitly left out of scope
> ("Grant management stays in Stalwart's directory... deliberately out of
> scope"). This ADR is the separate decision ADR 0001 and ADR 0003 both
> said would be needed before crossing that boundary.

## Context

Two open threads converge here:

- **ADR 0001** grants Gilbert product-administration by membership of a
  group mailbox (`gilbert-admin`), specifically *because* Stalwart's own
  roles and principal attributes are not exposed over JMAP (confirmed
  2026-09-07 against source v0.16.21) — group membership was "the only
  operator-managed, non-forgeable grant that materializes in the member's
  JMAP session." The ADR's own open questions flagged this as worth
  revisiting "if a Stalwart version exposes typed principal attributes over
  JMAP."
- **ADR 0003** defines Gilbert's agents as Stalwart principals with their
  own address, whose scope is "exactly its grants" (ACLs on the resources
  they act on) — but defers *how an agent principal gets created and
  granted* as "Management API territory, not JMAP — deliberately out of
  scope."

The owner does not want to wait for JMAP to expose roles (it may never do
so — the field is a webadmin/Management-API concept in Stalwart's design,
not a JMAP one) and does not want a Gilbert-invented group standing in for
a real permission model. Both threads need the same missing piece: a way
for the Gilbert server to talk to Stalwart's Management API on its own
authority, not only by rebuilding a signed-in human's Basic auth.

Facts carried over from ADR 0001/0003, unchanged by this decision:

- Architecture law: everything durable lives in Stalwart; no Gilbert-side
  database; the container stays disposable.
- Impersonation (`{target}%{admin}`) remains the write grant for per-user
  documents (forced-password directive, per-user policy) and is tested by
  attempted action, never by reading an attribute — Stalwart does not
  expose it as a readable flag either. This ADR does not change that
  mechanism.
- Per-resource ACL rights (`myRights`/`shareWith` on Mailbox, Calendar,
  AddressBook, FileNode) are already JMAP-native and require no new
  integration — sharing a resource with an agent principal uses the same
  `<Type>/set` call the existing `ShareDialog` uses for user-to-user
  sharing.
- Stalwart's REST Management API (`/api/*`, separate from `/jmap`) exists
  for exactly this class of operation; a subset of it (auth, account
  introspection, schema, telemetry) is confirmed via the published OpenAPI
  contract. The full extent of what it exposes for principal creation and
  principal permissions/attributes was **not verified live** while drafting
  this ADR — see Open questions.

## Decision

### 1. The Management API client: credential, transport, and calls

This section is the full Mossa 2 implementation: not just the decision to
use a service credential, but its shape end to end.

**1a. Credential.** One Stalwart **API Key principal** per configured
Stalwart server. `STALWART_SERVERS_FILE` already keys Gilbert's config per
server (multi-Stalwart installs); the management credential follows the
same keying — each server entry gains a `managementApiKey: { name: string;
secret: string }` field, read at boot exactly where the rest of that
server's config is read (`server/src/config.ts`). Created once by the
operator directly in Stalwart (webadmin/Management API/CLI — Gilbert never
creates its own service credential), scoped — if Stalwart's API Key
principal type supports scoping, to be confirmed live — to exactly: read a
principal's attributes, list/read principals, create a principal. Nothing
broader is requested: no mail read, no impersonation, no settings write.
It is a provisioning-and-introspection identity only, never a way to read
or write user content, and never sent to the browser.

This is the one new element the "no second secret" stance of ADR 0001 §4
was written against for the *install-wide policy channel* specifically; it
does not apply here unchanged, because that stance was about not forking
upstream's unauthenticated boot channel. A scoped Management-API service
credential, used only from the trusted server process for authenticated,
audited admin actions, is a different risk shape — but it is a **new**
standing secret, and is treated as the main new attack surface this ADR
introduces (see Consequences).

**1b. Transport — `server/src/management.ts` (new).** A thin client
parallel to `upstream.ts`/`account.ts`, not reusing their JMAP request
shape (this is REST, not JMAP batch calls):

- `managementRequest(server, path, method, body?)` — issues the HTTP call
  against `<stalwart-base>/api/<path>` with `Authorization: Basic
  <base64(name:secret)>` built from that server's configured
  `managementApiKey`. Basic is chosen over the OpenAPI-documented
  Bearer/`POST /auth/token` flow deliberately: a long-lived service
  identity has no user session to refresh a token against, so Basic per
  call is simpler and matches how every other upstream call in this
  codebase already authenticates (`account.ts`'s `jmap()`, `upstream.ts`).
  Same `AbortSignal.timeout(config.upstreamTimeout)` as those calls.
- `ManagementError extends Error` (mirrors `UpstreamError`/`AccountError`):
  401/403 → the service credential is invalid, revoked, or under-scoped
  for the call attempted; 404 → principal not found; other non-2xx →
  wrapped with Stalwart's `description`/`type` when present, same
  presentation `describeSetError` already gives JMAP `/set` failures.
- `getPrincipalCapabilities(server, name): Promise<Set<string>>` — the
  attribute/permission read behind §2's `gilbert.*` booleans. Response
  parsing (which JSON fields carry the permission set) is the piece marked
  in Open questions; the function's contract (name in, capability set out,
  throws `ManagementError` on failure) is fixed regardless of that detail.
- `createAgentPrincipal(server, { name, description }): Promise<{ id: string }>`
  — the call behind §3's agent provisioning. Same contract-now,
  wire-shape-later split as above.

**1c. Capability resolution.** `requireCapability(name)`
(`server/src/permissions.ts`, new) calls `getPrincipalCapabilities`, maps
the result onto the five `gilbert.*` names in §2, and caches it per
principal for the same short TTL the upstream session cache already uses
(a few minutes — ADR 0001 §7's precedent), so a revoked capability lands
within that window, matching the existing privilege-change propagation
contract rather than inventing a new one.

**1d. Failure mode.** Any failure talking to the Management API —
timeout, 401 on the service credential itself, a malformed response —
resolves every `gilbert.*` capability to `false` for that request and logs
loudly server-side. This is the "fails closed" behaviour named in
Consequences: a broken service credential takes away admin access, it
never grants it, and it never crashes the request — the rest of Gilbert
(mail, calendar, files) is unaffected by a dead Management API.

**1e. Config.** The new `managementApiKey` field is optional per server
entry. A deployment that omits it has no `gilbert.*` capability ever
resolve true and therefore no admin surface — a valid, bootable
configuration, not an error, mirroring "a missing per-user policy document
is the normal first-boot state, not an error" (ADR 0001 §5). No crash at
boot; a loud, one-time log line naming which servers are missing it.

**1f. Mock parity.** `server/src/mock/index.ts` gains `/api/*` handlers
for `getPrincipalCapabilities` and `createAgentPrincipal` (auth check,
principal get/create with the capability-bearing fields), so
`npm run dev:mock` and the test suite exercise §2/§3 without a live 0.16.x
server — the same discipline the repo already applies to JMAP mock
routes, extended to this REST surface.

### 2. The `gilbert-admin` group grant is removed; capabilities replace it

`isAdminSession()` (JMAP session inspection of `session.accounts`) is
removed. In its place, `server/src/permissions.ts` (new) resolves a small,
named set of **capabilities** for the signed-in principal by querying the
Management API with the service credential:

- `gilbert.admin.surface` — see/enter the admin panel (replaces the shield
  gate)
- `gilbert.policy.write` — edit the install-wide settings policy
- `gilbert.users.administer` — the Users panel; force-password-change
  (impersonation is still probed per action, unchanged)
- `gilbert.agents.manage` — create/configure agent principals and their
  resource grants

Each maps to a real Stalwart-native permission/attribute on the principal,
set by the operator directly in Stalwart (webadmin/Management API/CLI) —
the same one-time, per-admin effort as adding someone to a group today,
but granular instead of all-or-nothing. `requireAdmin` becomes
`requireCapability(name)`, applied per endpoint instead of one blanket
gate. The client still receives only booleans (now one per capability, on
`session.gilbert`), computed server-side per request with the same
short-TTL cache ADR 0001 already uses — enforcement stays server-side,
UI gating stays cosmetic, exactly as ADR 0001 §2 established; only the
*source* of the boolean changes, from JMAP session accounts to a
Management-API principal lookup.

### 3. Agent principals are provisioned through the same credential

`POST /api/admin/agents` (new, gated by `gilbert.agents.manage`) uses the
service credential to create an agent principal (e.g. `agent1@…`) in
Stalwart's directory — the step ADR 0003 §1 left as an operator's manual
task. After creation, granting the agent access to specific resources (a
group mailbox, a Files folder, a calendar) is ordinary JMAP: the admin
shares the resource with the new principal via the existing `<Type>/set` +
`shareWith` path (`ShareDialog`), the same mechanism a user already uses to
share with a colleague. No group membership is created for the agent — its
scope is exactly its ACL grants, as ADR 0003 intended.

### 4. Admin-owned documents move out of the group account

Profiles and other admin-owned documents (ADR 0001 §5) move from
`gilbert-admin`'s own Files to the service principal's own Files, if the
API Key principal type carries a usable Files account; otherwise to one
small dedicated storage-only principal created once by the operator (never
used as a gate — its existence is an implementation detail, not a
permission check). Which of the two depends on the Open question below.

### 5. Migration

1. Ship capability resolution and `requireCapability` behind the existing
   `gilbert-admin` check as a fallback (both paths active, capability
   wins when present) so existing installations are not locked out.
2. Operators set the new capability attributes on today's `gilbert-admin`
   members.
3. Once verified, remove `isAdminSession()`, the group-membership check,
   and the group's role as document owner. The group mailbox itself may be
   deleted by the operator in Stalwart or repurposed; Gilbert no longer
   looks for it.

## Consequences

- Admin permissions in Gilbert become granular (per capability) instead of
  a single on/off grant — a principal can manage agents without being able
  to edit the install-wide policy, which was not expressible before.
- The identity/gate mechanism now depends on a new standing secret (the
  API Key principal) held by the Gilbert server. It must be rotated like
  any service credential, scoped to only the operations in §1, and never
  reused as a general-purpose admin bypass. This is a materially different
  risk profile from "no second secret" and is the main trade-off of this
  ADR versus ADR 0001's original stance — accepted here because it is the
  only way to reach real Stalwart attributes and to provision agent
  principals at all.
- Agent provisioning stops being a manual, operator-only step for new
  agents; `gilbert.agents.manage` holders can create agent principals from
  the product itself.
- Impersonation-based writes (forced password change, per-user policy
  documents) are unchanged in mechanism and in how they are tested (probed
  per action, never read as an attribute).
- `server/src/mock/index.ts` needs a Management API surface added (auth,
  principal get/create, attribute read) to keep the test/dev parity the
  repo already requires for JMAP behaviour.
- Losing or misconfiguring the service credential fails the admin surface
  closed (no capability resolves), not open — same fail-safe direction as
  today's directory-query degradation in the Users panel.

## Alternatives considered

- **Keep the `gilbert-admin` group as the sole gate, layer capabilities as
  Gilbert-side flags on top of it**: rejected — reintroduces exactly the
  "second configuration surface that drifts from the in-Stalwart grant"
  ADR 0001 already rejected for an env-list of usernames; capabilities
  must live where the group lived, in Stalwart's own directory, or they
  are not real grants.
- **Use the impersonation-right probe as the sole identity signal (no
  service credential at all)**: rejected — impersonation is coarse
  (all-or-nothing per target account), requires picking a real target
  principal to probe against (undefined with zero other accounts), costs a
  live round-trip per check instead of a cached read, and does not cover
  principal creation at all — it answers "can I act as this one other
  account," never "can I create a new one."
- **No service credential; keep provisioning entirely manual (Mossa 1
  only)**: viable and cheaper, but does not satisfy the explicit goal of
  removing the group as a hand-managed convention and self-serving agent
  creation from the product; recorded as the fallback if the Management
  API's principal-creation surface turns out not to be a stable contract
  (see Open questions).

## Open questions (recorded, not blocking a v1 design pass)

- **Exact shape of the Management API for principal attributes/permissions
  and principal creation** — not verified live while drafting this ADR;
  the published OpenAPI contract fetched during discussion showed only
  auth/account-introspection/schema/telemetry paths, not `/api/principal`.
  Verify against a real 0.16.x server (source + live check, dated comment,
  per repo convention) before implementation; this determines whether §2
  and §3 are a normal REST integration or require dealing with a less
  stable, less publicly documented surface.
- **Whether an API Key principal has its own Files/account** usable for
  §4's document storage, or whether a separate storage-only principal is
  needed.
- **Naming and enumeration of the Gilbert capability set** — the five
  named in §2/§3 cover today's admin surface; growing the admin surface
  (e.g. a future policy-per-group feature) means adding capabilities here,
  not reviving a coarse admin flag.
- Multi-Stalwart installs: keying resolved in §1a (one `managementApiKey`
  per `STALWART_SERVERS_FILE` entry); what remains open is only whether
  Stalwart's API Key principal type can be scoped to the principals of one
  server in a multi-tenant Stalwart deployment, or whether it is
  inherently server-wide.
- Whether removing `gilbert-admin` entirely (vs. leaving it inert) has any
  effect on the group-chat mechanism of ADR 0006, which explicitly
  excludes the admin group from "working group" detection by name — once
  the group is gone this exclusion becomes moot, not a migration risk.

## References

- ADR 0001 — admin group and administration surface (the grant mechanism
  this ADR replaces)
- ADR 0003 — agent worker fleet (the provisioning gap this ADR closes)
- ADR 0006 — group chat (admin-group exclusion, becomes moot once the
  group is removed)
- `server/src/upstream.ts` — `isAdminSession`, `ADMIN_GROUP_LOCAL` (to be
  removed)
- `server/src/app.ts` — `requireAdmin`, `/admin/force-password-change`,
  `/admin/users` (to be regated on `requireCapability`)
- `server/src/account.ts`, `server/src/upstream.ts` — the Basic-auth
  request/error-mapping pattern `management.ts` (§1b, new) follows
- `server/src/config.ts` — `STALWART_SERVERS_FILE` reading, extended with
  `managementApiKey` per server (§1a, new)
- `web/src/views/settings/ShareDialog.tsx` — the existing `shareWith`
  JMAP write, reused unchanged for agent resource grants
