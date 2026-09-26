# ADR 0022 — Archive puts a conversation back where it was filed

Status: Accepted

Implementation: Built. `web/src/lib/archiveTarget.ts` answers which folder a
conversation already lives in (`filedFolderOf`); `archive` in
`web/src/store/mail.ts` reads the thread's messages (`threadMessagesFor` —
`Thread/get`, then `Email/get` for the ones the page is not showing) and moves
the selection through one shared `moveToDestinations`, which is also what
`archiveByDate` now uses, so a selection that splits across destinations is
reported once, with one Undo. The invariants are pinned in
`web/src/lib/__tests__/archiveTarget.test.ts` and
`web/src/store/__tests__/archive-returns-to-its-folder.test.ts`.

## Context

Archive is the reader's way of saying "this is dealt with, put it away". But a
conversation is not an object that stays put: a reply arrives, joins the thread,
and the conversation is **back in the Inbox** while the rest of it is still in
the folder it was filed under — a case folder beneath Archive, a project folder,
anything the reader made. The archive button then had only one destination,
Archive itself (or a dated folder under it, when the reader asked for that), so
pressing it on a conversation that had come back to life undid the reader's own
decision about where that conversation lives: the case folder lost its thread to
the archive's root, and the next reply brought it back to the Inbox to be filed
again by hand.

Three facts about the product decide what there is to build on.

- **Where a conversation was filed is readable.** The thread's messages carry
  their own `mailboxIds`, and a thread spans folders: the reply is in the Inbox,
  the rest of the conversation is in the folder it was put in. The client holds
  the ids (`threads[id].emailIds`, which the list loads for its rows) and can
  read the messages it does not hold. Nothing has to be remembered anywhere:
  the answer is in the mail server's own state, which is where the architecture
  says durable state lives.
- **A thread belongs to one account.** A copy of the same conversation in a
  group's account and in the reader's own are two deliveries and two threads
  (`gilbertstalwart`), and each is filed on its own. An archive pressed in one
  account must touch that account's copy and read nothing from the other.
- **The dated entries are an explicit instruction.** `Archive to 2026`,
  `Archive to 2026/09` say where they put the mail, and a reader who picks one
  is asking for a date rather than for where the conversation used to be.

## Decision

**The archive button returns a conversation to the folder it was filed in. Only
a conversation that was never filed anywhere goes to Archive.**

- **Filed means a folder the reader put it in.** Inbox is where mail arrives,
  Sent is where every reply sits, and Drafts, Junk and Trash are where mail
  waits to be dealt with: none of them is filing. Every other folder is —
  including Archive itself, whose dated children are ordinary folders — and a
  folder this session cannot name is not a destination at all.
- **The newest filed message decides.** A conversation that was moved from one
  folder to another was last put in the second one, and the reply that brought
  it back to the Inbox is in no filing folder, so it has nothing to say. When
  that message sits in several filing folders at once, the folder holding most
  of the thread wins, and the mailbox id settles the rest — so the answer never
  depends on the order the folders arrived in.
- **A message already in that folder is filed away as before.** Archiving out of
  the case folder itself is not "back there": the destination would be the
  folder the message is in, and an action that does nothing is worse than the
  one it replaces. The message is moved to Archive, which is what the entry has
  always said it does.
- **One account, one copy.** The thread is read from the account the action is
  aimed at, and the moves are written to it. The group's copy of a conversation
  is filed from the group's account and the reader's own from theirs; neither
  decides anything about the other, and the same code serves both.
- **One destination per thread, one report per action.** A selection can split
  across destinations — several threads, some filed, some not — so the moves go
  out silently and the action is reported once, with one Undo built from where
  every message was. `archiveByDate` shares that machinery rather than keeping
  its own copy of it.
- **The dated entries are untouched.** They name a date and they file by it.
  Where a conversation came from is the plain Archive button's business.

### Rejected — remembering the last folder per conversation

A record of "this thread was in folder X" would be durable state with no home:
the accounts' own Files would hold it, per reader and per account, it would go
stale the moment another client moved the conversation, and it would have to be
written on every move. The mail server already knows where the messages are, and
the answer is read from there in one call.

### Rejected — applying it to the dated entries too

`Archive to 2026/09` is a statement about where the message goes. Silently
sending a conversation somewhere else because it used to be filed there would
make the entry's own words false, and the reader who wants the old folder has
the plain Archive button, which now does exactly that.

## Consequences

- **Archiving costs a read.** A thread the page is not showing is fetched
  (`Thread/get`, then the messages that are not held) before the move, so the
  button answers where the conversation lives instead of guessing. It is one
  round trip through the client's own batching, and it happens only when the
  reader archives.
- **A conversation filed in two places is filed to one of them.** The weight of
  the thread decides, then the id: deterministic, and necessarily a single
  answer, since one message goes to one folder.
- **A conversation that was archived and then came back keeps coming back to
  Archive**, because Archive is where it was filed — which is the behaviour the
  dated entries exist to refine.
- **The rule is only as good as the client that carries it.** Another client,
  IMAP, or the server's own administration files the same mail without asking
  this code. It is a convention this client keeps, not a boundary.
- **Nothing is remembered anywhere**, so the rule survives a new device, a new
  browser, and a conversation nobody in this client has ever opened.

## References

- `web/src/lib/archiveTarget.ts` — `filedFolderOf`, the whole rule: which folder
  a conversation is filed in, and `null` when it is in none
- `web/src/store/mail.ts` — `archive`, `archiveByDate`, `threadMessagesFor` and
  `moveToDestinations`
- `web/src/lib/__tests__/archiveTarget.test.ts` — the rule: the newest filed
  message decides, structural folders do not count, an unknown folder is not a
  destination, and the tie is settled by weight and then by id
- `web/src/store/__tests__/archive-returns-to-its-folder.test.ts` — the action:
  a case folder beneath Archive, a folder the reader made, a conversation that
  was never filed, a message already in that folder, and the same in a group
  mailbox with every read and write asked of the group
- `web/src/store/__tests__/archive-by-date.test.ts` — the dated entries, which
  share the reporting machinery and keep their own meaning
- ADR 0005 — a group owns its data, and its mail is filed inside the group
- ADR 0015 — the other mail rule this client keeps in one module
