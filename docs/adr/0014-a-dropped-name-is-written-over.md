# ADR 0014 — A dropped name is written over, in place

Status: Proposed

Implementation: Built. A drop writes into the node that holds the name,
identified by the create's own `alreadyExists` refusal
(`web/src/lib/dropUpload.ts`, `web/src/lib/filenode.ts`).

## Context

A file lands in Files under a name, and every folder refuses a second node of a
name it already holds: `FileNode/set` answers `alreadyExists` unless the request
opt-outs with `onExists` (`find_sibling_collision`,
`crates/jmap/src/file/set.rs`, 0.16.21). So what a write does when the name is
taken is a decision this client has to make somewhere, per writer.

The gesture that made it visible is the one that carries a tree: a folder
dropped from the desktop. A drop is resolved folder by folder, and the folders
are reused when they are already there — a second drop of the same tree
therefore resolves into the *same* folders, where every file meets a sibling of
its own name. Refusing those turned a repeatable gesture into a page of
refusals, and duplicating them (which the folder walk would have had to do to
keep them apart) is not what a copy of a tree means.

Three properties of the server decide what the alternatives cost:

- **The refusal names the node.** `existingId` is the id of the sibling holding
  the name, present whenever that node was committed before this request
  (`tests/src/jmap/files/node.rs` asserts both halves). It is what a
  replacement needs, and it is the only thing that knows the name: `FileNode`
  has no name filter, and the account read this client makes first is a page on
  an account past a thousand nodes, on which the name may not appear at all.
- **Content is an update, not a create.** `blobId`, `type` and `size` are
  written into an existing node — the same three the editor writes when it
  saves over a file — and a blob is uploaded before either. `FileNode/set`
  returns no `blobId` on create, so a create-then-point write is two calls
  where an update is one.
- **A replaced blob is unreferenced, not deleted,** and JMAP offers no way to
  delete one; the server's GC reclaims it. An upload is charged and never
  refunded (ADR 0013), which is what makes an unnecessary one worth avoiding
  and a necessary one worth paying.

## Decision

**A name the folder already holds is written over, in place — for a file. A
folder is never written into.**

- **A drop and a picker selection replace.** Both go through one writer
  (`putFile` in `web/src/store/files.ts`), which uploads the bytes, creates the
  node, and on `alreadyExists` writes the bytes into the node the refusal named.
  The node keeps its id, its `shareWith`, its `created` and its place in the
  tree; only `blobId`, `type` and `size` change. Nothing is destroyed and
  re-created, so nothing that referred to the file — a share, a chat message
  pointing at it, a composer attachment — is invalidated by a name landing on it.
  No `name` is in that update, which matters beyond tidiness: a real 0.16 runs
  the sibling-collision check on its update path too (`crates/jmap/src/file/set.rs`,
  `update` branch — the one place the mock deliberately does not reproduce it,
  `server/src/mock/index.ts`), and a patch that carried a name could be refused
  for colliding with the very node it is writing into.
- **Saving an attachment into Files still refuses.** `uploadTo`, and the dialog
  behind "save to Files", reports a name the folder already holds and touches
  nothing: a file somebody keeps is not a save's to overwrite. These are two
  intents, not one, and they are told apart by the caller — the choice is an
  argument of the one writer, not a mode of the store.
- **A folder stops a file.** The create's refusal is what says what holds the
  name, so the node is read (`nodeType`) before it is written into: a
  `directory` is refused with the same sentence a taken name has always had.
  Renaming either one, destroying the folder, or putting the file beside it
  under a made-up name are all writes the reader did not ask for.
- **The name is not looked up first.** No level is listed for a file before its
  write. The refusal is authoritative, carries the id, and costs one refused
  `set` per file that already exists — where a listing costs a request per
  folder, and can still miss the name on a level larger than one page. The one
  cost accepted is a blob paid for when the name turns out to be a folder's,
  which is a state the reader has to be told about anyway.
- **The read a drop makes is about folders.** The whole-account read resolves
  the tree; a level is read for itself only when a folder's create was refused
  and the id in the refusal has to be checked — the folder another writer made
  between the read and the create. No read is spent on what a folder holds.

### Rejected — `onExists: replace`

The server offers it, on the create itself, and it is the shortest possible
diff: one argument and the name is taken over. It is rejected because what it
replaces with is decided by the server's own rule, and its effect on a node
that holds a name is not the same statement this client wants to make. The
update path states the three properties that changed and nothing else; a
client that lets the server rewrite a node it did not describe is trusting a
rule about sharing, roles and `created` that nothing here has read.

