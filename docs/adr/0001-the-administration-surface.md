# ADR 0001 — Administration

Gilbert admin is Stalwart admin. There is no `gilbert-*` capability group, no
admin mailbox and no Gilbert-side registry: a principal is a Gilbert
administrator exactly when Stalwart says so, and administration is granted in
exactly one place — Stalwart's own user administration.

## The admin grant

Stalwart exposes no JMAP-visible admin boolean: `Principal/get` carries no
role and no permission, and the REST Management API has no principal read.
The one runtime signal is a principal's own permission list, read by
self-introspection: the server calls `/api/account` with the user's in-flight
credentials and treats the principal as an administrator when the list
carries a configured marker (`GILBERT_ADMIN_PERMISSION`, default
`sysAccountCreate`) — one extra call, no stored secret, no service credential
(`isStalwartAdmin` in `server/src/upstream.ts`).

Every admin route sits behind `requireAdmin`, which repeats this check
freshly on every privileged call — admin-ness is never sealed into the
session at sign-in, so a demotion in Stalwart lands on the next privileged
call of an already open session. The client only ever receives `isAdmin:
boolean` on the session's `gilbert` extension; that flag shows or hides the
admin entry point and nothing more — the server is the door, the client is
cosmetic.

First-install sequence: an operator grants the Stalwart admin role to the
first administrator in Stalwart's own administration; that administrator
signs in to Gilbert and the server introspects and recognizes them;
administration from then on is managed in Stalwart, never in Gilbert.

## The write door: impersonation

Every privileged write the administration makes into an account it does not
own — a person's settings, identity or security directive — goes through one
path: the server authenticates to Stalwart as the composite
`{target}%{<admin>}`, rebuilding the admin's `Basic` authorization from the
sealed session, and performs ordinary JMAP operations on the target's own
Files. The target is always a user account; Stalwart refuses to impersonate a
group mailbox (403), so a group's own documents are reached as the
installation's agent instead (ADR 0003), never by impersonating the group.

Impersonation needs Stalwart's `impersonate` permission, bundled into the
admin role; an operator can also hand a non-admin principal `impersonate`
alone, buying the write path and nothing else. App passwords are refused for
impersonation. The client never holds an admin's credentials in a form it can
use — impersonation happens only inside the server, for the duration of the
action.

## Per-account server documents

Two facts an administrator sets about an account — the installation policy it
follows, and whether its identity is locked — live the same way: a dedicated
file in the account's own hidden `gilbert` app folder, written by
impersonation, separate from `settings.json`. That separation matters because
the client whole-file-replaces `settings.json` on every save: a server-only
fact kept as a key inside it would be silently dropped by the next client
save.

- **Installation policy** (`installation-policy.json`): the `{ defaults,
  enforced, changes }` document that shapes a user's settings. `POST
  /admin/policy` enumerates Stalwart's directory of individual principals and
  writes the policy into every one's app folder by impersonation, the
  publishing administrator's own account included. One account's refusal —
  no impersonation grant, an unreachable session, no Files account — does not
  stop the rest; the response names how many accounts were reached. A
  reader's own policy is read from their own account: `GET
  /api/account/policy` answers with the signed-in account's own file, and
  `GET /admin/policy` (the editor's own display) reads the same file from the
  signed-in administrator's account, which the last publish already wrote —
  one document, not two stores to keep in step.

  An account the directory did not yet list at the last publish carries no
  file yet and falls back to a bootstrap policy read once at boot from the
  environment (`SETTINGS_DEFAULTS`, `SETTINGS_ENFORCED`, `SETTINGS_CHANGES`)
  — the same bootstrap every account reads before any administrator has
  published anything. Nothing here touches local disk, so this surface runs
  under `IMMUTABLE=1` like the rest of the product: everything Gilbert owns is
  a document in Stalwart.

- **Identity lock** (`identity-lock.json`): present means the account's
  identity is locked, missing means it is not — set or released through the
  same impersonation door (ADR 0007). A session's own
  `gilbert.identityLocked` is read from the signed-in account's own file at
  sign-in; reading your own account needs no impersonation.

## The forced-password-change directive

A security directive, `must-change-password.json`, lives in the target
user's own `gilbert` app folder beside `settings.json`, as `{ "setAt":
"<ISO>", "setBy": "<admin username>" }`; a missing file is the not-forced
state. `POST /admin/force-password-change`, behind `requireAdmin`, sets or
clears it through impersonation.

At sign-in, right after credential validation, the server reads the
directive from the user's own Files and marks the session
`gilbert.mustChangePassword: true`. A middleware on the `/api` router then
answers `403 { error: "password_change_required" }` for every data route
while the directive holds for that session's user, checked per request
against a short-TTL cache — so a user forced while already signed in is
stopped at their next request. `/auth/login`, `/auth/logout`,
`/auth/session`, `/api/config`, `/api/health` and `/api/account/password`
stay open. The client shows a full-screen wall whenever the session or a
mid-session 403 says so, with no exit but a successful password change or
sign-out; enforcement is the middleware, not the view.

`POST /api/account/password` clears the directive on a successful change (the
user's own session does it — no impersonation needed) and revokes every
other session. Interactive sign-in with password/TOTP is what the wall
gates; sign-in with an app password (agents and scripts) is not gated.

## What "enforced" means here

This is the only server-enforced per-user rule in the product; ordinary
settings stay client-enforced conveniences, re-applied on every load and
update. The account owner can still write their own Files with any JMAP
client and delete their own directive or policy file — the wall stops normal
use of the product, not a determined bypass outside it. Absolute enforcement
is only possible inside Stalwart itself, which offers no hook for it;
directives and locks carry `setAt`/`setBy`, so removing one is detectable by
an administrator.

## Consequences

- The admin grant has one shape per server and works across every domain it
  serves: a multi-domain installation needs one Stalwart admin role, not one
  per domain.
- Publishing the installation policy costs one impersonated write per
  individual account in the directory — the most expensive administrative
  action in the product, and one of the rarest.
- A corrupt policy or directive document does not block boot or sign-in: the
  server logs it and treats it as absent until repaired through the surface.

## References

- `server/src/upstream.ts` — `isStalwartAdmin`
- `server/src/app.ts` — `requireAdmin`, `requireSession`, the policy and
  force-password-change routes
- `server/src/adminPolicy.ts` — installation policy read, write and fan-out
- `server/src/identityAdmin.ts` — the identity lock file
- `server/src/sessions.ts` — sealed session, impersonation authorization,
  `destroyAllForUser`
- `server/src/config.ts` — the environment bootstrap policy
- ADR 0003 — the agent as the write door into a group's own documents
- ADR 0007 — identity administration
