---
name: gilbert-stalwart
description: Working directly with Stalwart in the Gilbert repository — the mail/collaboration server that holds every durable byte. Covers the 0.16 requirement and its live-verified behaviours and quirks, where the JMAP integration lives, what the mock server does and does not reproduce, administration and access-control facts (admin group, impersonation), and how to check Stalwart's own docs and source. Load before touching any Stalwart-facing surface (JMAP calls, mock handlers, version gates, server auth, account/principal logic, FileNode storage).
metadata:
  short-description: Stalwart architecture, quirks & integration map
---

# Gilbert — working with Stalwart

## What Stalwart is here

Stalwart is the single binary mail + collaboration server that backs Gilbert.
Architecture law: **JMAP only, no own database, everything durable lives in
Stalwart**, container disposable. The Gilbert Node server is a thin proxy
(sign-in, sealed sessions, `/api/jmap` forwarding, `/api/config` policy) and
the web client speaks JMAP directly through it. There is no other store: no
Postgres behind Gilbert, no volume that matters, no server-side files for
account data.

- **Version floor: Stalwart 0.16.** Sign-in refuses anything older, once, with
  a clear message (`server/src/app.ts` ~line 359). **Read the source at the
  newest release tag, never at a remembered one**: what the deployment runs is
  the newest release and `README.md`'s badge names it, while a version in a
  dated comment below is the version *that check* ran against. Assume 0.16
  semantics, and when the server moves, re-read the dated comments before
  trusting them.
- **The mock server** (`server/src/mock/index.ts`) emulates a 0.16 server
  in memory for `npm run dev:mock` (demo@example.com / demo) and for tests. It
  is deliberately faithful on the behaviours that bit us (see quirks) and
  generic elsewhere — when a refusal or field matters, the mock reproduces it
  and says so in a comment. Keep mock parity when you change JMAP behaviour.

## The JMAP surface Gilbert uses

Session capabilities the client expects (`server/src/mock/index.ts`): core,
mail, submission, vacationresponse, webpush-vapid + emailpush, sieve,
calendars (+parse), contacts (+parse), principals (+availability), quota,
blob, filenode. The client selects the account that owns a capability via
`ownAccountFor(...)` in `web/src/store/session.ts` — never assume the first
account. Shared accounts advertise the same capabilities as personal ones
(confirmed on 0.16.19), so capability lists reveal nothing about what is
shared.

Where the integration lives:

- `web/src/jmap/client.ts` — request chain, upload/download of blobs, auth
  handling (a 401 signs the client out by design).
- `web/src/jmap/types.ts` + `web/src/lib/filenode.ts` — wire shapes; FileNode
  is the JMAP Files object (0.16: `nodeType` required, rights are four
  separate `myRights` fields).
- `server/src/app.ts`, `sessions.ts`, `crypto.ts` — proxy, in-memory sealed
  sessions, sign-in. The server never holds a plaintext credential longer
  than the exchange; `IMMUTABLE=1` means no writable filesystem at all.
- `server/src/account.ts` — what sign-in learns from the account.
- `web/src/store/sieve.ts` — `GILBERT_SCRIPT = "gilbert"` (data name, kept).

## Where account data lives (the map that answers "where do I put this?")

- Settings that follow the account: `settings.json` inside the **`gilbert`**
  app folder in the account's own JMAP Files (`web/src/lib/appFolder.ts`),
  with signature images and over-sized signature HTML beside it. The folder is
  a real top-level FileNode, hidden from the Files view. localStorage is only
  a first-frame cache.
- Server-side JMAP objects, never client state: mailboxes/emails, identities
  (signatures capped at 2047 bytes of UTF-8 — Rust `len()`, see
  `web/src/lib/signatureHtml.ts`), calendar events, contacts, sieve scripts,
  principal/group structure.
- Installation policy: `server/src/config.ts` (settings-policy file/env),
  served by `/api/config`; admin group concept in `docs/adr/0001` (admin is
  membership of a Stalwart group, e.g. `admins@domain`; policy documents in
  the admin group's own Files).
- **New durable state goes into Stalwart, never into a new file/DB on the
  Gilbert side.** Prefer an account's own Files (or the admin group's Files for
  system documents) or a real JMAP object. If it must be readable before
  authentication, it is configuration, not account data.

