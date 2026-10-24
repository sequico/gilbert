# ADR 0013 — A group's data is ended by an administrator only

Status: Accepted

Implementation: Built. One decision with two surfaces and two rule modules. The
mail rule is `web/src/lib/mailDelete.ts`, which also holds the two final folders
as one predicate (`FINAL_FOLDER_ROLES`, `isFinalFolderRole`) that `canEmpty` and
the store's `emptyMailbox` guard ask; its guard sits on the three effects that
destroy — `destroy`, `emptyMailbox` and `destroyMailbox` in `web/src/store/mail/`
— each answering a `DeleteOutcome` so a caller can tell a refusal from work
done. The Files rule is `web/src/lib/trash.ts` (`mayEndFiles`, `trashRefusal`):
deletion is the store's `trash` (a move), and what ends anything is guarded on
the effects too — `emptyTrash` and `destroyForever` in
`web/src/store/files/slices/trash.ts` — while the surfaces ask the same answer
through `web/src/views/files/trashActions.ts`. The folder's identity, the origins
document and the numbering of a name arriving twice are shared by both tiers in
`server/src/shared/trash.ts`, and the agent's `files.delete` moves to the same
Trash (`server/src/agent/tools/files.ts`). The mail surfaces read the answer
through one hook (`web/src/lib/useMayDestroy.ts`) so the drawn answer moves with
the admin flag: `web/src/views/mail/MessageList.tsx`, `MailView.tsx`,
`MessageView.tsx`, `ThreadView.tsx`, `MailboxTree.tsx` and `web/src/lib/swipe.ts`,
which resolves a refused direction to nothing at all. The invariants are pinned in
`web/src/store/__tests__/group-mail-delete.test.ts`,
`web/src/lib/__tests__/trash.test.ts` and
`web/src/store/__tests__/files-trash.test.ts`, and the mail exception for the
reader's own draft in `web/src/store/__tests__/compose-save.test.ts`.

## Context

A group mailbox is an account of its own, and a member reaches it by
**membership** rather than by a share: nothing in the mail server tells one
member's action from another's, and every member holds the same rights over the
group's mail and files (ADR 0004). Ending data is the one action in the product
that cannot be taken back, and a group's data is the one place where the person
pressing Delete is not the person who owns what goes.

Three facts about the mail server decide what is available to build on.

- **Its access control distinguishes a share from a membership.** Per-object
  rights — a mailbox's `myRights`, `mayRemoveItems` among them — are read on the
  *shared-with-me* path; a member's own membership is not restricted by
  them. Read at **v0.16.22**: `crates/jmap/src/email/set.rs` asks for the item
  rights only under `if access_token.is_shared(account_id)` and takes `None`
  otherwise, and `crates/common/src/auth/access_token.rs` treats membership as
  access. There is no rank inside a group, and no per-account or per-collection
  right that would say "this member may end the group's data and that one may
  not".
- **Its destroy permission is role-wide.** `Email/set` with a `destroy` is
  gated on one permission for the whole role — `JmapEmailDestroy`, checked once
  for the request rather than per object (`validate_set` in
  `crates/jmap/src/api/auth.rs`) — so withdrawing it closes destroying
  everywhere the holder works, their own mail included, which is not a trade
  the product accepts. Setting it is the mail server's own user
  administration, which ADR 0001 puts outside the product.
- **Gilbert has one administration, and it is installation-wide.** The session
  carries a single `isAdmin` flag, resolved from Stalwart's own permission list
  (ADR 0001). There is no group administrator: a group mailbox is an ordinary
  working group, and a member cannot even read their group's roster — that read
  needs a permission the built-in User role does not carry (`gilbertstalwart`).

What is reachable from the client, and ends a group's mail for good, is three
things: deleting a message that already sits in Deleted Items or Junk Mail,
emptying one of those two folders, and deleting a folder **together with** the
mail in it. Everything else a member does in a group — moving, labelling,
archiving, replying, forwarding, drafting, sending — is a change that can be
taken back or put right by somebody. Three messages are destroyed in a group
account without being the group's mail, and are named among the decisions below
rather than left to be discovered: an unsent draft, the draft a send replaces,
and a read receipt the submission refused.

