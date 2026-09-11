# Architecture Decision Records — index and code state

One file per decision (`NNNN-kebab-case-title.md`), oldest first. Each record
states **what the decision is**; this index states **what the code does with
it today**, so the two can be checked at a glance instead of by diffing
prose against `server/src` and `web/src`.

Every record here names the four blocks — **gilbertmailer**,
**gilbertserver**, **gilbertagents** and **gilbertstalwart** — the way
`README.md` defines them, so a decision and the document describing the product
use one vocabulary. The definitions, and the line to upstream, live there and
are not repeated here.

## How to read the statuses

- `Status` is the **decision lifecycle**, never an implementation flag:
  `Proposed` (written, owner has not ratified it), `Accepted` (the owner
  ratified the decision), `Superseded` (a later decision replaced it).
- **Implementation lives in the code** — `FEATURES.md` is the inventory of
  what Gilbert does — and the "Code" line below records the current state of
  each decision against main, with the pointers that prove it. A decision can
  be implemented while still `Proposed` (the owner never formally accepted
  it: 0004, 0005) and can be `Accepted` with parts deferred (0006's chat v1
  scope).
- Supersession is one-way and never rewritten: a superseded ADR's body stays
  as the historical record of what was decided; only the Status line and this
  index move.

---

## 0001 — Admin group and the administration surface

- **Status:** Superseded (2026-09-09) by ADR 0007.
- **Code:** the grant it described (membership of the `gilbert-admin` group
  mailbox) is gone; the administration surface it scoped (shield, policy
  editor) survives under ADR 0007's grant. `server/src/app.ts`
  (`requireAdmin`), `web/src/views/AdminView.tsx`.
- See ADR 0007 for the current grant.

## 0002 — Upstream is download-only

- **Status:** Accepted (2026-09-07; amended 2026-09-11).
- **Code:** standing law, in force. Releases are fetched at merge time —
  `https://github.com/Coffey-Labs/ihasmail` as a remote, tags under
  `refs/upstream/tags/*` — and the mail core merges them in rebranded; nothing
  flows back, and no mirror branch is kept. `upstream-watch.yml` reports a
  release `main` has not taken in. README, NOTICE, LICENSE and the merge skill
  carry the lineage.

## 0003 — Agent worker fleet

- **Status:** Accepted (2026-09-11).
- **Code:** **implemented** — the fleet, its workers, the automations, the
  approvals and the audit are in `server/src/agent/` and
  `server/src/agentAdmin.ts`, with the administration surfaces in
  `web/src/views/admin/` and the member's panel in
  `web/src/views/chat/GroupAgentPanel.tsx`. Resolutions 18 to 21 carry the
  decisions it grew, ADR 0009 records where the installation's agent identity
  lives, and the first part of `FEATURES.md` is its inventory.

## 0004 — Rule changes reach signed-in clients by re-login (kick v0)

- **Status:** Accepted (2026-09-09).
- **Code:** implemented. Install-wide policy document (`defaults` /
  `enforced` / `changes`), validated and swapped at runtime, atomically
  persisted to `SETTINGS_POLICY_FILE`, and published by kicking every other
  session (`sessions.destroyAllExcept`) so the next sign-in applies it.
  `server/src/app.ts` (`/admin/policy`), `server/src/adminPolicy.ts`,
  `server/src/config.ts`, `web/src/lib/settingsPolicy.ts`, the enforcement
  door in `web/src/store/settings.ts`.

## 0005 — Forced password change

- **Status:** Accepted (2026-09-09).
- **Code:** implemented. Directive `must-change-password.json` in the user's
  own `gilbert` app folder; the server door answers 403 on every data route;
  admin force/release through Stalwart impersonation. `server/src/account.ts`,
  `server/src/app.ts` (`/admin/force-password-change`), the door middleware.

## 0006 — Group chat on the group's own Files