## Quirks confirmed live (0.16.x) — read before assuming

- `FileNode/query` **cannot filter by `name`**; name filters are matched
  client-side (`web/src/lib/appFolder.ts`). A filter the server does not know
  fails the whole query.
- `FileNode/query` masks directories out of its own results before 0.16; with
  0.16 the mock and client send/respect `nodeType`.
- `FileNode/set` returns **no `blobId` on create** — ask with a follow-up get
  (`nodeBlobId`).
- Unshared nodes report `shareWith: {}`, not `null` (0.16.19, 2026-08-27) —
  test with `Object.keys(...).length`.
- Stalwart refuses writing `isSubscribed` on an address book shared
  read-only, but accepts the same write on a shared calendar — the
  inconsistency `addedShares` in settings exists to paper over
  (`web/src/store/settings.ts`).
- Identity signatures are capped at 2047 **bytes of UTF-8**; over-long rich
  signatures are stored in Files and referenced by a
  `<!--gilbert:sig=…-->` marker (old stored signatures must stay readable —
  marker text is data, not brand surface).
- 2FA accounts sign in with an app password (Basic + `$<totp>` where needed,
  see the mock's `checkAuth`). In-product 2FA *switch-on* is not built;
  Stalwart's own flows are OAuth-based.
- The server does not publish its version to clients; Gilbert reports the
  edition and gates sign-in on >= 0.16.

## Administration and access control (Stalwart side)

- Directory principals: individual accounts and **group mailboxes**. Gilbert's
  product admin = membership of the configured admin group (ADR 0001); the
  group also owns system documents (per-user policy). Creating accounts,
  groups, aliases, quotas is **Stalwart's own administration** (admin console /
  Management API / CLI) — out of product scope by ADR 0001.
- Stalwart 0.16 added **JMAP impersonation**: a principal granted the
  impersonation right can authenticate to JMAP as another user with a
  composite username `{target}%{master}` (target first), using the master
  account's credentials. Stalwart's `master` there is **its** word for the
  impersonating principal — in Gilbert that is the signed-in administrator
  (ADR 0001), which is why the code composes `{agent}%{admin}` when it acts as
  the agent, and it is not the **Master** account of ADR 0003.
  **App passwords are refused for impersonation**
  (server source, `authentication.rs`). Consequences to design for: an
  administrator with impersonation can read and write any account's Files —
  including the `gilbert` app folder and its `settings.json` — through the
  same JMAP methods the client uses. The app folder is not a security
  boundary; enforcement (`policyEnforced`) is client-side and protects
  enforced keys from the user, not from whoever can write the account.
  Re-verify details against current docs/source before relying on them; the
  stalw.art doc pages are hard to scrape (heavy nav markup) — the GitHub
  source and the support forum are the reliable ground truth.
- Data at rest is Stalwart's business (encryptionAtRest is refused by the
  product — see ROADMAP: it is a one-way door); the Gilbert side adds no
  per-account encryption.

## Checking Stalwart's own material

- Docs: https://stalw.art/docs/ (current). Older material is archived under
  versioned paths (`/docs/0.15/…`); the current pages carry large navigation
  blocks and old-version sidebar duplicates — when scraping, look for the
  article body near the end or use the GitHub source instead.
- Source of truth for details: github.com/stalwartlabs/stalwart (e.g. the
  impersonation app-password refusal lives in `authentication.rs`). Read it at
  the newest release tag, and find that tag by asking rather than remembering:

  ```
  curl -s https://api.github.com/repos/stalwartlabs/stalwart/tags | grep '"name"' | head -3
  git clone --depth 1 --branch <newest tag> https://github.com/stalwartlabs/stalwart /tmp/stalwart
  ```

  A later patch release moves line numbers and can move behaviour, so a claim
  carried from an older tag is a claim about that tag. `README.md` and
  `FEATURES.md` name the version the live instance runs: that is the one to
  read unless the question is specifically about an older one.
- Community/answers: support.stalw.art forum threads frequently quote exact
  source lines with version context.
