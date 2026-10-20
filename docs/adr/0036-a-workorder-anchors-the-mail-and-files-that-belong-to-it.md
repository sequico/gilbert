# ADR 0036 — A workorder anchors the mail and the files that belong to it

Status: Proposed

Implementation: Partly built, and the built part is only the copying act.
`files.save` (`server/src/agent/tools/files.ts`) writes the bytes of an
attachment of a message, or of a document already in Files, into a visible
folder of the same account — type and bytes intact, and a name already taken in
the folder gets a numbered one beside it, so nothing a person filed is replaced.
The reference vocabulary and its member route are in the tree — `WorkorderRef`
with the kinds `folder`, `file`, `kb`, `message`, `chat` and `workorder`
(`server/src/shared/workorder.ts`), added and removed by id through
`POST /api/workorders/ref` (`server/src/routes/workorder.ts`) — but no client
surface writes or lists one: the panel's References card is a placeholder.
**Not built**, and each one is a decision below rather than a task: `tags` on
the document, `thread` among the ref kinds, the resolver that walks `replacedBy`,
the bind step in the pass the supervisor already makes (`server/src/agent/supervisor.ts`,
`server/src/agent/loop.ts`), a ref written by a composer, and a Workorders
section with a scoped file view and a scoped mail list.
Owed by any decision that is taken: that a thread's id stays the same id while
the conversation grows, and — if a decision asks the mail for a search — the
`Email/query` text filter verified against the mock and a live Stalwart.

## Context

A job's material is held apart, and nothing joins it. Its documents are folders
and files in Files, its checklist is a workorder (ADR 0024), and its mail is in
the mailbox. A person, or an agent asked to, walks the attachments into folders,
names them, handles a revision, and remembers where the last one went.

- **The copying act is not the problem any more.** `files.save` already takes an
  attachment out of a message and puts the bytes in Files, and takes a document
  from one place of Files to another. What is missing is not the move: it is
  **what chooses the destination**, and **what records that a conversation and a
  job are the same job's**.
- **No folder name carries the relation.** The product takes no position on how
  a group organises its mail — a group's mailboxes may be flat, one per year, one
  per supplier — and no mailbox is created for a workorder. So the name that used
  to let a reader infer the job ("the folder named after the booking") is not
  available on the mail side, and nothing else on the mail side says it either.
  `WorkorderRef` has `message` and `chat` beside `folder`, `file` and `kb`, and
  no writer writes one.
- **The scope is any business flow.** A booking number, a ticket, a claim, a
  purchase order, a project code: what the world writes into a subject differs,
  the shape does not. A design that names one of them has compiled one group's
  work into the product (ADR 0027).
- **A workorder can end and be replaced.** Its state is `replaced` with
  `replacedBy`, and the successor is a workorder of its own uid. The world keeps
  writing the old key, so a replacement must not break the join.
- **The surfaces hold the material apart, and a workorder is not one of them.**
  Mail, Calendar, Contacts, Files and KB are sections; a workorder is a panel
  launched from the top bar beside chat. Its files are in another section and its
  mail in a third.

The question this record leaves open: **does a workorder take its mail, and if
so, what binds a conversation to it?** A workorder that gathers only folders,
files, a KB page and a checklist needs no decision here — that is the tree
already, once the ref card is built.

## Decisions to take

### 1. Whether a workorder takes its mail at all

- **No.** A workorder gathers folders, files, KB pages and its checklist. Filing
  an attachment is the agent's act through `files.save`, under the group's own
  rule (ADR 0031) and within its surface matrix; a job's conversations stay in
  the mailbox, found the way any mail is found.
- **Yes.** A conversation is bound to a workorder and the workorder lists it, so
  a job's mail, files and checklist are seen in one place.

What "no" costs: the job's conversation is indistinguishable inside the mailbox,
and the relation is a model's judgement per message rather than a stored fact.
What "yes" costs: the binder and the surface in decisions 2–5.

### 2. Who binds a conversation, if it is bound

- **A declared key, matched deterministically** in the pass the supervisor
  already makes: no model turn, one read of one message, a pure comparison
  against what the workorders of that account declare.
- **The agent's judgement** on the change: it reads the message and proposes the
  binding, a person confirms it (ADR 0028), or the group's rule lets it act.
- **A person only**: no automatic binding, and the writer in the panel/reader.

The errors are asymmetric, and they argue for a declared key with an undoable
link: a thread left unbound costs nothing — its mail is mail, and it becomes the
workorder's the moment a person binds it or a later message carries the key —
while a thread bound wrongly puts another job's conversation and attachments in
front of a reader. It is removable, but it is the one mistake that costs trust.

### 3. If the key is a declaration, what a key is

The bundle below is one choice, and it is worth taking whole or not at all,
because each part exists for another:

