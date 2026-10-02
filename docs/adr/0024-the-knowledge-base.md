# ADR 0024 — The knowledge base

Status: Proposed

Implementation: Partly built. The article shape, the storage layout, the
validators and the lifecycle arithmetic are one definition
(`server/src/shared/knowledge.ts`); the Master-owned write door and its
`/api/knowledge/*` routes are `server/src/knowledgeAdmin.ts` and
`server/src/app.ts`; the company KB is created and shared at boot
(`server/src/index.ts`); the client reads and writes through
`web/src/lib/knowledge.ts` and `web/src/store/knowledge.ts`; the surface and its
BlockNote editor are `web/src/views/knowledge/`; and the fleet's `knowledge`
lookup and `knowledge.write` capability live in `server/src/agent/`. The fleet
records the multi-document plan it applies and a review's findings on the run's
own job (`knowledge.write`'s `basedOn` refuses a page that moved since the plan
was read; `knowledge.review` records the prose), in the trail Q23 names. Not
built: the phases this record defers (co-editing over Yjs/Hocuspocus, Excalidraw
diagrams), and the checklist templates a workorder instantiates (ADR 0028). The
company KB's read share on `gilbert/knowledge` is owed the live probe ADR 0023
carries for a share that reaches every account.

## Context

Gilbert needs an **enterprise knowledge base** — a place for the company's
documents, for people and for agents — built from standard, best-practice
components rather than hand-written ones, and living **inside** Gilbert: no
separate product, no second database, no second service.

What it is for, in the owner's words and the questions that follow:

- **Primarily installation-wide.** One body of knowledge for the whole company,
  not a per-group feature with a company one bolted on. Group knowledge bases
  exist too, but the company's is the lead.
- **People and agents alike.** A person reads and edits it; an agent reads it to
  answer, and writes to it to remember.
- **Findings, versions and publication.** Some documents are controlled: they
  are versioned, and some (e.g. the ISO 9001 policies) are *published* — the
  company's issued, citable, currently-in-force text.

The architecture law constrains every answer below: **JMAP only, to Stalwart;
no database of Gilbert's own; everything durable lives in Stalwart; the
container is disposable and with `IMMUTABLE=1` has no writable filesystem**
(`AGENTS.md`, `gilbert-project`). The licence is AGPL-3.0-or-later, which
decides which libraries may be taken (see the shelf below).

## Findings — what the tree already has

These are the facts the design must be built on. Each is a file or a record in
this tree, not a preference.

- **The app folder is the home for Gilbert's own documents.** `gilbert` is a
  real top-level FileNode in an account's JMAP Files, hidden from the Files
  view; settings, signature assets, a group's chat and label catalog and the
  agent documents live in it (`server/src/shared/appFolder.ts`,
  `web/src/lib/appFolder.ts`). The folder name and the document shape are one
  definition both tiers read; a write is `putFile`/`writeBlobInFolder` with an
  optional `ifInState`.
- **Chat is the precedent for an app-folder-backed, group-owned, push-driven
  feature.** One JSON node per message in `gilbert/chat`, read markers in
  `gilbert/chat-state`, membership the grant, no `shareWith` out of a personal
  account (`web/src/lib/chat.ts`, `web/src/store/chat.ts`, `docs/adr/0005`).
