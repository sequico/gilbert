# ADR 0014 — Merging two folders is planned before it is written

Status: Accepted

Implementation: Built. Both trees are read and the plan is built before any step
is taken, and a stopped merge writes nothing (`web/src/lib/folderMerge.ts`, with
`web/src/lib/__tests__/folderMerge.test.ts`).

## Context

The reader selects two folders of one listing and asks for them to become one.
One of the two survives — its node, its id, its sharing, its place in the tree —
and everything the other holds has to end up inside it, with the folder it came
out of gone.

Three properties of that ask decide how it has to be built.

- **A merge is not a move.** Two trees can hold the same name, and where they do
  the two nodes cannot both survive under it. So the merge has to decide, per
  name, which node keeps the name — and the answer differs by kind: a folder on
  both sides is a third folder holding both, and a **file** on both sides is one
  file, whose content is the content of the one being merged in.
- **A listing is not a tree.** The selection is two rows of one folder — two
  siblings, which is why neither can contain the other — but what is *inside*
  them is not on screen. Two sibling folders can hold anything.
- **Names collide in ways no writer may settle alone.** A name that is a folder
  on one side and a file on the other has no answer: neither may be renamed,
  destroyed, or put beside the other under a made-up name. Discovering that
  halfway through has already moved part of one folder into the other, and
  nothing in the account then says which part.

## Decision

**Both trees are read, the whole merge is planned, and any collision stops every
step of it before the first write.**

- **The plan is a pure function over two trees** (`planMerge`,
  `web/src/lib/folderMerge.ts`): the steps in the order they would be taken, and
  the collisions that stop all of them. Four things can meet at a name and each
  has one answer — nothing there is a move; a folder on both sides is a
  recursion and then the emptied folder destroyed; content on both sides is a
  copy into the node that already holds the name, and then the source node
  destroyed; a folder against a file is a collision.
- **A collision leaves no plan at all**, so no caller can execute half of one.
  The set of steps is empty, and the reader is told the first name it is about
  and how many more there are behind it. Nothing was created, moved, copied or
  destroyed to find that out.
- **The kept node is the one whose name the reader chose.** The dialog asks
  which of the two names stays, and that choice *is* the folder that survives:
  its id, its sharing and its place in the tree. Renaming the survivor instead
  would move a folder's identity onto a name taken from the other one, which is
  a rename dressed up as a merge.
- **A name both hold as a file is written in place**, which is ADR 0013's rule
  reaching a second writer: the destination node keeps its id and its sharing,
  and only content changes. The file the bytes came out of is then destroyed, so
  one node of that name is left rather than two.
- **The folder being merged in is destroyed last, and only once it is empty.**
  The destroy sends no `onDestroyRemoveChildren`: what is left in there when the
  walk is done is a name it did not empty. A merge stopped by the reader, or by
  a failure, has therefore moved what it moved and destroyed nothing that still
  held something — both folders are still there, at the cost of the same
  operation being asked for again.
- **It is a run in the tray, like an upload.** The row is made before the scan,
  so there is something to watch and a Cancel to press for the whole of it, and
  the count is the plan's steps rather than bytes: a move and a destroy carry no
  percentage, and the row draws none for them. What a stopped run has done stays
  done.
- **The entry point is a menu item for exactly two folders, and it is drawn
  always.** Two is the number the feature is defined for — the dialog's question
  is which of *two* names survives — so anything else is the same entry,
  disabled: a menu that grows and shrinks leaves the reader wondering whether the
  action exists, and a greyed entry says what it is waiting for. Both folders
  must be deletable and take children, because either may be the one given up and
  either may be the one kept.

## What this does not change

- **The drop path.** A dropped tree still reuses the folders it finds, writes
  over the files, and reports a subtree whose folder could not be made (ADR
  0013). A merge is an explicit gesture between two folders that are already on
  screen.
- **Deleting a folder from the Files view**, which still takes its contents with
  it: that is what the reader asked for there, and it is what
  `onDestroyRemoveChildren` says. The two are different asks and they differ by
  exactly that flag.
- **`uploadTo`**, which still refuses a taken name: saving an attachment is not a
  merge.
- **The store's other writes.** `moveMany` and `destroy` keep their one-call
  shape, and the merge goes through the same two calls rather than a third
  writer.

## Consequences

- **A collision costs one scan.** Reading both trees is what makes a merge safe
  to start; a name that cannot be merged costs the reader a sentence and no
  write at all, where a merge that had begun and then failed would cost a folder
  left half-merged.
- **The scan is bounded by what the plan descends into.** A folder that is not
  in the other one is one step whatever it holds, and its subtree is never read;
  a level the walk does decide about is read whole, page after page, because a
  page of a larger level would plan half a merge. A page the server answers
  twice is a failure rather than a loop.
- **A copy is an upload.** Content crosses by downloading the blob and uploading
  it into the node that keeps the name, which the account is charged for and
  which the server's GC reclaims the other side of (ADR 0012). Pointing the kept
  node at the other node's blob would save both, and nothing here has read a
  0.16 do it: the second blob is the price of not resting a durable write on an
  unverified answer.
- **A merge stopped halfway is visible in the account rather than reported as
  such.** What moved is inside the kept folder, what did not is in the other one,
  and both are still there; asking for the merge again finishes it. Nothing
  records the interruption — no durable state is written about a run in
  progress.
- **`FileNode/set`'s refusal of a non-empty folder without
  `onDestroyRemoveChildren` is modelled by the mock and not verified live**, so
  the merge's last step rests on a server behaviour this repository has read off
  the client's own habit of sending the flag. It is owed as a probe in
  `KNOWN-ISSUES.md`, and the safe direction is what the merge gets if the
  assumption is wrong.

## References

- `web/src/lib/folderMerge.ts` — `planMerge`, the steps and the collisions
- `web/src/store/files.ts` — `mergeFolders`, the scan, the run, and the three
  writers it goes through: `moveNodes`, `copyOver`, `destroyNodes`
- `web/src/views/files/FilesView.tsx` — the menu entry, the dialog that asks
  which name stays, and the tray
- `web/src/jmap/client.ts` — `fetchBlob`, which the copy reads through
- `server/src/mock/destroy-non-empty-folder.test.ts` — the mock's refusal, and
  the cascade the Files view's own delete uses
- ADR 0013 — a dropped name is written over, in place: the rule a merge's files
  follow, and the drop path it leaves alone
- ADR 0012 — a durable write is caused by a change, not by a clock, which is why
  a merge stores nothing about a run in progress
- ADR 0002 — upstream is download-only: the merge is this client's own
