# ADR 0036 — A workorder anchors the mail and the files that belong to it

Status: Accepted

Implementation: Not built.
What the tree will carry: `tags`, `facets` and `layout` on `WorkorderDoc`
(`server/src/shared/workorder.ts`) with their validators and the replacement
carrying the tag list; the resolver that walks `replacedBy` and answers the
non-terminal workorder a message belongs to; `files.attach` in the agent's
catalogue (`server/src/agent/tools/files.ts`, over `downloadBlob` and
`writeBytesIntoVisibleFolder`); `workorder.ref` beside the existing workorder
tools (`server/src/agent/tools/workorders.ts`); and the bind step in the pass
the supervisor already asks for (`server/src/agent/supervisor.ts`,
`server/src/agent/loop.ts`), reported in the run record (ADR 0030). In
**gilbertmailer**: the **Workorders** section beside Contacts and Files, the
Files view scoped to a workorder's folder, the mail list scoped to its message
refs, and the mail reader drawn flat. Owed: the `Email/query` text filter
verified against the mock and against a live Stalwart, and the facet extraction
a layout needs.

## Context

A group keeps a workorder as a hand-made tree of folders and files in Files, and
the mail that belongs to it in a mailbox, and keeps the two in step by hand: a
person, or an agent asked to, walks the attachments into folders, names them,
handles a revision, and remembers where the last one went.

Four facts about that shape decide this record.

- **The relation lives in the path.** A folder named after the booking is how a
  reader knows that a message and a document are the same job's. Nothing else
  says so: the workorder's document has the vocabulary already — `WorkorderRef`
  names `folder`, `file`, `kb`, `message`, `chat` and `workorder` (ADR 0024) —
  but no writer writes a ref, and the agent's catalogue cannot copy a blob into
  Files at all (`files.write` and `files.overwrite` take text). A relation kept
  in a name breaks the moment the name changes, and a flow whose unit is not a
  folder tree cannot express it at all.
- **The scope is any business flow.** A booking number, a ticket, a claim, a
  purchase order, a project code: what the world writes into a subject differs,
  the shape does not. A design that names one of them has compiled one group's
  work into the product (ADR 0027).
- **A workorder can end and be replaced.** Its state is `replaced` with
  `replacedBy`, and the successor is a workorder of its own uid. The world keeps
  writing the old key, so a replacement must not break the join.
- **The product's surfaces hold the material apart, and a workorder is not one
  of them.** Mail, Calendar, Contacts, Files and KB are sections; a workorder is
  a panel launched from the top bar beside chat. A job's mail is in one section,
  its files in another, its checklist in a third, and nothing on any of them
  says which job it is except a folder name. The same holds inside mail: a
  mailbox per project repeats what one reference would say, and on a group's
  account a mailbox grants nothing that group membership does not already grant
  (ADR 0004).

What is wanted: a workorder is where its own work is seen and done — its mail,
its files, its checklist — the filestore stays aligned with the mail that
belongs to it with no one carrying anything by hand, and every link can be
followed, audited and undone.

## Decision

**A workorder is the anchor. Mail and files point at it; nothing points at a
folder name.**

### The world's key is a tag, and it is a list

- A workorder declares `tags: string[]` — the keys the world uses for that job,
  normalized (whitespace trimmed, case folded) before anything is compared. The
  list is a list because a job has more than one real key: a booking number and
  the containers it moves are both written in subjects, and both must resolve.
- Three names, three jobs, and they are not interchangeable: `uid` is the
  internal identity and is stable for ever; `name` is the label a person reads;
  a `tag` is only the join key between the world and the workorder. A tag may be
  reused by a later job — identity never rests on it.
- **At most one non-terminal workorder carries a given tag** in an account. Two
  open workorders claiming the same key is a refusal, not a tie to break.

### Replacement carries the tags

- The write that moves a workorder to `replaced` copies its tags onto the
  successor, so a message arriving with the old key still resolves.