- **Status:** Accepted (2026-09-08).
- **Code:** implemented. Chat over FileNodes in the group account's
  `gilbert/chat` (+ `chat-state` markers), real-time via the FileNode push
  rail, launcher/badge/panel UI; plus the group label catalog (`labels.json`,
  admin-defined). Since ADR 0007 there is no `gilbert-admin` group, so the
  record's "product-admin group excluded" clauses are moot. The label
  catalog's administration is the ADR's own membership rule: a member
  administrator writes through their own session (2026-09-09, after a live
  check showed Stalwart 0.16 refuses impersonated group sessions).
  Open questions recorded in the ADR: Q1 (member writes into a group's app
  folder) settled by the live rights probe 2026-09-09 and the member-path
  tests; Q2 (creation order) settled on the FileNode `created` property with
  id tie-break; Q3 (subscription shape) settled by adding FileNode to the
  per-session subscription. `web/src/views/chat/`, `web/src/store/chat.ts`,
  `server/src/app.ts` (`/admin/groups/*`), `server/src/mock/index.ts`.

## 0007 — Stalwart admin is the Gilbert admin

- **Status:** Accepted (2026-09-09).
- **Code:** implemented and released (`v2026.9.9-g2c1d362` +). Admin is
  resolved from the account's own `/api/account` permission list (marker
  `sysAccountCreate`, env `GILBERT_ADMIN_PERMISSION`), re-checked freshly on
  every privileged call; per-user writes additionally need Stalwart's
  `Impersonate`. No `gilbert-*` group, no capability registry, no Management
  API. `server/src/upstream.ts`, `server/src/app.ts`, `server/src/config.ts`,
  the mock's permission model, `web/src/views/AdminView.tsx`.
  Supersedes ADR 0001.

## 0009 — The installation’s agent identity is recorded in the product

- **Status:** Accepted (2026-09-11).
- **Code:** implemented — `agent.address` in the policy document,
  `POST /api/admin/agent/address`, `agentAddress()`/`agentHasSecret()`,
  the Agent address field in Admin → Agents.

## 0008 — Mobile companion app

- **Status:** Proposed (2026-09-09).
- **Code:** **not implemented** — recorded for later ("later"): an
  installable Android/iOS app holding multiple Gilbert identities (server,
  user, password), push-notifying chat and mail arrival, deep-linking into
  the web client on tap.

## 0010 — Identities an administrator sets

- **Status:** Proposed (2026-09-11).
- **Code:** **not implemented** — the administration gains **User identities**
  and **Group identities** under the Stalwart group. An administrator edits a
  person's identities (display name, address, `replyTo`, signature — the whole
  list, adding, changing and removing) by impersonating the person from their
  own session, and a group's one identity as the installation's **agent**,
  because Stalwart refuses impersonation of a group mailbox. A locked principal
  is one whose Identities & signatures section is not shown. JMAP only: no
  Management API, no server configuration written by the product.

## 0011 — System sieves, and the second door to Stalwart

- **Status:** Proposed (2026-09-11).
- **Code:** **not implemented** — the administration gains a **System sieves**
  section under the Stalwart group, editing the server's trusted Sieve scripts
  through Stalwart's management API as the signed-in administrator: the one
  deliberate exception to JMAP-only, one object wide, with no service
  credential. The section is shown even when `sysSieveSystemScript*` is
  missing, and names the permission.

## 0012 — The push subscription covers every type a surface keeps live

- **Status:** Proposed (2026-09-11).
- **Code:** `server/src/shared/push.ts` and `server/src/push.ts` — the fan-out
  subscription names every state type a surface watches, not a mail-only list,
  so turning it on no longer freezes the calendar, contacts, tasks, filters,
  files and the quota bar that the relay kept live.

## 0013 — The push callback origin comes from the request, under proxy trust

- **Status:** Proposed (2026-09-11).
- **Code:** `pushOrigin()` in `server/src/app.ts`, and the `origin` an entry in
  `server/src/push.ts` carries — the address Stalwart POSTs back to is derived
  from the request, and only from a request a trusted proxy carried over https,
  instead of being configured a second time beside the deployment's own
  hostname. `PUSH_MODE` stays the one switch.