Files answers the same question with a different shape, because the server shows
no rank there either. A node deleted from Files is **moved** into the account's
Trash: a real top-level folder, created by the first deletion, whose internal
name is `Trash` and whose label every surface draws translated. A top-level
folder already carrying that name **is** the Trash — the name is the whole
identity, as it is for `gilbert`. A folder arrives in it whole, and restoring
moves it back with everything under it. So the act a person takes on ordinary
data is reversible everywhere, and what remains final is two things: emptying
the Trash, and deleting one item inside it for good. Both are final steps in an
account the member does not own, and both are the ones this record decides
about.

## Decision

**In an account that is not the reader's own, data is ended by an installation
administrator only. Deleting stays available to every member — it moves the
thing into that account's Deleted Items or Trash — and the steps that end it are
refused, each saying which one it is and what still works.**

- **The destroy is refused; the move is not.** Delete from a group's Inbox
  files the message in the group's Deleted Items, with Undo, and Delete in a
  group's Files moves the node into the group's Trash. Archiving, filing,
  renaming, moving and every other ordinary action behave as they do anywhere.
  A group's Deleted Items, Junk Mail and Trash therefore remain real places that
  members fill and cannot empty.
- **Nothing empties on a clock.** A Trash grows until somebody asks for it to be
  emptied, and there is no age at which a node disappears by itself. The rule
  says who may take that step, and a timer would take it on a person's behalf.
- **One rule per surface, one decision.** The mail half lives in
  `web/src/lib/mailDelete.ts`, which answers *what a delete does here* (a move,
  or the end of the message, by the role of the folders holding it) and *who may
  take one here*. The Files half lives in `web/src/lib/trash.ts`, which answers
  *who may empty this account's Trash, or end one node in it*. Every surface
  asks one of the two rather than restating it, which is also what settles a
  disagreement the mail surfaces would otherwise carry: the list and the message
  menu call Junk Mail final while the swipe's own label says it of Deleted Items
  alone (`web/src/lib/swipe.ts`, `describeSwipe`), so the same gesture destroys
  a message in Junk under the word "Delete". One answer, read by all of them, is
  what makes the words and the effect agree.
- **The rule answers a code, and the sentence is composed where it shows.** The
  mail module says *refused*, and which refusal it is — `group_mail_final`,
  `group_mail_empty`, `group_mail_folder` — and the Files one answers
  `group_files_empty` or `group_files_final`. The store and the surfaces compose
  what the reader reads from the catalogue their language loaded, which is the
  shape every other refusal in this product already has. A sentence held in a
  library is a string no catalogue can translate and no reading of the code can
  find. Separate codes because the reader's next move differs: a refused message
  is still restorable from Deleted Items, a refused folder asks them to move the
  mail out first, and a refused Trash emptying is a folder they can still move
  things into or out of.
- **The guard is where the effect is.** `destroy`, `emptyMailbox` and
  `destroyMailbox(id, removeEmails)` in the mail store refuse in a group, and
  `emptyTrash` and `destroyForever` in the files store refuse in an account that
  is not the reader's own, so the action is refused whatever calls it — a menu, a
  keyboard shortcut, a swipe, an import — and the surfaces draw themselves from
  the same answer so that nothing offers what would be refused. `destroy` is the
  funnel every other final mail delete reaches, `trash` among them: a message
  that already sits in Deleted Items or Junk Mail is destroyed from there, so one
  guard closes both folder paths.
- **Unknown is not the reader's own.** The mail classifier answers *group* only
  once the account probe has listed the account, and before that it answers
  nothing about anybody: an empty `mailAccounts` is indistinguishable from a
  group that has not been discovered yet. So the mail guard asks the two
  questions in order — is this account the reader's own (`isOwnMailAccount`,
  which the session answers at any moment), and only then, is it a group — and
  refuses an account that is not provably the reader's own while the set is
  unknown. The Files guard asks the same shape of question of the session's own
  Files account, with both ids present, so a boot or a reload on a group's address
  fails closed. The reader's own account is never the one refused: its answer
  does not depend on the probe at all.