- **Global contacts is the precedent for an installation-wide resource.**
  One book in the **Master's** account, created at boot by the installation
  rather than by hand, shared read-only with every account, written only by an
  administrator through a server route that acts as the Master
  (`server/src/globalContactsAdmin.ts`, `docs/adr/0023`). The exact Stalwart
  shape of a share naming every account at once is **owed a live probe**;
  `shareWithEveryone` is the best-known shape (a paged `Principal/query` merged
  into the node's `shareWith`).
- **The admin group's Files are not member-readable.** A member's `FileNode/
  query` against the admin group's account answers nothing (`gilbert-stalwart`).
  So an installation-wide document cannot live in the admin group; the Master's
  account is where installation things live.
- **The agent fleet already has a two-speed memory.** The group's **notebook**
  (`gilbert/agent/notebook.json`) is the distilled head carried into every call;
  a **lookup** (`docs/adr/0020`) is the narrow tail a run fetches by name from a
  closed catalogue — `mail`, `message`, `mailboxes`, `labels`, `files`, `file`,
  `chat` — at most `AGENT_LOOKUP_ROUNDS` times, bounded in size
  (`server/src/agent/documents.ts`, `server/src/agent/llm.ts`). A knowledge base
  is a natural new lookup kind; the notebook is not replaced by it.
- **The document family already reads real documents.** PDF, `.docx`,
  `.xlsx`/`.xls`, text and images are read as text and, where a page is pixels,
  as images handed to the model (`server/src/agent/documentFamily.ts`). A KB
  that holds files rather than only blocks already has a reader.
- **The composer's editor is Squire, an email editor.**
  `web/src/views/compose/RichEditor.tsx` wraps Squire (`squire-rte`, MIT), whose
  HTML-is-the-source-of-truth model is what an email body needs and whose
  quoting is first-class (`docs/adr/0029`). It is not a block document editor
  and is not a candidate to extend into one — the KB wants structured blocks,
  which is a different tool.
- **Conditional writes are the only lock JMAP offers.** `FileNode/set` honours
  `ifInState`, refused as `stateMismatch`; the token is **whole-account**
  FileNode state, so any unrelated write invalidates it (`gilbert-stalwart`,
  `web/src/lib/appFolder.ts`). A per-page save races every other write in the
  account and retries.
- **FileNode quirks that shape the writer.** `FileNode/query` cannot filter by
  `name` (match client-side); a create whose name a sibling holds is refused
  `alreadyExists` with `existingId`; destroying a non-empty folder needs
  `onDestroyRemoveChildren: true`; `FileNode/set` returns no `blobId` on create
  (`gilbert-stalwart`).
- **Writes cost and are not given back.** Every blob upload is charged and the
  server never returns it; the tree has tests against periodic writes for exactly
  this reason (`docs/adr/0012`, `server/src/agent/no-periodic-writes.test.ts`,
  `server/src/appfolder-write.test.ts`). Anything that writes per save, per
  keystroke or per visit must be bounded deliberately.
- **Push is broad.** A subscription can name `types: ["FileNode"]`, but a JMAP
  push filter is email-shaped only, so a folder cannot be narrowed: every file
  write in every account the subscription serves wakes the client, which reads
  the change back over `/api/jmap` (`gilbert-stalwart`, `docs/adr/0016`).

## Findings — what is on the shelf (GitHub, 2026-09-25)

Two families. The licence column is read against Gilbert's AGPL-3.0-or-later.

**Complete products** (each a service with its own database, auth and storage):

| Project | Stars | Stack | Licence | Fit |
| --- | --- | --- | --- | --- |
| `docmost/docmost` | 21.8k | TS/React, Postgres | AGPL-3.0 | Feature-close, licence-compatible; but an app, not components |
| `requarks/wiki` | 29k | Vue/Node, own DB | AGPL-3.0 | Mature; separate service |
| `outline/outline` | 40.7k | TS/Node, Postgres+Redis+S3 | **BSL 1.1** | Non-free; forbids a "Document Service" — **excluded** |
| `BookStackApp/BookStack` | 19k | PHP/Laravel | MIT | Off-stack |
| `toeverything/AFFiNE` | 72.9k | TS/Rust | mixed | An ecosystem of its own |
| `AppFlowy-IO/AppFlowy` | 76.9k | Dart/Flutter | AGPL-3.0 | An app, not components |

Every one of them brings a second database and a second service, which the
architecture law refuses and which would make the KB a companion product rather
than a feature inside Gilbert.

**Components and libraries** (the "do not write it from scratch" path):

| Need | Project | Stars | Licence | Note |
| --- | --- | --- | --- | --- |
| Block editor | `TypeCellOS/BlockNote` | 10.2k | **MPL-2.0** core | ProseMirror/TipTap + Yjs built in; XL packages separately licensed (paid/AGPL) |
| Block editor | `ueberdosis/tiptap` | 38.5k | MIT core | Headless; more assembly (some Pro extensions commercial) |
| Block editor | `udecode/plate` | 16.6k | MIT | Slate + shadcn/ui; Notion template |
| Block editor | `facebook/lexical` | — | MIT | Headless; more work |
| CRDT | `yjs/yjs` | 22.8k | MIT | The standard |
| CRDT server | `ueberdosis/hocuspocus` | 2.6k | MIT | A library: can mount in the existing Node server, no new DB |
| CRDT store | `jamsocket/y-sweet` | 1.0k | MIT | Rust, S3-backed; a separate binary |
| Search / RAG | `oramasearch/orama` | 10.5k | Apache-2.0 | Full-text + vector **in-process**; no service |
| Search | `meilisearch/meilisearch` | 59.4k | MIT + BUSL (EE) | Separate service |
| Search | `typesense/typesense` | 26.6k | GPL-3.0 | Separate service |
| Diagrams | `excalidraw/excalidraw` | 132.8k | MIT | Embeddable React component |

The component path fits the law: the editor and the collaboration library are
dependencies of the SPA, the search runs in-process, and the durable bytes stay
in Stalwart. `Outline` is excluded on licence; the separate search services are
excluded because they are a second store.

## Which libraries we use

The question "use the shelf, or take only the ideas and write it ourselves?" has
one answer, and it is a split: **buy everything a thousand projects have already
solved the same way; build the part that is Gilbert's alone.** A block editor, a
CRDT, full-text search and a canvas are generic and hard; the durable bytes in
Stalwart, the ownership, the control of a document and the agent that keeps it
aligned are Gilbert's and exist nowhere to import.

**Take off the shelf:**

- **BlockNote** — the page editor (core MPL-2.0, React). It brings ProseMirror
  and TipTap transitively, so those are not separate choices. This is the one
  dependency v1 cannot do without.
- **Orama** — the search engine (Apache-2.0), in-process over the pages' `text`,
  read by both tiers.
- **Yjs + Hocuspocus** — real-time co-editing, when that phase comes: Hocuspocus
  is a library that mounts in the existing Node process (no new service); the
  CRDT state checkpoints into the page documents.
- **Excalidraw** — diagrams, optional and later, as an embedded React component.

**Write ourselves** (no library owns this; it is the architecture):

- `@gilbert/shared/knowledge` — the page shape, the folder layout, the tree and
  text helpers, the one definition both tiers read.
- Storage through the existing app-folder writers and their `ifInState`.
- Ownership — the Master's company KB and each group's — the share, the
  boot-time ensure.
- Versioning and its retention, the publication lifecycle and its approval.
- The agent's document-controller behaviour and its catalogue entries.
- The wiring around Orama: the index over KB pages is ours, the engine is not.

**Take only the ideas** (adopt nothing):

- The full products — Outline (BSL 1.1), Docmost, Wiki.js, BookStack, AFFiNE,
  AppFlowy. Each is a second database and a second service, which the law
  refuses; they are read for what a KB needs, not depended on.
- Meilisearch and Typesense — a second service and a second store.
- Plate, Lexical and standalone TipTap — redundant once BlockNote is the editor;
  kept only as the fallback if BlockNote proves too opinionated for the page
  (Q12).
- A QMS/ISO-9001 product — the shelf holds only tiny or unmaintained ones
  (`dromation/open-eqms`, `jonaesantos/odoo-qms-iso9001`), none an embeddable
  library, and each brings its own store. Document control is built on the KB and
  the agent fleet (below).
- A workflow/BPMN engine (`vercel/workflow`, `dbos`, Hatchet and the like) — the
  fleet's own jobs, decisions and approvals (`docs/adr/0003`) are the workflow,
  and a durable-workflow engine brings a database, which is refused.

One dependency at a time: BlockNote and Orama in v1; Yjs/Hocuspocus and
Excalidraw only when their phase arrives.

## The design as it stands

Not yet accepted, and every question below is settled. The approval lifecycle is
the core of it.

### What the KB holds: procedures and checklist templates

The KB is the **strategic, controlled** layer — what the company has decided and
how its work is done. Beside policies and procedures it holds **checklist
templates**: the steps a job of that kind must take and what each step means. A
template is an **article like any other** — the same folder, the same draft and
revisions, the same approval — only its body is a checklist.

A workorder's checklist is an **instance of a template** (ADR 0028): the
workorder carries the operational state — the step ids, their state, who checked
them, the references — and never a copy of the controlled text, which the reader
gets from the KB. The two layers are deliberately different: the KB is versioned,
reviewed and approved with an effective instant; the workorder is lean and moves.

### The surface in the app

The KB is a top-level section of its own — the **fifth**, placed after **Mail,
Calendar, Contacts and Files** in the module bar — and not a folder inside Files
(Q18) or a panel of another section. Its name is **KB** in every language (Q19).

### Two tiers, one shape

| | **Company KB** (the lead) | **Group KB** |
| --- | --- | --- |
| Owner | the **Master** account (the installation) | the **group** account |
| Who reads | everyone (read-only share) | members (membership is the grant) |
| Who writes | every member and every agent, **drafts only** | members and the group's agent, drafts only |
| Who approves | **administrators only** | **administrators only** |
| Created | at boot, as `ensureGlobalContacts` is | on first use, as `gilbert/chat` is |
| Store | `gilbert/knowledge/…` in the Master | `gilbert/knowledge/…` in the group |
| Access | a read-only Stalwart share (not a security boundary) | the reader's own JMAP session |

The two are the **same documents and the same surface**; only the owning account
differs. Both are **written** through the server route that acts as the Master
(Q1); they differ only in how a reader reaches them — the company KB through its
read-only share, because a reader is not a member of the Master's account, a
group's through the reader's own session, because membership reaches it. The
surface lists **Company** first, then one section per group the reader is in —
the contact sidebar's shape (Global contacts above the reader's books and the
groups').

### The lifecycle: one shared draft, an administrator approves

The owner has settled how a KB article moves from a change to in force. It is the
document-control core of this record, and it answers several of the questions
below.

- **An article has at most one unapproved draft, and everyone edits it.** Users
  and agents alike write and modify the same draft — multi-edit by everybody —
  rather than opening a competing draft of their own. A second intent is an edit
  of that draft, not a second document.
- **A change request carries who asked for it.** The request that produces a
  change — a person's instruction or a plan — names the requester, and that
  attribution is shown only to them; a paragraph edited inside the one shared
  draft is not a record of its own.
- **Gilbert writes in its own right or on behalf of a person.** An agent's write
  is Gilbert's own; a member's is on behalf of that member, and what was written
  on a person's behalf is theirs to see.
- **Agents review the draft.** The fleet reads the draft and its neighbours and
  produces the review: inconsistencies, stale references, contradictions with
  what is in force. A review is a read that yields findings; it is not an
  approval.
- **Only an administrator approves.** Administrators are the single approval
  level. No member, and no agent, ever approves an article. The approver a
  revision records, and the instant of approval, are taken from the session the
  server authenticated and never from the request: the Master is the writer of
  every KB document (Q1), so the document is the only place an administrator can
  be named.
- **Approval issues the draft as a revision, with an effective instant.** The
  administrator approves and states the instant the revision takes effect — a
  UTC instant, shown in each reader's own timezone. An instant already passed
  puts it in force at once; a future one leaves it **pending**, and until then
  the previous revision stays in force and is what readers see — an article with
  no earlier revision is simply not yet in force. The pending revision and its
  instant are shown, never a hidden timer.
- **The previous revision stays in history as superseded.** Approving a new
  revision supersedes the one before it, which remains readable and is marked
  superseded. Nothing already issued is ever edited in place.
- **An article that was ever approved is retired, never deleted.** Withdrawing
  one keeps it, with its revisions, and marks it **retired**: it leaves the tree
  and is found only by a search that asks for retired articles, so it cannot
  confuse a reader. An article no approval ever touched is deleted outright.
  Retiring is an administrator's, like approving, and a retired article is not
  brought back: a change to it is a new article.

### Storage

- **One article is one folder**: `gilbert/knowledge/<title>/`, holding the single
  mutable `draft.json`, the immutable approved revisions (`revisions/<rev>.json`,
  each carrying its approval and effective instant), and which revision is in
  force — a revision approved with a future effective instant is recorded and
  pending until that instant, so the article can hold a pending revision beside
  the one still in force.
  The article's file name is its title; the tree is the FileNode tree (an article
  is a folder whose children are its sub-articles), so a listing carries titles
  without reading blobs. Nothing references an article by that title: a reference
  — a workorder's template, a link in another page — carries the **id**.
