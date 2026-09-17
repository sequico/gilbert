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
  and says so in a comment. Keep mock parity when you change JMAP behaviour,
  and remember the mock proves nothing about a server nobody has asked: the two
  questions below are the ones only a live instance can answer.

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
- A create whose name a sibling already carries is **refused**, not accepted:
  `onExists` defaults to `Reject` and the answer is `alreadyExists` with the
  existing node's id in `existingId` (`FileNodeSetArguments` /
  `find_sibling_collision`, `crates/jmap-proto/src/object/file_node.rs` /
  `crates/jmap/src/file/set.rs`, v0.16.21; `tests/src/jmap/files/node.rs`
  asserts the id). `replace` / `rename` / `newest` exist but are opt-in. The
  comparison is name-within-parent and case-sensitive unless the request sends
  `compareCaseInsensitively`. What the code does with it: every
  read-then-create of a folder treats it as "somebody made it" and adopts the
  id, and a writer that means to **replace** does not look the name up at all —
  the refusal names the node, and writing the new bytes into it is an update of
  `blobId`/`type`/`size`, which is why a name on a level past the account
  read's page is still written over (ADR 0014). The mock reproduces the
  refusal, the id and the case-sensitivity (`server/src/mock/index.ts`,
  `FileNode/set`).
- A destroy of a **folder that still holds something** is refused unless the
  call carries `onDestroyRemoveChildren: true`; with the flag the folder goes
  **with** its descendants, and an emptied folder goes either way. Nothing here
  has asked a live server to confirm the refusal — it is read off the client's
  own habit of sending the flag on the Files view's delete
  (`destroyNodes` in `web/src/store/files.ts`), and it is owed as a probe. What
  rests on it is the file manager's delete (which sends the flag, and has
  always sent it) and a **merge**'s last step, which deliberately does not: it
  destroys a folder it emptied, so a folder it did not empty stops the merge
  instead of disappearing with whatever landed in it meanwhile (ADR 0015). The
  safe direction is the one that assumes the refusal; if a real server destroys
  the contents anyway, a merge stopped early takes a folder the reader gave up
  anyway. The mock models the refusal, the empty case and the cascade
  (`server/src/mock/destroy-non-empty-folder.test.ts`).
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
  Management API / CLI) — out of product scope by ADR 0001. The read itself
  pages (`position`/`limit`, `calculateTotal`) and reports whether it reached
  the end of the directory; whether a real server pages the way the client
  assumes is asked by `scripts/probe-directory-paging.mjs` (owed).
- **Group membership** is readable, from the account side only, over the
  **registry** (`urn:stalwart:jmap`) — not over the standard principals door.
  The capability is advertised **per account** (and in `primaryAccounts`),
  not in the session's top-level `capabilities`: ask it the way
  `hasStalwartRegistry` does, all three places.

  - every account record carries `memberGroupIds` (`{"e":true}`), which is
    account → groups; a **group** record carries no member list, and
    `x:Group/get` / `x:Group/query` answer `unknownMethod`; a group
    `Principal` carries `id`/`type`/`name`/`description`/`email` and nothing
    about its members.
  - the roster of a group is therefore `x:Account/query` with
    `filter: { memberGroupIds: <groupAccountId> }`, then `x:Account/get` on
    the ids it named (`properties: ["id","@type","emailAddress"]`, and
    `@type: "User"` is the member; the group's own record is not one).
    `memberGroupIds` is the **only** membership filter — `groupId` and
    `memberOf` are refused with `unsupportedFilter`; `ids: null` on
    `x:Account/get` answers every account, which is true but does not scale.
  - the door needs **`sysAccountGet`** (`x:Account/get`) and
    **`sysAccountQuery`** (`x:Account/query`). The built-in **User** and
    **Group** roles carry neither; **Tenant Administrator** carries both (and
    not `impersonate`); **System Administrator** carries everything. So a
    member cannot read their group's roster, and neither can an agent account
    that is only a member of it.
  - a credential without them is refused with a **method-level** error inside
    an HTTP 200 — `{"type":"forbidden"}` in `methodResponses`, not a status —
    which is why the caller reads the batch rather than the response code.
  - live-verified 2026-09-13 against a 0.16 instance (a member, a shared
    account, a group of three and an agent account among them), with the role
    table read from `x:Role/get`; `scripts/probe-group-membership.mjs` asks
    all of it and writes nothing.

  Gilbert spends it in one place: the chat's `@` picker reads the group's
  roster as the Master (`groupMembers` in `server/src/agentAdmin.ts`, cached a
  minute, `null` when it cannot be read) and falls back to the transcript
  (ADR 0005).

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
  source and the support forum are the reliable ground truth. What a *refused*
  composite answers — 401/403, some other status, or a working session — is
  asked by `scripts/probe-impersonation-refusal.mjs` (owed).
- Data at rest is Stalwart's business (encryptionAtRest is refused by the
  product — see ROADMAP: it is a one-way door); the Gilbert side adds no
  per-account encryption.

## The two live questions the mock cannot answer (owed 2026-09-13)