- **The folder guard reads a count it already has.** Whether a mail folder holds
  mail is `totalEmails` on the folder the store is looking at, which
  `MAILBOX_PROPS` fetches with every tree: no query, and no second read that
  could disagree with what the folder list shows.
- **Both inputs are read from the session, and move when it does.** The mail
  classifier comes from the account probe and the admin flag from
  `session.gilbert.isAdmin`, which ADR 0001 resolves at sign-in; both are
  re-read when the session state changes — `client.onSessionState` calls the
  session's `refresh()` and re-runs `discoverMailAccounts()` — so a group joined
  or left, and an administrator added or removed, are seen at that moment rather
  than only at the next sign-in. The window between the two is the rule's own
  limit and is named in the consequences. What a live server *reports* as
  `sessionState` when a data write lands — whether the state moves for a write
  that changes nothing about the session — is the debt below; the refresh hangs
  on that signal, and the mock reports it unmoved.
<!-- owed: session-state-on-a-write -->
- **The agent ends nothing.** The agent's tools name no act that empties a Trash
  or deletes a node for good, and it has no tool that destroys mail — an
  irreversible act is a person's, always (ADR 0028). Its `files.delete` **moves**
  a node into the account's Trash, which is the same place a member's delete
  leaves it, and it records where the node came from so a person can restore it.
- **A message or file Gilbert wrote itself is not in the way.** Discarding a
  draft, and the write that replaces a draft when a message is sent, are the
  compose store's own `Email/set` calls (ADR 0005's sending path), not the mail
  store's delete; and a read receipt the reader asked for, created and then
  refused by the submission, is destroyed by the MDN store rather than left in
  Sent looking as though it had gone (`web/src/store/mdn.ts`). Each destroys a
  message written in the reader's own name, in a folder nobody else reads. A
  member's unsent mail goes away in a group exactly as it does anywhere.
- **An empty folder is not data.** Deleting a folder that holds nothing ends
  nothing, and a group's tree stays the group's to shape.
- **What a replace or a merge destroys inside Files is not a person's delete.**
  Writing over a node (ADR 0011) and merging two folders (ADR 0012) destroy a
  node because the bytes it held now live somewhere chosen, never because
  somebody asked for the data to go; they keep destroying, and a merge is not
  offered inside a Trash.

### What this rule is not

It is not a boundary, and it is not written as one. It is a rule of this client:
the same account reached by another JMAP client, by IMAP, or by the mail
server's own administration destroys the same mail and empties the same Trash
without asking this code. That is the same posture ADR 0001 states for the
product's only server-enforced rule, and the reason the sentence a person reads
names what is closed rather than claiming a protection.

### Rejected — a door on the server side

Gilbert's proxy forwards `/api/jmap` as an opaque body, and a door there would
mean parsing JMAP method calls, deciding which of them destroy mail or empty a
Trash and on whose behalf, and refusing the ones that do — the second
server-enforced rule in a product that has one, on the request path of every call
the client makes. It is a decision of its own with its own cost, and it would
still stop only what goes through this proxy: a session on the group account
reaches the mail server directly.

### Rejected — withdrawing the mail server's destroy permission

It closes the reader's own mail along with the group's, which is not what the
rule is about, and it is the mail server's user administration rather than the
product's (ADR 0001). It is also the wrong shape: the permission is held per
role, so an installation running two groups with different expectations between
them has no way to say so.

### Rejected — a per-group switch first

A preference document in the group's own account, read by the client, would let
one group choose — and it would still be enforced by exactly the client-side
rule above, with a second document to read, keep in step and explain. The
installation-wide rule is the smaller thing and the one every group can live
with; a group that wants the switch can be given one over it.

### Rejected — an empty-on-a-clock Trash

A Trash that deletes after a number of days is a durable write caused by a clock
rather than by a change (ADR 0010) and a person's final decision taken by a
timer, in an account the group owns and the member does not. The step is an
administrator's to ask for, and asking is the action this record keeps.

## What this does not change