- In-repo ground truth: dated comments ("checked on <version> (<date>)") in
  `web/src/lib`, `web/src/store`, `server/src/mock` are the best record of
  what a real server does; extend them (date + version) when you confirm
  something new rather than trusting memory.

## FileNode state, changes and push (verified live 2026-09-07)

FileNode is a first-class JMAP data type in Stalwart, not a second-class
citizen, and its changes ride the same push rail as Email:

- `DataType::FileNode` exists in the enum (value 18, serde name `"FileNode"`,
  `crates/types/src/type_state.rs`, present at the newest release tag). Capability URN
  is **`urn:ietf:params:jmap:filenode`** and must be in the request's
  `using` — omitting it fails with `unknownMethod`.
- `FileNode/set` returns `oldState`/`newState`; `FileNode/changes` works from
  a `sinceState` (live: reports `created`, `hasMoreChanges: false`).
  `FileNode/query` cannot filter by `name` (older quirk) and filters the
  server does not know fail the whole request.
- A `PushSubscription` accepts `types: ["FileNode"]` (no whitelist; parsed
  from the DataType enum) and the webpush POST is filtered per subscription
  by those types (`state_manager/push.rs: filter_types`). The event source
  accepts `?types=FileNode` and delivers
  `{"@type":"StateChange","changed":{<accountId>:{"FileNode": "<state>"}}}`.
  Live probe on the owner's test instance (claimed 0.16.21, 2026-09-07): create two
  nodes, `FileNode/changes` from the first state reported the second;
  eventsource with `types=FileNode` streamed the StateChange. Source of truth
  for details at any release tag (`crates/jmap/src/push/set.rs`,
  `crates/services/src/state_manager/push.rs`, `crates/jmap/src/api/event_source.rs`,
  `tests/src/jmap/files/node.rs`).
- Member sessions on a **group account** can create and destroy calendars and
  address books in the group's own account (live, freight/`e` on
  the owner's test instance, 2026-09-07) and can read the group account's Files
  (`FileNode/query` answers). The **admin group account answers `FileNode/
  query` with nothing** for members: its Files are admin-surface data, not
  member-readable through JMAP.
- Blobs uploaded but never referenced are not deletable through JMAP; the
  server's GC reclaims them. `FileNode/set` returns no `blobId` on create —
  ask with a follow-up get (`nodeBlobId`).

## Working rules

1. Stalwart holds everything durable — before adding storage, decide which
   Stalwart surface owns it (account Files, admin-group Files, or a JMAP
   object); never introduce a Gilbert-side database or volume.
2. When changing JMAP behaviour, keep `server/src/mock/index.ts` in step and
   say in a comment what the mock reproduces and what it does not.
3. Confirm server-version-sensitive behaviour against a real 0.16.x server or
   the dated comments; note the check (version + date) in the code.
4. UI copy names data by its literal name: the folder is `gilbert`, the sieve
   script is `gilbert` — "Gilbert" (capitalised) is only the product's
   visible name. When in doubt, follow `gilbert-branding`.
5. Server-side administration of Stalwart (accounts, domains, groups) is not
   something Gilbert does; design around it (group membership, policy docs)
   rather than reaching for the Management API without a decision.
6. **Conditional writes (`ifInState`) are the agent design's lock** (ADR 0003,
   *Coordination: leases, claims and fencing*): the token is a **whole-account
   FileNode state**, not a per-document one,
   so any unrelated write — a member's upload, another document, a prune in the
   same pass — invalidates it. The four questions it rests on are answered
   live (2026-09-11, `scripts/probe-conditional-writes.mjs`, 0.16.21), and
   these are its answers: `FileNode/set` honours
   `ifInState`; a stale token is refused as `stateMismatch` rather than
   `invalidArguments`; the token advances on every write that matters and does
   **not** advance on a blob upload. That last answer is what makes the
   production write path safe — `writeAppFileAt` uploads between the token read
   and the conditional write — and the mock reproduces every one of the four,
   pinned by `server/src/mock/compare-and-set.test.ts` so a change in the
   simulation fails loudly instead of being inherited.
