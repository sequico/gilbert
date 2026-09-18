# ADR 0015 — A group's mail is deleted by an administrator only

Status: Accepted

Implementation: Built. The rule is one module (`web/src/lib/mailDelete.ts`) and
its guard sits on the three effects that destroy — `destroy`, `emptyMailbox` and
`destroyMailbox` in `web/src/store/mail.ts` — each answering a `DeleteOutcome` so
a caller can tell a refusal from work done, the rule's own refusals and the mail
server's told apart by their code. The surfaces read the same answer
before drawing an entry, through `deleteEntryOffered` and its two per-target
wrappers, and reach it through one hook (`web/src/lib/useMayDestroy.ts`) so the
drawn answer moves with the admin flag: `web/src/views/mail/MessageList.tsx`,
`MailView.tsx`, `MessageView.tsx`, `ThreadView.tsx`, `MailboxTree.tsx` and
`web/src/lib/swipe.ts`, which resolves a refused direction to nothing at all. The
invariant is pinned in `web/src/store/__tests__/group-mail-delete.test.ts`, and
the exception for the reader's own draft in
`web/src/store/__tests__/compose-save.test.ts`.

## Context

A group mailbox is an account of its own, and a member reaches it by
**membership** rather than by a share: nothing in the mail server tells one
member's action from another's, and every member holds the same rights over the
group's mail (ADR 0005). Deleting is the one action in the product that cannot
be taken back, and a group's mail is the one place where the person pressing
Delete is not the person who owns what goes.

Three facts about the mail server decide what is available to build on.

- **Its access control distinguishes a share from a membership.** Per-object
  rights — a mailbox's `myRights`, `mayRemoveItems` among them — are read on
  the *shared-with-me* path; a member's own membership is not restricted by
  them. Read at **v0.16.22**: `crates/jmap/src/email/set.rs` asks for the item
  rights only under `if access_token.is_shared(account_id)` and takes `None`
  otherwise, and `crates/common/src/auth/access_token.rs` treats membership as
  access. There is no rank inside a group, and no per-account or per-collection
  right that would say "this member may bin the group's mail and that one may
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

What is reachable from the client, and destroys the group's mail for good, is
three things: deleting a message that already sits in Deleted Items or Junk
Mail, emptying one of those two folders, and deleting a folder **together
with** the mail in it. Everything else a member does in a group — moving,
labelling, archiving, replying, forwarding, drafting, sending — is a change that
can be taken back or put right by somebody. Three messages are destroyed in a
group account without being the group's mail, and are named among the decisions
below rather than left to be discovered: an unsent draft, the draft a send
replaces, and a read receipt the submission refused.

## Decision

**In a group mailbox, mail is destroyed by an installation administrator only.
Every other member is refused the three entry points that destroy, each saying
which one it is and what still works.**

- **The destroy is refused; the move is not.** Delete from a group's Inbox
  still files the message in the group's Deleted Items, with Undo, and Archiving
  and every filing action behave as they do anywhere. What a non-administrator
  cannot do is the step that makes it final. A group's Deleted Items and Junk
  Mail therefore remain real folders that members fill and cannot empty.
- **One rule, one module.** The decision lives in that module and nowhere else:
  `web/src/lib/mailDelete.ts` answers *what a delete does here* (a move, or the
  end of the message, by the role of the folders holding it) and *who may take
  one here* (the mail store's group classifier, the session's admin flag). Every
  surface asks it rather than restating it, which is also what settles a
  disagreement the surfaces carry today: the list and the message menu call
  Junk Mail final — their titles say *Delete forever* and their confirmation
  counts Junk alongside Deleted Items — while the swipe's own label says it of
  Deleted Items alone (`web/src/lib/swipe.ts`, `describeSwipe`), so the same
  gesture destroys a message in Junk under the word "Delete". One answer, read
  by all of them, is what makes the words and the effect agree.
- **The rule answers a code, and the sentence is composed where it shows.** The
  module says *refused*, and which refusal it is — `group_mail_final`,
  `group_mail_empty`, `group_mail_folder` — and the store and the surfaces
  compose what the reader reads from the catalogue their language loaded, which
  is the shape every other refusal in this product already has. A sentence held
  in a library is a string no catalogue can translate and no reading of the code
  can find. Three codes rather than one because the reader's next move differs:
  a refused message is still restorable from Deleted Items, a refused folder
  asks them to move the mail out first, and a refused emptying is a folder they
  can still file into.