- **ADR 0001.** The flag's source is untouched: it is Stalwart's own answer,
  re-resolved on every privileged call, and `requireAdmin` is still the only
  thing that guards an account — this adds no door. What that record's own
  sentence about the client's copy had to gain with this is the second use: the
  flag shows or hides the admin entry point **and** decides whether a group's
  data may be ended, which is written there now rather than left to be
  discovered against it.

  What does **not** change is that sentence's reason. The client is still not a
  door: the flag decides what is drawn and what this client will do, never what
  the server allows, which is what the rule above says of itself when it states
  that it is not a boundary. A reader who forged the flag would still be refused
  by the mail server, exactly as a reader who forged it today gets an admin
  surface whose every call fails.
- **ADR 0004, and ADR 0005.** Ownership and identity are untouched: a member
  still sends from the identity the administration assigned, in the group's
  account, and the group's Files are still the group's from creation. Delete is
  not an identity question.
- **ADR 0011, and ADR 0012.** A write over a name still happens in place, and a
  merge is still planned before it is written. The destroys those two make are
  content moves, not this record's subject.
- **`gilbertstalwart`.** Nothing is set inside Stalwart for this and no
  capability is required of it: a group's mail, its Trash and ordinary folders
  are ordinary objects to the server.
- **`gilbertagents`.** Its tools end nothing (ADR 0027, ADR 0028); `files.delete`
  moves a node to the Trash, which is a reversible change.

## Consequences

- **A group's Deleted Items, Junk Mail and Trash grow until an administrator
  empties them.** The quota they spend is the group account's, so the cost of the
  rule is paid by the group rather than by the person asking to delete. Worth
  knowing before an installation relies on members tidying.
- **A non-administrator cannot end a group's data anywhere.** Filing a message
  in the group's Deleted Items and deleting a node into the group's Trash is
  where a member's version of "gone" stops, and neither item can be ended from
  there — not one by one, not by emptying, not by merging two trashed folders.
- **A withdrawn administrator keeps the surface until the session is read
  again.** The flag is ADR 0001's, resolved at sign-in and re-read when the
  session state changes — a group added or removed is discovered at the same
  moment. Between those moments the client answers from what it holds, so a
  person removed from the admin group can still end a group's data in a tab that
  was open across the change. It is the same order of staleness ADR 0001 already
  accepts for the client's view of its own privilege, and the server's own door
  is the one that closes it.
- **The Trash's name is the folder.** A top-level folder a person already keeps
  under the name `Trash` is the Trash, exactly as the `gilbert` folder is
  Gilbert's: its contents show in the Trash and an emptying ends them. An
  account that wants a folder by that name for its own use needs another name.
  This client refuses to rename or move the folder; another client that does
  puts it out of this rule's reach until the next deletion makes a new one.
- **A restore is a move, and it is only as exact as what was remembered.** The
  origin — the folder and the name — is kept in the account's
  `gilbert/trash.json`; a folder that is gone when the node comes back sends it
  to the top level of Files instead of failing, a name the destination now holds
  is numbered rather than overwriting what is there, and a name the move merely
  numbered in the Trash comes back as it was. A node renamed **inside** the Trash
  keeps the reader's name: only what the move did is undone. A node trashed by
  another client that does not write that document restores to the top level.
- **Deleting a mail folder still stops on a folder that holds mail**, for a
  non-administrator: it is one of the things that destroys, and it is refused by
  the folder's own count. An empty folder still goes.
- **The rule is only as good as the client that carries it.** Another client
  reaches the same account, destroys the same mail and empties the same Trash. An
  installation that needs the guarantee rather than the convention has to take it
  up in the mail server, where the membership model is the thing to change.
- **The surfaces lose the entries they cannot carry**, rather than offering them
  and refusing afterwards: the final delete is disabled where the reader is
  refused, an emptying entry that would destroy is disabled, and a swipe
  direction with nothing it may do does not move the row — the same treatment a
  swipe out of the archive already gets.

## References