- **The document shape**, one definition in `@gilbert/shared/knowledge` read by
  both tiers: the draft and a revision carry the same fields — identity and
  metadata (id, title, tags, created/updated, author), the editor's `blocks` (the
  source of truth for the rich body) and a denormalised `text` for search and for
  agents — and a revision adds what issuance records (the administrator who
  approved it, the approval instant, the effective instant, and the revision it
  supersedes). Neither the search index nor an agent's read has to understand the
  editor's format.
- **There are no attachments.** A procedure is formatted text blocks and nothing
  else, so a revision snapshots the whole document and nothing can change under
  it.
- **Who owns a page** follows the account it is created in, never a `shareWith`
  written later (`gilbert-groups`).

### Editor

Adopt a block editor rather than extend the composer's editor
(`docs/adr/0029`). **BlockNote** is the
choice: it is a ready-made Notion-style block editor (slash menu, drag
handles, block types) on ProseMirror/TipTap with Yjs built in, React 19 ready,
and its core is MPL-2.0 (compatible with an AGPL application). TipTap and Plate
are the alternatives if more control or a different UI system is wanted.

### Agents

- A new lookup kind (`knowledge`) in the closed catalogue: list/search pages and
  read one page's text, in the group's own account and in whatever the reader is
  shared. The notebook stays the distilled head; the KB is a tail read
  (`docs/adr/0006`, `docs/adr/0020`).