- The resolver walks `replacedBy` from the tagged document and answers the first
  workorder whose state is not terminal. A predecessor keeps its tags as
  history and is never matched.

### The link is a ref, and it is the only home of the fact

- The binder writes a `WorkorderRef` of kind `message` for a message it files,
  and of kind `file` for a document that lives outside the workorder's folder.
  The folder itself is one `folder` ref: what is inside it is the workorder's by
  containment, so no ref per file is written for it.
- **No keyword is written on the message by the binder.** A mark on the mail
  beside a ref on the workorder is the same fact in two stores, and the pair is
  the first thing to drift; the mail side has no writer of its own to keep them
  together. A keyword a reader sets on a message is the reader's own label and
  is not this record's business.
- Refs are ids. A rename, a move to a facet subtree, or a correction of the key
  leaves every ref valid and untouched.

### The binder is deterministic, and it lives in the pass that already exists

- For each change the supervisor's pass already reads, **before** the prose rules
  are offered the change: for every non-terminal workorder of that account, if
  the message carries one of its tags, its attachments are written into the
  workorder's folder and the refs are written. No model turn is spent on a
  relation the declaration already answers.
- **It is idempotent by the ref**: a message the workorder already refs is not
  worked again, so a pass that re-reads a change it did not finish writes
  nothing twice. The same function is the reconciliation — a pass is the retry,
  and no separate repair job is introduced.
- Nothing runs on a clock (ADR 0010): the wake-up is the account's own change.

### What the binder does not decide

- A message whose tag resolves to nothing — no workorder, or a terminal one with
  no non-terminal successor — **is not bound**. The fact is recorded in the run
  document (ADR 0030) and the group's own rule in prose (ADR 0031) or a person
  decides what it means: a key reused by a later job, a supplier answering after
  the close, a practice wrongly closed.
- **There is no policy field for it.** An exception belongs to the flow that has
  it, written as a rule, in force at the next pass and without a release. A
  workorder is never reopened and a terminal one never grows material silently.

### The copying act is one tool

- `files.attach(messageId, attachment, path)` writes the bytes of an attachment
  of this account's own mail into a visible folder of this account: type and
  bytes intact, and a path that already holds a document is refused, the rule
  `files.write` already keeps.
- The bytes are **copied**. A file node may only point at a blob its own account
  holds, and whether a blob a node references survives the destruction of the
  message that brought it is not established: the pointer is an optimisation
  behind this tool's interface and the interface does not assume it.
- A person makes the same link by hand from the mail reader — the same writer,
  with the workorder named instead of resolved — so the automatic and the manual
  path cannot disagree about what a link is.

### A workorder is a section, and its tree is composed

- **Workorders is a section** of the navigation, between Contacts and Files: the
  place a job's whole material is seen and worked. The checklist launcher stays
  in the top bar, so a step can be settled from anywhere in the product; the
  section is not the only door to it.
- **Its tree is logical.** An entry is a reference to where a thing lives —
  a `FileNode` folder or file, a message and its attachments, a KB page — and the
  tree is assembled from the refs each time it is drawn. Nothing is copied into
  it and nothing is stored twice.
- **The documents themselves are physical, in two places, and neither is the
  workorder's tree.** A workorder's own document — its shape, its state, its
  checklist's state (ADR 0026) — and the closed registry live under `workorders/`
  in the account's `gilbert` app folder, which Files hides (ADR 0024). Checklist
  **templates** stay the KB's (ADR 0020). A job's business documents live in the
  Files folder the workorder references, and that folder is what the section's
  file tree shows: the same nodes, one place, two doors.
- **Running and archived** are the two lists of the section, read from the same
  registry: an archived workorder is one whose state is terminal, and it is
  still opened, searchable and followable.
- **Nothing new is built to draw it**: the Files view scoped to a workorder's
  folder, the mail list scoped to the refs of kind `message`, the checklist
  beside them. No second file manager, no second reader, no second search.