Each has a script in `scripts/` that asks a real instance: run by hand, never by
`prepush` (they need a live server and an administrator's password). Both read
`STALWART_URL`, `GILBERT_AGENT_ADDRESS` and `GILBERT_AGENT_PASSWORD` from the
environment, print what the server actually answered, and exit non-zero when an
answer is not the one the code depends on. **Neither has been run against a live
server as of 2026-09-13 — they are owed, and this section is the record of the
debt.** Run one before trusting a new server version, then replace the owed note
below with the answer, its version and its date.

### `scripts/probe-directory-paging.mjs` — the directory read's paging

Settles, for `fetchDirectoryPrincipals` in `server/src/upstream.ts` (the admin
Users surface, and the `/admin/policy` fan-out that rests on `complete`): that
`Principal/query` is accepted with `position`, `limit` and `calculateTotal` at
the page size `directoryBatch` derives from the session's `maxObjectsInGet`;
that the read reaches the end of the directory (a reported `total`, or an empty
page one request later); that `position` is honoured rather than the first page
served again; that a reported `total` is the population and not the page — walked
a second time at `limit: 2` and compared id for id, plus the check that the page
at the point the walk stops is empty; that `Principal/get` answers a page of ids
with `id`/`type`/`name`/`email` and `individual` is the type a user account
carries; that a `limit` far above the ceiling is clamped rather than refused; and
— given a second credential — whether a credential outside the directory gate is
refused the way the code reads a refusal.

If a server answers differently, this is what the code does today, in the order
of how much the answer costs:

- **no `total`**: the walk ends on the empty page instead, one request later, and
  `total` is `null`. `complete` still means the walk reached the end; the publish
  records the population it could not count rather than one it invented.
- **`position` ignored, or a page that repeats**: the walk stops and reports
  `complete: false`, and `/admin/policy` then refuses to claim the installation
  carries the policy (`carrying = directory.complete && unreached.length === 0`).
  A partial publish that says so is the fallback, one request later than an empty
  page would have been.
- **`total` is the page size rather than the population**: there is no fallback in
  the code — the read stops after the first page *and reports `complete: true`*,
  which is the one answer that makes the publish's coverage claim false on an
  installation larger than a page. That answer stops the work, not just the run:
  the read has to reach the end without trusting `total`.
- **a `limit` the server refuses instead of clamping**: the read is safe only
  while the session advertises `maxObjectsInGet`, which is what the batch is
  clamped to. A session that advertises nothing asks 1000 blind, so the fallback
  there is a smaller `directoryBatch` — a code change.
- **a closed directory gate**: the read returns `{ denied }`, the Users surface
  says the server does not grant enumeration, and the client degrades to typing an
  address. That answer is expected, not a failure.

### `scripts/probe-impersonation-refusal.mjs` — what a refusal looks like

Settles, for `impersonateAs` in `server/src/agentAdmin.ts` (and the acting-check
in `/admin/users`): that the master's own credential opens a session at all (the
control without which a refusal means nothing); that the composite
`{target}%{master}`, built the way `impersonationAuthorization` builds it, is
refused with **401 or 403** for an address the master may not act as; that a
composite naming an account the master *may* act as opens a session as the target
(the control that tells a refusal apart from a composite shape the server does
not accept); and, given a group address, that a group mailbox is refused.

`fetchUpstreamSession` turns 401 and 403 into `UpstreamError(401)`, which
`impersonateAs` reports as "No such account, or it cannot be administered by
you." (a 404 at the surface). Every other answer is read the other way:

- **404, 500 or any other status**: `UpstreamError(…, 502)` — the admin surface
  reports an upstream failure instead of a refusal, and an administrator reads a
  broken installation where the honest answer is "no such account". The fallback
  is a code change (widen the refusal set in `fetchUpstreamSession`), not a hope.
- **200**: the composite authenticated as the target, `impersonateAs` returns a
  working session, and nothing refuses at all — the surfaces would act as an
  account the server should not have granted. There is no fallback: that answer is
  why this probe exists, and it stops the work.
- **a 200 that is not a session document**: `fetchUpstreamSession` throws where it
  parses one — neither a refusal nor an `UpstreamError`, so it leaves
  `impersonateAs` as an unexpected error and the route's own failure path answers
  it. The probe records that as its own answer rather than as a refusal.
- **the app-password case never reaches the server**: `impersonationAuthorization`
  returns null and `impersonateAs` answers 403 locally, which is why an
  app-password session cannot administer accounts whatever a server would have
  said. This probe therefore does not settle Stalwart's own app-password rule
  (read in `authentication.rs`, and enforced before the request leaves Gilbert).

Group membership is settled by the registry read above — the two probes here
settle neither it nor a group account's Files visibility (see `gilbert-groups`),
nor the directory's `type` vocabulary beyond `individual` and `group`.

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
   the dated comments; note the check (version + date) in the code. Where only a
   real server can answer, the question is written down as owed (see *The two
   live questions the mock cannot answer*) and asked by a `scripts/probe-*.mjs`
   script — by hand, since the gate has no server to ask.
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