- A write capability (create/update a page) under the appropriate area. Writing
  the **company** KB from a group agent means acting as the Master, which is the
  privileged door again — **Q15**.

### Search

**Orama** (Apache-2.0), in-process, over the pages' `text`, used by the human
search box; the fleet's `knowledge` lookup reads the same `text` without Orama,
so the two share a corpus rather than a ranking. The index is built
from Stalwart and, because the container is disposable, is either rebuilt lazily
or cached as a document — **Q14**.

### Freshness

FileNode state changes ride the existing push rail (`docs/adr/0012`); nothing
polls. A write is broad (a `FileNode` wake cannot be narrowed to a folder), so
the client reads the change back and reconciles.

The company KB is read through a **share, which is not membership**: ADR 0016
serves a push subscription for the accounts the principal is a member of, so the
shared company KB is read **when it is opened** and no live update is promised. A
group's KB, read with the reader's own session, rides the push rail like any
other FileNode.

## Versioning

Stalwart keeps no history of a FileNode: an update replaces `blobId`/`type` and
the old blob is reclaimed by the server's GC. So **history must be written as
documents of its own**, and the cost is the `docs/adr/0012` cost: every revision
is a blob that is never given back. What that history is, and when it is written,
is the design question the lifecycle below settles.

The owner's lifecycle settles the shape: **a revision is minted at approval, not
at every save.** The single shared draft is the mutable copy; an administrator's
approval turns it into an immutable revision (the previous one becoming
`superseded`), so the number of stored revisions equals the number of issued
versions — proportional to intent, not to keystrokes. A snapshot per save and a
diff are therefore not needed: within a draft, multi-edit is the point, and the
draft is one document. The CRDT's own history is a question only if the
co-editing decision (Q13) wants it.

