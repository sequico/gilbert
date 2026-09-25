# ADR 0025 — The knowledge base

Status: Proposed

Implementation: Not built.

> **This record is a working notebook, not yet a decision.** The owner asked for
> the findings, the design as it stands and every open question to be written
> down before any code exists. It is rewritten in place as the questions in
> **Open questions** are answered, and it becomes a decision record when the
> owner accepts it. `Implementation: Not built.` is literal: there is no code.

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
  (`server/src/globalContactsAdmin.ts`, `docs/adr/0024`). The exact Stalwart
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
- **The composer's editor is hand-rolled.** `web/src/views/compose/RichEditor.tsx`
  is a `contenteditable` with a custom toolbar (`execCommand`-style) — precisely
  the kind of component the owner does not want to write again. It is not a
  candidate to extend into a document editor.
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

## The design as it stands

Not accepted, and each point below has a question in **Open questions**. It is
written down so the questions have something to point at.

### Two tiers, one shape

| | **Company KB** (the lead) | **Group KB** |
| --- | --- | --- |
| Owner | the **Master** account (the installation) | the **group** account |
| Who reads | everyone (universal share) | members (membership is the grant) |
| Who writes | **open question Q1** | members |
| Created | at boot, as `ensureGlobalContacts` is | on first use, as `gilbert/chat` is |
| Store | `gilbert/knowledge/…` in the Master | `gilbert/knowledge/…` in the group |
| Access | a Stalwart share (not a security boundary) | the reader's own JMAP session |

The two are the **same documents and the same surface**; only the owning account
differs. The surface lists **Company** first, then one section per group the
reader is in — the contact sidebar's shape (Global contacts above the reader's
books and the groups').

### Storage

- **One document per page**: `gilbert/knowledge/<id>/page.json`, a JSON document
  through the shared serializer (`@gilbert/shared/appDocument`). The page's file
  name is its title; the hierarchy is the FileNode tree (a page is a folder whose
  children are its sub-pages), so a listing carries titles without reading blobs.
- **The document shape**, one definition in `@gilbert/shared/knowledge` read by
  both tiers: identity and metadata (id, title, tags, created/updated, author),
  the editor's `blocks` (the source of truth for the rich body), and a
  denormalised `text` for search and for agents — so neither the search index nor
  an agent's read has to understand the editor's format.
- **Attachments** are blobs in the account's Files, referenced from the page;
  the KB does not invent a second blob store.
- **Who owns a page** follows the account it is created in, never a `shareWith`
  written later (`gilbert-groups`).

### Editor

Adopt a block editor rather than extend `RichEditor.tsx`. **BlockNote** is the
recommendation: it is a ready-made Notion-style block editor (slash menu, drag
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

**Orama** (Apache-2.0), in-process, over the pages' `text`, used by both tiers so
the human search box and the agent lookup rank the same way. The index is built
from Stalwart and, because the container is disposable, is either rebuilt lazily
or cached as a document — **Q14**.

### Freshness

FileNode state changes ride the existing push rail (`docs/adr/0012`); nothing
polls. A write is broad (a `FileNode` wake cannot be narrowed to a folder), so
the client reads the change back and reconciles.

## Versioning

Stalwart keeps no history of a FileNode: an update replaces `blobId`/`type` and
the old blob is reclaimed by the server's GC. So **history must be written as
documents of its own**, and the cost is the `docs/adr/0012` cost: every revision
is a blob that is never given back. The question is not "should there be
history" but "**how much, and written when**".

The shapes on the table:

- **(a) A snapshot per save.** The head `page.json` carries `rev`; a save writes
  an immutable `history/<rev>.json` first, then updates the head under
  `ifInState`. Simple, robust (an orphan revision after a crash is harmless), and
  every revision is readable by a fixed name. Cost: one blob per save.
- **(b) Diffs.** Smaller storage, but it needs a diff/merge over a block tree —
  more code and a new class of bug, which is the thing the owner asked to avoid.
- **(c) Named revisions only.** History is written when a person marks or
  publishes a version, not on every save. Fewest blobs; no "what did it look like
  at 14:03", which is usually not what an enterprise document needs anyway.
- **(d) The CRDT's own history.** Yjs carries snapshot/state APIs, but they are
  not a user-facing revision list and would tie the history to the co-editing
  decision (**Q4**).

Whichever shape: **retention must be bounded** — an unbounded per-save history is
the periodic-write hazard of `docs/adr/0012` in a different costume. The audit
trail's monthly window is a precedent for bounding by time; bounding by count
("the last N drafts") is the alternative. A distinction the ISO case forces:
**approved revisions are not history to prune, they are the controlled record**
— what is bounded is drafts, not issued versions.

Other versioning facts the questions must settle: who may restore an old
revision (a restore is an ordinary save of older content, under `ifInState`), and
whether a restore is itself a new revision (it should be — history that can be
rewritten is not history).

## Publication

"Public" is three different things and the owner's sentence ("some docs to make
public, like the ISO 9001 policies") may mean one, two or all three. They must be
decided separately because each has a different cost.

1. **Installation-wide** — every authenticated account reads it. This is the
   company KB's **read share** (ADR 0024's shape), and it is not "public" in the
   outside-world sense. The cheap one; largely already the design.