- **The guard is where the effect is.** `destroy`, `emptyMailbox` and
  `destroyMailbox(id, removeEmails)` in the mail store refuse in a group, so the
  action is refused whatever calls it — a menu, a keyboard shortcut, a swipe —
  and the surfaces draw themselves from the same answer so that nothing offers
  what would be refused. `destroy` is the funnel every other final delete
  reaches, `trash` among them: a message that already sits in Deleted Items or
  Junk Mail is destroyed from there, so one guard closes both folder paths.
- **Unknown is not the reader's own.** The classifier answers *group* only once
  the account probe has listed the account, and before that it answers nothing
  about anybody: an empty `mailAccounts` is indistinguishable from a group that
  has not been discovered yet. So the guard asks the two questions in order — is
  this account the reader's own (`isOwnMailAccount`, which the session answers
  at any moment), and only then, is it a group — and refuses an account that is
  not provably the reader's own while the set is unknown. A boot, a reload on a
  group's address and a probe still in flight therefore fail closed, and the
  reader's own mailbox is never the one refused: its answer does not depend on
  the probe at all.
- **The folder guard reads a count it already has.** Whether a folder holds mail
  is `totalEmails` on the folder the store is looking at, which `MAILBOX_PROPS`
  fetches with every tree: no query, and no second read that could disagree with
  what the folder list shows.
- **Both inputs are read from the session, and move when it does.** The
  classifier comes from the account probe and the admin flag from
  `session.gilbert.isAdmin`, which ADR 0001 resolves at sign-in; both are
  re-read when the session state changes — `client.onSessionState` calls the
  session's `refresh()` and re-runs `discoverMailAccounts()` — so a group joined
  or left, and an administrator added or removed, are seen at that moment rather
  than only at the next sign-in. The window between the two is the rule's own
  limit and is named in the consequences.
- **The agents hold no delete at all.** The capability catalogue
  (`AGENT_ACTION_SPECS`) names no action that destroys mail, so what this record
  grants an administrator is a surface for a person; nothing an automation can
  be written to do changes with it. An automation's `mail.move` can file a
  message into the group's Deleted Items, which is the same place a member's
  delete leaves it and is not a destroy. **The Mail area of ADR 0006 does not
  change this.** That record groups the five mail actions under one checkbox
  precisely so a tick cannot be how somebody grants what the catalogue keeps
  out, and its own rule already covers the case: a destroy added to
  `AGENT_ACTION_SPECS` later would carry `irreversible` — and `external` too if
  it ever reached another account — which excludes it from every area and
  leaves it a checkbox of its own, beside `mail.send` rather than inside
  *Mail*.
- **A message Gilbert wrote itself is not in the way.** Discarding a draft, and
  the write that replaces a draft when a message is sent, are the compose
  store's own `Email/set` calls (ADR 0007's sending path), not the mail store's
  delete; and a read receipt the reader asked for, created and then refused by
  the submission, is destroyed by the MDN store rather than left in Sent looking
  as though it had gone (`web/src/store/mdn.ts`). Each destroys a message
  written in the reader's own name, in a folder nobody else reads. A member's
  unsent mail goes away in a group exactly as it does anywhere.
- **An empty folder is not mail.** Deleting a folder that holds nothing destroys
  nothing, and a group's tree stays the group's to shape.

### What this rule is not

It is not a boundary, and it is not written as one. It is a rule of this client:
the same account reached by another JMAP client, by IMAP, or by the mail
server's own administration destroys the same mail without asking this code.
That is the same posture ADR 0001 states for the product's only server-enforced
rule, and the reason the sentence a person reads names what is closed rather
than claiming a protection.

### Rejected — a door on the server side

Gilbert's proxy forwards `/api/jmap` as an opaque body, and a door there would
mean parsing JMAP method calls, deciding which of them destroy mail and on whose
behalf, and refusing the ones that do — the second server-enforced rule in a
product that has one, on the request path of every call the client makes. It is
a decision of its own with its own cost, and it would still stop only what goes
through this proxy: a session on the group account reaches the mail server
directly.

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