What is then true:

- **In-force and superseded revisions are kept for ever** — they are the
  controlled record, not history to prune (the distinction the ISO case forces).
- **An article that was ever approved is retired, not deleted** — kept with its
  revisions, hidden from the tree, found only by a search that asks for retired
  articles. The one exception is an article no approval ever touched, which is
  deleted outright: a draft nobody depended on is not the controlled record.
  Retiring is `requireAdmin`, like approving.
- **The draft is the one bounded thing**: one per article, replaced by the next
  revision on approval, so there is no per-save pile to bound.
- **A restore of a superseded revision opens a new draft** — by any writer
  permitted to draft — which an administrator then approves; history is never
  edited in place.

## Publication

"Public" is three different things and the owner's sentence ("some docs to make
public, like the ISO 9001 policies") may mean one, two or all three. They must be
decided separately because each has a different cost.

1. **Installation-wide** — every authenticated account reads it. This is the
   company KB's **read share** (ADR 0023's shape), and it is not "public" in the
   outside-world sense. The cheap one; largely already the design.
2. **Anonymous, no session** — a URL that resolves without signing in. **Not
   built, and Q7 settled it out:** it would be a new trust boundary — a route on
   gilbertserver serving account content to nobody-in-particular, outside the
   session door, with its own sanitisation, rate limiting and caching decision —
   and a record of its own is where to reopen it.
3. **Published and controlled** — the ISO 9001 sense, and the owner has settled
   it (the lifecycle section): one shared draft, edited by users and agents,
   reviewed by the fleet, then **approved by an administrator with an effective
   date**, which puts it in force (or records it as pending, until a future
   effective instant arrives); the revision it replaces stays in history as
   `superseded`. This is a document-control feature on top of the versioning
   above, not an access level.