- `tags: string[]` on the workorder — a job has more than one real key (a booking
  number and the containers it moves are both written in subjects), normalized
  by trimming and case folding.
- Three names, three jobs: `uid` is identity and is stable for ever, `name` is
  what a person reads, a `tag` is only the join key. A tag may be reused by a
  later job, and identity never rests on it.
- **At most one non-terminal workorder carries a given tag** in an account: two
  open workorders claiming the same key is a refusal, not a tie to break.
- A tag matches as a **token, not a substring**, in the message's subject, its
  participants or its text body, quoted text included: the characters on either
  side are not alphanumeric. `279726936` matches `MS2 279726936 5X20 Ennore SD`
  and not `2797269361`. A key written in two spellings is declared twice; a tag
  too short to be a token is refused when the workorder is written, because it
  would match the world. Nothing is looked for inside an attachment.
- The write that moves a workorder to `replaced` copies its tags to the
  successor, and the resolver walks `replacedBy` to the first workorder whose
  state is not terminal. A predecessor keeps its tags as history and is never
  matched.
- A key that resolves to nothing is **not bound**: the fact is recorded in the
  run document (ADR 0030) and the group's rule (ADR 0031) or a person decides
  what it means. There is no policy field for it, and a terminal workorder never
  grows material silently.

The alternative is one key per workorder, matched the same way, and a second
workorder for a second key.

### 4. Where the relation is stored

- **One ref of kind `thread` on the workorder.** Every message in the
  conversation — received, still to arrive, sent later — is the job's from then
  on, and a reply inherits because the server keeps threading it. A `message` ref
  is written only where the job is about that one message and not its
  conversation.
- **A ref per message**: precise, and a list to keep in step for ever.

A ref is an id, so a rename, a move or a correction of the key leaves it valid.
**No keyword is written on the message by the binder**: the same fact in two
stores is the first thing to drift, and the mail side has no writer to keep the
pair together. A keyword a reader sets is the reader's own label.

### 5. Whether the workorder becomes a section

- **Yes, a section** of the navigation between Contacts and Files: the job's own
  files (the Files view scoped to its folder), its own mail (read from its
  `thread` refs, one conversation listed once) and its checklist beside them,
  with a composer opened inside it so the message is bound from the moment it
  exists. The checklist launcher stays in the top bar. Nothing new is built to
  draw it: the same Files view, the same reader, the same checklist.
- **No, the panel stays the door** and lists refs only: no scoped views, no
  composer of its own, no second place to read mail or files.

The section is the one consumer that makes refs a load — a few hundred thread
refs stay a read of tens of kilobytes; at thousands the shape is revisited with
an index, never with a mark scattered over the mail. Without it, refs are stored
and never seen.

### 6. Where an attachment lands, and what its name is

- A workorder has one folder in Files, referenced as `folder`, created on the
  first arrival. Files land at its top level, named after the source and the day
  it arrived.
- `files.save` gives a numbered name when the name is taken, rather than
  refusing. A binder that files the same attachment twice therefore writes
  `invoice (2).pdf`; idempotence rests on the ref check — a conversation the
  workorder already refs is not worked again — and never on the path. Whether
  numbering is the right outcome for a binder-written document, or the binder
  should compute a path and refuse a collision, is part of this decision.
- **Flat, with no facets and no layout.** A path is a projection, and a nested
  layout is a later record that moves nodes without touching a ref. Nothing here
  introduces a template language.
- The folder is not hidden from Files: it is shared by node, mirrored by whatever
  mirrors the account, and findable by a reader who does not know the key.

## Consequences

- **The mailboxes stay the reader's.** A folder per year, per topic, per supplier
  or none at all: nothing above creates, moves or empties a mailbox, and a Sieve
  rule the reader keeps filing with goes on working.
- **Files remains the only store of bytes.** A workorder's tree, if decision 5
  takes it, is composed from refs each time it is drawn: nothing is copied into
  it and nothing is stored twice. A workorder's own document and the closed
  registry stay under `workorders/` in the app folder (ADR 0024), and checklist
  templates stay the KB's (ADR 0020).
- **Provenance is the run, not the node.** `FileNode` carries no author and no
  backlink and the message carries no mark, so an automatic filing is
  attributable through the run document that performed it (ADR 0030), and a
  person's filing through the same writer.
- **Not every flow's unit is a workorder.** A periodic archive — a year, a month,
  a supplier — is a folder and a view, with no key, no ref and no binder.
- Not this record, whatever is decided: a mail folder as a filestore; a mailbox
  created per workorder; a Sieve rule as the binder; materialising a workorder at
  close; a keyword written on the message; a policy field for a key that has
  ended; a path template or a facet layout; a question asked at send; and any
  design that rests on a blob outliving its message before that is established.