2. **Anonymous, no session** — a URL that resolves without signing in. This is a
   **new trust boundary**: a route on gilbertserver that serves account content
   to nobody-in-particular, outside the session door, with its own sanitisation
   (the strict CSP and `web/src/lib/html.ts` exist), rate limiting, and a
   decision about search engines and caching. Attachments are worse: a JMAP blob
   URL is session-authenticated, so a public page's images would have to be
   streamed through a public route too. **Q7**.
3. **Published and controlled** — the ISO 9001 sense. A page has a lifecycle
   (`draft` → `in review` → `approved` → `obsolete`), an author and an approver,
   an effective date, and a **revision that is frozen once approved**. Issuing a
   new revision supersedes the old one, which stays readable and is marked
   superseded, never edited. This is a document-control feature on top of the
   versioning above, not an access level, and it is probably what "ISO 9001
   policies" actually asks for. **Q9–Q11**.

The ISO case also implies: a stable identifier/permalink per controlled document,
an approver distinct from the author, and possibly a controlled-documents
catalogue page that lists what is currently in force — which is a document the
installation owns and administrators maintain.

Publication authority is its own question: an installation administrator (the
ADR 0024 door, ready now), or a "quality manager" grant that does not exist yet
because Gilbert administration is Stalwart administration plus the admin marker
(`docs/adr/0001`) — **Q8**.

## Open questions

Each with a recommendation, to be answered by the owner. These are the reasons
this record is Proposed.

1. **Who writes the company KB?**
   (A) administrators only, the exact ADR 0024 door; (B) any member through a
   server route that acts as the Master — same door, broader authorisation, a new
   trust decision; (C) any member through a read-write Stalwart share on the
   folder, their own session, no privileged door. *Recommend C if the share holds
   under a live probe (the ADR 0024 wildcard-share probe is already owed), else
   B; A is the fallback if the company wants an issued-documents-only KB.*
2. **Where does the company KB live — hidden or visible?** `gilbert/knowledge`
   inside the app folder (consistent with chat; keeps raw JSON out of Files) or a
   visible `Knowledge` folder in the Master's Files. *Recommend hidden, with a
   probe that a share on the nested folder grants read without exposing
   `gilbert/` (where `settings.json` lives).*
3. **Group KBs now or later?** The owner wants both, the company one as lead.
   *Recommend the same code built once, company first; group scope in the phase
   after.*