The ISO case also implies: a stable identifier/permalink per controlled document,
an approver distinct from the author, and possibly a controlled-documents
catalogue page that lists what is currently in force — which is a document the
installation owns and administrators maintain.

Publication authority is settled: **administrators only**, through the ADR 0023
door. A separate "quality manager" grant does not exist and is not needed for
v1, because Gilbert administration is Stalwart administration plus the admin
marker (`docs/adr/0001`).

## The agent as document controller

The owner's further requirement is the one that makes the KB a controlled
document system rather than a wiki: the agent must **keep the policies aligned**,
**find inconsistencies**, **suggest improvements**, **change several documents
for one operator request**, and **submit the result for approval**. A model that
does this is a *document controller*, and it is where the KB earns its keep.

- **Alignment and inconsistency checking is a read.** A pass over the KB reads
  the pages and their `text` and looks for the failures a person misses:
  contradictions between two documents, a reference to a revision that has been
  superseded, a policy that should have changed when another did, a term used two
  ways, a citation of a document that no longer exists. It writes nothing, so it
  is safe to run; what it produces is **findings** — a prose proposal naming the
  pages and the revisions it was drawn from, never a silent change.
- **A multi-document change is a plan, built before it is written.** "Update
  every procedure that references policy X" becomes a plan document: for each
  page, the revision it was read at, the intended change and why. This is the
  folder-merge discipline of `docs/adr/0014` — the plan is built, collisions and
  pages moved since are detected, and only then is it applied, page by page,
  under `ifInState`. JMAP has no transaction across FileNodes, so a partial
  failure leaves the plan and the per-page outcomes recorded — never a
  half-changed set of documents nobody can account for.
- **Suggestions are the plan, not an edit.** "Suggest an improvement" is the same
  plan with a person free to accept, amend or drop it; nothing lands in place
  until a person or the policy says so.
- **Drafting is free; approval is the administrator's.** Users and agents write
  and modify the one shared draft directly, within the capability allowlist and
  the review policy; a change to what is in force is never an edit of the issued
  revision but an edit of the draft above it. When the draft is ready, approval is
  what issues it (the lifecycle section), through the same privileged door every
  other administrative write uses (ADR 0023, `docs/adr/0001`).
- **The catalogue grows, and stays closed.** A `knowledge` **read** (the lookup
  of the previous section) and **propose/apply** write capabilities, offered and
  bounded exactly like every existing action: the model chooses a kind and its
  parameters and never writes a query or a JMAP method (`docs/adr/0020`). "Check
  for inconsistencies" is such a read; "apply the plan" is such a write.
- **The account is the lock.** `ifInState` is whole-account, so a plan is applied
  in small conditional steps and retried, and it names the revisions it was built
  from: a page changed since the plan was made is refused rather than
  overwritten, and the plan says which page and why.
- **The agent is not the approver.** It drafts and reviews; **only an
  administrator approves and sets the effective instant**. An agent that could both
  draft and approve would collapse the separation ISO 9001 exists to keep.

## Questions, settled

Every question this record opened is settled below, with what the owner decided.
The record is **Proposed** until the owner accepts it.

1. **Who writes the company KB, and through which door?** — **Settled.** Every
   member and every agent writes and edits drafts, and only an administrator
   approves. Every **write** goes through a **server route that acts as the
   Master**: the route is the one place that knows whether the caller is an
   administrator — the live `requireAdmin` gate, which re-reads the account's own
   permissions on every call — which is what an approval is gated on, and it is
   the same door the workorder surface uses (ADR 0028). The company KB
   is **read** through a read-only Stalwart share on `gilbert/knowledge` — a
   reader is not a member of the Master's account, so the share is how every
   account reaches the folder without the read passing through the Master. A
   group's KB is read with the reader's own session, membership being the grant
   (the table above).
2. **Where does the company KB live — hidden or visible?** — **Settled: hidden.**
   `gilbert/knowledge` inside the app folder — the Master's account for the
   company's KB and each account's own for a group's — the app folder's name
   being the whole hiding rule, so no second rule is invented. The read share of
   question 1 has to grant read on `gilbert/knowledge` without exposing the rest
   of `gilbert/`, where `settings.json` lives — the question the wildcard share
   ADR 0023 already owes a probe for.