## What this does not change

- **ADR 0001.** The flag's source is untouched: it is Stalwart's own answer,
  re-resolved on every privileged call, and `requireAdmin` is still the only
  thing that guards an account — this adds no door. What that record's own
  sentence about the client's copy had to gain with this is the second use: the
  flag shows or hides the admin entry point **and** decides whether a group's
  mail may be ended, which is written there now rather than left to be
  discovered against it.

  What does **not** change is that sentence's reason. The client is still not a
  door: the flag decides what is drawn and what this client will do, never what
  the server allows, which is what the rule above says of itself when it states
  that it is not a boundary. A reader who forged the flag would still be refused
  by the mail server, exactly as a reader who forged it today gets an admin
  surface whose every call fails.
- **ADR 0005, and ADR 0007.** Ownership and identity are untouched: a member
  still sends from the identity the administration assigned, in the group's
  account. Delete is not an identity question.
- **`gilbertstalwart`.** Nothing is set inside Stalwart for this and no
  capability is required of it: the group's mail is ordinary mail to the server.
- **`gilbertagents`.** Its catalogue is unchanged, and no automation gains a
  capability.

## Consequences

- **A group's Deleted Items and Junk Mail grow until an administrator empties
  them.** The quota they spend is the group account's, so the cost of the rule
  is paid by the group rather than by the person asking to delete. Worth
  knowing before an installation relies on members tidying.
- **A non-administrator cannot make a group message final, in any folder.**
  Filing it in the group's Deleted Items is where a member's version of "gone"
  stops, and the sentence a refused delete shows says what still works rather
  than only what does not.
- **A withdrawn administrator keeps the surface until the session is read
  again.** The flag is ADR 0001's, resolved at sign-in and re-read when the
  session state changes — a group added or removed is discovered at the same
  moment. Between those moments the client answers from what it holds, so a
  person removed from the admin group can still destroy a group's mail in a tab
  that was open across the change. It is the same order of staleness ADR 0001
  already accepts for the client's view of its own privilege, and the server's
  own door is the one that closes it.
- **Deleting a folder stops on a folder that holds mail**, for a
  non-administrator: it is one of the three things that destroy, and it is
  refused by the folder's own count. An empty folder still goes.
- **The rule is only as good as the client that carries it.** Another client
  reaches the same account and destroys the same mail. An installation that
  needs the guarantee rather than the convention has to take it up in the mail
  server, where the membership model is the thing to change.
- **The surfaces lose the entries they cannot carry**, rather than offering them
  and refusing afterwards: the final delete is disabled where the reader is
  refused, an emptying entry that would destroy is not drawn, and a swipe
  direction with nothing it may do does not move the row — the same treatment a
  swipe out of the archive already gets.

## References

- `web/src/lib/mailDelete.ts` — the rule: what a delete does, which refusal it
  answers, the final folders found by role, and the three questions the surfaces
  ask (`deleteEffect`, `deleteEntryOffered`, `messageDeleteOffered` /
  `folderDeleteOffered`)
- `web/src/lib/useMayDestroy.ts` — the one hook every surface reads it through,
  so the drawn answer re-renders when the admin flag or the account set moves
- `web/src/store/mail.ts` — the guards on `destroy`, `emptyMailbox` and
  `destroyMailbox`, each answering a `DeleteOutcome` in which the rule's refusal
  and the server's own are different codes, and the module-private
  `destroyEmails` the guarded paths funnel through
- `web/src/store/__tests__/group-mail-delete.test.ts` — the invariant: a
  member's destroy in a group reaches no server, an administrator's does, an
  account nobody has classified yet is refused while the reader's own is served,
  a mixed selection still reports what it did, and a refused direction resolves
  to nothing
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
- `web/src/lib/mailAccounts.ts` — `isOwnMailAccount`, the question the rule asks
  before anything else, and `isGroupMailboxAccount`, the classifier the group
  surfaces read for their own purposes (the rule itself does not need it: it
  refuses everything that is not provably the reader's own)
- ADR 0001 — administration is Stalwart's, and `isAdmin` is its answer
- ADR 0005 — a group owns its data, and membership is the grant
- ADR 0007 — identity in a group, and the sending path the drafts composer uses