4. **Versioning shape** — snapshot-per-save, named revisions, or CRDT history?
   *Recommend named revisions for v1 (a save overwrites the head; "mark a
   revision"/publish writes one), which keeps blob cost proportional to intent,
   with snapshots-per-save a later option if the need is proven.*
5. **Retention** — how long are drafts kept, how many revisions, and are approved
   revisions kept for ever? *Recommend: approved revisions for ever (they are the
   record); drafts bounded by count and age.*
6. **Restore/revert** — who may restore, and is a restore a new revision?
   *Recommend administrators may restore a published document, any writer a
   draft; a restore is always a new revision.*
7. **Does "public" include anonymous access?** *Recommend no for v1 —
   installation-wide only; an anonymous surface is a separate trust decision with
   its own ADR if it is ever wanted.*
8. **Who may publish/approve?** An installation administrator, or a new
   quality-manager grant? *Recommend administrators for v1; a grant is a separate
   decision.*
9. **Is a lifecycle needed** (draft/review/approved/obsolete, author, approver,
   effective date), or are "version + published flag" enough? *Recommend the full
   small lifecycle if ISO 9001 is a real requirement; otherwise version +
   published.*
10. **Immutability of an approved revision** — never edited in place; superseding
    creates a new revision and marks the old. *Recommend yes.*
11. **Attachments of a controlled document** — frozen with the revision, or
    referenced live? *Recommend frozen with the revision (a controlled document
    whose annex can change under it is not controlled).*
12. **Editor** — BlockNote, TipTap or Plate? *Recommend BlockNote.*
13. **Real-time co-editing now or later?** It needs a CRDT endpoint on the
    server (Hocuspocus) and a checkpoint design into Stalwart. *Recommend a later
    phase; v1 saves the whole document under `ifInState` with an honest conflict
    path.*
14. **Search index** — rebuild lazily from Stalwart, or cache a serialised Orama
    index as a document? *Recommend lazy rebuild for v1; cache only if a real KB
    proves slow.*
15. **May an agent write the KB, and the company KB?** A group agent acts as the
    group; the company KB needs the Master door. *Recommend read (lookup) for
    all, write to the group's own KB from its agent, company-KB writes through
    the same door the members' writes use (Q1).*
16. **Does the company KB enter the model's context automatically?** The
    three-level prose of `docs/adr/0019` and the notebook are the head; the KB is
    a lookup. *Recommend the KB stays a lookup (the tail), never wholesale — the
    `docs/adr/0006` two-speed rule.*
17. **Structure** — tree, tags, backlinks, or a mix? *Recommend tree (FileNode)
    plus tags; backlinks are a later concern.*
18. **Are KB pages also visible in Files?** *Recommend no: the KB is its own
    surface, the way chat is not a folder of messages.*
19. **Naming** — folder `gilbert/knowledge`, UI label "Knowledge", the four-block
    vocabulary. *Recommend exactly that; strings go through `gilbert-i18n`.*
20. **Per-page restrictions inside the company KB** (a restricted annex to an
    otherwise public policy)? A universal folder share is all-or-nothing, so this
    would need per-node shares or a client rule. *Recommend out of scope for v1;
    say so rather than imply a boundary that is not there.*

## What is not in it

- **A separate product or a second database.** The whole point is a feature
  inside Gilbert over Stalwart.
- **Meilisearch or Typesense.** A second service and a second store; Orama runs
  in-process.
- **Outline.** BSL 1.1, and its "Document Service" restriction conflicts with an
  enterprise product.
- **Extending `RichEditor.tsx`.** A block document editor is a component to take
  off the shelf, not to grow by hand.
- **An anonymous Web surface** unless Q7 is answered yes, which would need its
  own record.
- **Per-user setup.** The company KB exists at boot and is shared automatically;
  no button, no step nobody asked for (`AGENTS.md`, automatic by default).

## Consequences (of the shape as it stands)

- One edit of the company KB changes what every reader sees, with nothing to
  republish — the ADR 0024 property.
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
- The company KB is one more thing a deployment's admin group cannot read as
  members; the surface must degrade to "not shared yet" rather than to a
  permission error, the way Global contacts does.

## References

- `docs/adr/0001` — the administration door and impersonation
- `docs/adr/0003` — the agent fleet: the notebook, the audit trail, the model
- `docs/adr/0005` — group chat: app-folder documents, group-owned, pushed
- `docs/adr/0006` — the two speeds of context (the notebook and the lookup)
- `docs/adr/0012` — a durable write is caused by a change, not by a clock
- `docs/adr/0013` — a dropped name is written over, in place
- `docs/adr/0019` — the three levels of prose
- `docs/adr/0020` — a run may look something up
- `docs/adr/0024` — Global contacts: the installation-owned, shared, admin-written
  precedent
- `server/src/shared/appFolder.ts`, `web/src/lib/appFolder.ts` — the app folder
- `web/src/lib/chat.ts`, `web/src/store/chat.ts` — the group-document precedent
- `server/src/globalContactsAdmin.ts` — the Master-owned write door
- `server/src/agent/documents.ts`, `server/src/agent/llm.ts` — the notebook and
  the lookup catalogue
- `server/src/agent/documentFamily.ts` — the existing document reader
- `.opencode/skills/gilbert-stalwart/SKILL.md` — FileNode quirks and conditional
  writes