3. **Group KBs now or later?** — **Settled.** The same code built once, and both
   tiers ship together: the company KB and a group's KB in the same phase, not one
   after the other.
4. **Versioning shape** — **Settled.** A revision is minted at approval, not per
   save; the single draft is the mutable copy (the Versioning section).
5. **Retention** — **Settled.** In-force and superseded revisions are kept for
   ever (the controlled record); there is one draft per article, so nothing else
   accumulates.
6. **Restore/revert** — **Settled.** Restoring a superseded revision opens a new
   draft, by any permitted writer, which an administrator then approves; history
   is never edited.
7. **Does "public" include anonymous access?** — **Settled: no.** Installation-wide
   is the only sense of "public" the KB has; an anonymous surface would be a
   separate trust decision with its own record, and is not built.
8. **Who may publish/approve?** — **Settled.** Administrators only, with an
   effective instant. No separate quality-manager grant for v1.
9. **Is a lifecycle needed?** — **Settled.** One shared draft → agent review →
   administrator approval with an effective instant → in force (pending until
   that instant arrives, the previous revision still in force); the revision
   replaced stays as superseded.
10. **Immutability of an approved revision** — **Settled.** Never edited in
    place; the next change is a new draft, and the old revision becomes
    superseded.
11. **Attachments of a controlled document** — **Settled: there are none.** A
    procedure is formatted text blocks and nothing else, so an approval already
    fixes everything the article holds — there is no annex that can change under
    a revision.
12. **Editor** — **Settled.** **BlockNote**, the block editor the Editor section
    names, whose core is MPL-2.0.
13. **Real-time co-editing now or later?** — **Settled: later.** v1 saves the whole
    draft under `ifInState` with an honest conflict path, and says so on screen;
    the CRDT endpoint (Hocuspocus) and its checkpointing into Stalwart are the
    phase after. It is load-bearing: the single shared draft is multi-edited by
    everyone, so concurrent edits are the normal case, not the exception.
14. **Search index** — **Settled.** Lazy rebuild over the pages' `text` for v1; a
    cached document only if a real KB proves slow.
15. **May an agent write the KB?** — **Settled.** Agents read everywhere and
    write drafts everywhere (company and group); they never approve. A group
    agent's company-KB draft write goes through the same door the members' does
    (Q1).
16. **Does the company KB enter the model's context automatically?** — **Settled:
    no.** The KB stays a **lookup** — the tail, fetched by name and bounded — and
    the notebook stays the distilled head; the whole KB is never carried into the
    prompt (`docs/adr/0006`, `docs/adr/0020`).
17. **Structure** — **Settled.** A tree for navigation — the FileNode tree, an
    article a folder whose children are its sub-articles — plus **tags** for the
    sets that cut across it; backlinks are a later concern. References are by id,
    so reorganizing the tree breaks nothing.
18. **Are KB pages also visible in Files?** — **Settled: no.** The KB is its own
    surface, the way chat is not a folder of messages.
19. **Naming** — **Settled.** The surface is called **KB** in every language —
    the same two letters, never translated, the way the app's own name is not
    — while the identifier and the store path stay `gilbert/knowledge` (the
    four-block vocabulary). It is a term of art rather than English copy, so no
    catalog carries a translation of it and the label renders "KB" everywhere.
20. **Per-page restrictions inside the company KB** — **Settled: out of scope for
    v1.** Every member reads the whole company KB, and the record says so rather
    than implying a boundary that is not there.
21. **What may an agent do unattended?** — **Settled.** Read and draft, including
    the reviews; approval is an administrator's alone.
22. **When does the consistency pass run** — on change, on operator ask, or on a
    clock? — **Settled: on ask, in v1.** An operator or a rule asks and it runs.
    A pass triggered by a KB change is later work with its own cost, and a
    schedule is a separate decision again (`docs/adr/0012`).
23. **Where do findings and plans live** — as KB documents or as the fleet's
    job/decision documents? — **Settled.** In the fleet's **job/decision trail**,
    for provenance, with the plan text also attached to the review item a person
    sees.