### A group's mail is flat

- A message is in one of three places — **Inbox**, **Sent**, **Archive** — and
  what it is *about* is a reference to a workorder, never a mailbox. Grouping by
  year, by sender or by any other criterion is a **view** over keywords, dates
  and refs, and it is never a tree the reader maintains.
- **The product creates no mailbox for a workorder.** A mailbox per project
  repeats a relation a ref already states, and the second copy of the relation is
  the one that goes wrong.
- **Privileges do not come from mailboxes.** A group's mail is the group's
  account and membership is the boundary (ADR 0004); a tree of mailboxes grants
  nothing that the account does not.
- **The existing tree is flattened by hand, as the owner assigns messages to
  workorders**, once the shape has proven itself. Nothing is migrated
  automatically, no folder is moved by a pass, and the product simply stops
  adding to the tree.
- The shape forces three changes to what is built over mail, and they are
  consequences rather than separate decisions: a Sieve rule **labels** a message
  instead of filing it into a mailbox; **archive by date** becomes a view over a
  keyword and the received date; **emptying** is a message-level act on Trash or
  Archive, not a mailbox operation. A client that expects a tree — IMAP, a
  phone — sees three mailboxes, and that is the accepted cost.

### The folder is a container, never an identity

- A workorder has one folder in Files, referenced by it as `folder`. The binder
  creates it on the first arrival from the workorder's own fields and finds it by
  the ref afterwards.
- Files land at its top level, named by the binder: the attachment's own name and
  the day it arrived. **A facet layout may later nest them** — `facets` on the
  document (`{ container: "…", year: "…" }`) and an ordered `layout` naming the
  levels — because identity is in the refs and moving a node keeps its id, its
  sharing and its place in every reference. The path is a projection that can be
  recomputed, not a commitment.
- No template language is introduced for it: a layout is an ordered list of
  facet names, never a string with a syntax.
- The folder is not hidden from Files. It is shared by node, mirrored by whatever
  mirrors the account, and findable by a reader who does not know the workorder's
  key; hiding it would take all three away and buy nothing, because the section
  draws its own tree from the refs.

## Consequences

- **A job is worked in one place.** Its mail, its files and its checklist are
  the Workorders section, while mail, Files and KB remain the surfaces for
  everything that belongs to no job — a general inbox, a shared folder, a page.
- **A workorder's mail is a query, not a mailbox.** A mail folder per workorder
  disappears from the practice, and with it the second tree to keep in step.
- **A workorder's files stay a folder**, because bytes need a container, a
  handover and an external mirror need a tree, and because a node has one parent
  — every other order is a query in the section, not a second tree.
- **Alignment is a stored fact, so it can be audited and undone**: the ref names
  the message and the workorder; removing it un-legates the material and leaves
  the bytes where they are.
- **Provenance is the run, not the node.** `FileNode` carries no author and no
  backlink, and the message carries no mark, so an automatic filing is
  attributable through the run document that performed it (ADR 0030), and a
  person's filing through the same writer.
- **Not every flow's unit is a workorder.** A periodic archive — a year, a month,
  a supplier — is a folder and a view, with no tag, no ref and no binder; forcing
  one would be the first thing to make the system unwelcome.
- **The section is what makes refs a load.** It is the first consumer that lists
  a workorder's whole mail, and that list is the document's refs: a few hundred
  add up to a read of tens of kilobytes. At thousands the shape is revisited with
  an index, never with a mark scattered over the mail.
- **The cost of a tag the resolver cannot see**: a key written only inside a
  document that arrives as a PDF attachment is not matched by any filter, and
  that message reaches the prose rule and a model turn.
- Not built, and deliberately so: a mail folder as a filestore; a mailbox created
  per workorder; a Sieve rule as the binder; materialising a workorder at close;
  a keyword written by the binder on the message; a policy field for a key that
  has ended; a path template; an automatic flattening of existing mail; and any
  design that rests on the blob outliving its message before that is established.
