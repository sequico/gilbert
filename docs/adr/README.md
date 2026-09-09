# Architecture Decision Records — index and code state

One file per decision (`NNNN-kebab-case-title.md`), oldest first. Each record
states **what the decision is**; this index states **what the code does with
it today**, so the two can be checked at a glance instead of by diffing
prose against `server/src` and `web/src`.

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

- **Status:** Accepted (2026-09-07).
- **Code:** standing law, in force. `sync-upstream.yml` mirrors upstream
  releases onto the `ihasmail` branch; mail core merges them in rebranded;
  nothing flows back. README, NOTICE, LICENSE and the merge skill carry the
  lineage.

## 0003 — Agent worker fleet

- **Status:** Proposed (2026-09-06).
- **Code:** **not implemented** — no product agents surface exists
  (`server/src`, `web/src` are clean of it). ADR 0007 decision 3 keeps the
  door open: agents, when they exist, are Stalwart-side principals an admin
  grants resources to through JMAP `shareWith`, with creation operator-side.

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

## 0008 — Mobile companion app

- **Status:** Proposed (2026-09-09).
- **Code:** **not implemented** — recorded for later ("DOPO"): an
  installable Android/iOS app holding multiple Gilbert identities (server,
  user, password), push-notifying chat and mail arrival, deep-linking into
  the web client on tap.