24. **May one plan touch more than one owner** (the company KB and a group's) in
    a single request? — **Settled: no in v1.** A plan is one owner's: `ifInState`
    is per-account, so a cross-owner plan could not be atomic, and each owner's
    approval and door differ. Crossing owners is two plans, each approved by the
    administrator; a parent job that coordinates them is later work.
25. **Does approving a plan publish, or only write drafts?** — **Settled.**
    Approval is the act that issues the revision, with the effective instant; a plan
    produces draft changes that wait for an administrator's approval.
26. **Who may ask for a multi-document change** — any member, or an
    administrator? — **Settled.** Any member and any agent, since both write
    drafts; issuing the result is an administrator's.
27. **Is the agents' review a gate before approval, or advisory?** — **Settled:
    advisory.** The review informs the administrator and never blocks an approval,
    so a slow or failed review cannot strand a draft; a "review required" flag is
    the alternative if the process ever wants it enforced.

## What is not in it

- **A separate product or a second database.** The whole point is a feature
  inside Gilbert over Stalwart.
- **Meilisearch or Typesense.** A second service and a second store; Orama runs
  in-process.
- **Outline.** BSL 1.1, and its "Document Service" restriction conflicts with an
  enterprise product.
- **Extending the composer's editor.** A block document editor is a component
  to take off the shelf, not to grow by hand (`docs/adr/0029`).
- **Attachments.** A procedure is formatted text blocks; the KB holds no file
  beside a page, so there is nothing to freeze or version.
- **An anonymous Web surface.** The KB is installation-wide only (Q7); an
  anonymous surface would be a record of its own.
- **Per-user setup.** The company KB exists at boot and is shared automatically;
  no button, no step nobody asked for (`AGENTS.md`, automatic by default).
- **A QMS/ISO-9001 product or a workflow engine.** The shelf holds nothing
  embeddable for either, and each brings a database; document control is built on
  the KB and the fleet.
- **A second approval system.** A controlled-document change reuses the fleet's
  jobs, decisions and Approvals surface (`docs/adr/0003`).
- **More than one open draft of an article.** One unapproved draft at a time,
  edited by everyone; a competing change edits that draft rather than opening a
  second.

## Consequences

- One edit of the company KB changes what every reader sees, with nothing to
  republish — the ADR 0023 property.
- The KB is a rule the product keeps, not a security boundary: the app folder and
  its documents are readable and writable by whoever can write the account (an
  administrator with impersonation, the deployment's agent). Where a real
  boundary is needed — an anonymous or restricted page — the design says so and
  does not pretend.
- Versioning spends the finite blob budget, so it is bounded by decision, not by
  accident.
- A publication lifecycle adds state a reader must understand (which revision is
  in force), and the audit trail precedent (`docs/adr/0003`) is where "who
  published what, when" would live rather than in a new log.
- The company KB is read through a Stalwart share that reaches every account and
  has to expose nothing but `gilbert/knowledge`; a new account is a share kept
  current, the same debt Global contacts carries.
- The read share hands over the folder, not a rendered view: the unapproved draft
  and the per-change attribution are readable at the byte level by every account,
  and only the surface decides what to show. It is a product rule, not a
  boundary, like the rest of the app folder.

## References

- `docs/adr/0001` — the administration door and impersonation
- `docs/adr/0003` — the agent fleet: the notebook, the audit trail, the model
- `docs/adr/0005` — group chat: app-folder documents, group-owned, pushed
- `docs/adr/0006` — the two speeds of context (the notebook and the lookup)
- `docs/adr/0012` — a durable write is caused by a change, not by a clock
- `docs/adr/0013` — a dropped name is written over, in place
- `docs/adr/0014` — merging two folders is planned before it is written
- `docs/adr/0019` — the three levels of prose
- `docs/adr/0020` — a run may look something up
- `docs/adr/0023` — Global contacts: the installation-owned, shared, admin-written
  precedent
- `server/src/shared/appFolder.ts`, `web/src/lib/appFolder.ts` — the app folder
- `web/src/lib/chat.ts`, `web/src/store/chat.ts` — the group-document precedent
- `server/src/globalContactsAdmin.ts` — the Master-owned write door
- `server/src/agent/documents.ts`, `server/src/agent/llm.ts` — the notebook and
  the lookup catalogue
- `server/src/agent/documentFamily.ts` — the existing document reader
- `docs/research/agent-intelligence-ideas.md` — the fleet's open ideas
- `.opencode/skills/gilbert-stalwart/SKILL.md` — FileNode quirks and conditional
  writes