### Rejected — looking the name up before writing

Reading the level and checking the name client-side refuses a duplicate before
its bytes are uploaded, which is the shape this writer had. What it costs is a
request per folder written into, on every drop, spent to avoid an upload that a
replacement has to make anyway — and it is *unsound* on a level larger than one
page, where the name it is looking for may not be in the page: the check would
then miss a duplicate and upload into a create the server refuses afterwards.
A rule that is both more expensive and less certain than the refusal it is
trying to pre-empt is not a rule this writer keeps. With the check gone the
question it answered goes too — whether a page of a level was that level in
full — which is why no read has to decide it any more.

### Rejected — duplicating instead of replacing

Creating a second node under a mangled name (`report (2).txt`) is what a file
manager does when the reader asks for a copy. A drop is not that ask: the tree
dropped is the tree meant, and a second drop of it is the same tree arriving
again. Mangling names would also make the gesture non-idempotent in the worst
way — every repeat leaves another generation of copies beside the first,
unbounded, and nothing in the account says which one is the current file.

## What this does not change

- **The folder walk**, which still resolves a folder that is there, creates only
  what is missing, and reports a subtree whose folder could not be made rather
  than filing its files elsewhere. A dropped empty folder is still created.
- **`nameTakenMessage`**, which stays the one sentence for a name that may not
  be taken — a file standing where a folder goes, or a write into what is not a
  file. A replacement that succeeds says nothing, so no new string is needed
  for it and no catalog gains a key the code does not ask for.
- **`createDirectory`**, whose `alreadyExists` is still read as "somebody else
  made it": a folder create that lost the race adopts the folder the refusal
  named. That is the same field read for the same reason on the folder side.
- **The mock**, which reproduces the refusal, the id and the case-sensitivity
  (`server/src/mock/index.ts`, `FileNode/set`), and its update path, already
  exercised by the settings and signature writes.
- **The rights.** A replacement needs what the create needed — `mayAddChildren`
  on the parent, `mayModifyContent` on the node — and a refusal of either
  arrives as the same message the writer already surfaces.

## Consequences

- **Dropping the same tree twice is one tree.** The second drop reuses the
  folders, replaces the files, and reports nothing; what the tray shows while it
  runs is the count of the run, files through out of files named.
- **A blob spent on a name a folder holds is unreferenced** and left to the
  server's GC. It is the one paying path this decision accepts, and it is
  reached only when a file and a folder of one name stand under the same parent.
- **Durability is untouched**: nothing here is stored in Gilbert, and a
  replacement writes into Stalwart's own node. The store's per-account reset,
  the tree and the pushed `FileNode` state all see an update, which is what
  they already handle.
- **A reader who wants the old name kept cannot have it here**: no confirmation
  is asked before a replacement, because a drop is one gesture and a dialog per
  colliding file is not a gesture. What they can see afterwards is the file
  holding the content just dropped, whose `modified` moved.
- **The attachment path is the one refusal left**, and the summary string for a
  folder in the way is the only sentence a taken name produces.
- **The read's own account of how much of a level it saw has no consumer.**
  `listChildrenWithState` (`web/src/lib/appFolder.ts`) answers with the page, the
  state and the population the query matched; whether that page was the whole
  level is the caller's to work out from those, and the drop does not ask. A
  verdict computed there for this one reader would be a second, unread account
  of the same two ceilings, so it is not computed.

## References

- `web/src/store/files.ts` — `putFile`, the one writer; `writeContent`, the one
  update; `upload` and `uploadPlan`, the two replacing paths; `uploadTo`, the
  refusing one
- `web/src/lib/filenode.ts` — `fileCreate`, `directoryCreate`, `isAlreadyExists`
- `web/src/views/files/FilesView.tsx` — the tray, the run's count and Cancel
- `web/src/views/files/FilesTree.tsx` — the same drop, aimed at a folder in the
  sidebar
- `server/src/mock/index.ts` — the refusal, its `existingId`, and the update path
- `server/src/jmap.ts` — `isAlreadyExistsRefusal`, the type read off the wire
- ADR 0013 — a durable write is caused by a change, not by a clock, which is why
  a blob that buys nothing is worth not uploading
- ADR 0002 — upstream is download-only: the drop behaviour is this client's own