- `web/src/lib/mailDelete.ts` — the mail rule: what a delete does, which refusal
  it answers, and the two final folders as one predicate (`FINAL_FOLDER_ROLES`,
  `isFinalFolderRole`, and `finalFoldersOf` which finds them by it) that
  `canEmpty` in `web/src/lib/emptyFolder.tsx` and the `emptyMailbox` guard in
  `web/src/store/mail/` both ask, and the three questions the surfaces ask
  (`deleteEffect`, `deleteEntryOffered`, `messageDeleteOffered` /
  `folderDeleteOffered`)
- `web/src/lib/useMayDestroy.ts` — the one hook every mail surface reads it
  through, so the drawn answer re-renders when the admin flag or the account set
  moves
- `web/src/store/mail/` — the guards on `destroy`, `emptyMailbox` and
  `destroyMailbox`, each answering a `DeleteOutcome` in which the rule's refusal
  and the server's own are different codes, and the module-private
  `destroyEmails` the guarded paths funnel through
- `web/src/lib/trash.ts` — the Files rule (`mayEndFiles`, `trashRefusal`) and the
  transport of the Trash folder and of `trash.json`
- `server/src/shared/trash.ts` — what the Trash folder is, the origins document's
  shape, and the numbered name a node arriving twice takes, shared by both tiers
- `web/src/store/files/slices/trash.ts` — `trash` (the move), `restore`,
  `emptyTrash` and `destroyForever`, with the guard on the two that end
- `web/src/views/files/trashActions.ts` — the one question and the one emptying
  the two Files surfaces offer, so the drawn answer and the effect agree
- `web/src/views/files/FilesView.tsx` and `FilesTree.tsx` — the Trash's own row,
  its translated label, Restore and Delete permanently in the listing, and Empty
  trash in the context menus, disabled where the rule refuses it
- `server/src/agent/tools/files.ts` — `files.delete` moves the node into the
  account's Trash and records where it came from
- `web/src/store/__tests__/group-mail-delete.test.ts` — the mail invariant: a
  member's destroy in a group reaches no server, an administrator's does, an
  account nobody has classified yet is refused while the reader's own is served,
  a mixed selection still reports what it did, and a refused direction resolves
  to nothing
- `web/src/lib/__tests__/trash.test.ts` — the Files rule and the shared shapes:
  the folder's identity, the numbered name, the origins document, and who may end
  what is in it
- `web/src/store/__tests__/files-trash.test.ts` — the Files invariant: a delete
  moves with its subtree and destroys nothing, a name arriving twice is numbered,
  a restore returns the whole folder to where it came from, and a member's empty
  or permanent delete in a group reaches no server
- `web/src/store/__tests__/compose-save.test.ts` — the deliberate exception: a
  member still discards their own draft with a group open
- `web/src/lib/swipe.ts` — a direction with no meaning here resolves to nothing,
  and the delete label now follows the rule's answer rather than the folder's
  role
- `web/src/store/mdn.ts` — the receipt a refused submission destroys rather than
  leave in Sent looking sent
- `web/src/store/session.ts` — `session.gilbert.isAdmin`, and `refresh()` with
  `client.onSessionState` as the moment the flag and the account set move
- `web/src/views/mail/` — `MailView`, `MessageList`, `MessageView` and
  `ThreadView`, which ask the rule before drawing an entry
- `web/src/views/AdminView.tsx` — the surface an unconditional route reaches,
  with no client guard: every privileged call in it is refused by the server
- `web/src/lib/mailAccounts.ts` — `isOwnMailAccount`, the question the mail rule
  asks before anything else, and `isGroupMailboxAccount`, the classifier the
  group surfaces read for their own purposes (the rule itself does not need it:
  it refuses everything that is not provably the reader's own)
- ADR 0001 — administration is Stalwart's, and `isAdmin` is its answer
- ADR 0004 — a group owns its data, and membership is the grant
- ADR 0005 — identity in a group, and the sending path the drafts composer uses
- ADR 0010 — a durable write is caused by a change, not by a clock
- ADR 0011 — a dropped name is written over, in place
- ADR 0012 — merging two folders is planned before it is written
- ADR 0027, ADR 0028 — the agent's catalogue, and what only a person decides
