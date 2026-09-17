# ADR 0015 — A group's mail is deleted by an administrator only

Status: Proposed

Implementation: Not built. This record is written before the change that carries
it, so nothing refuses a destroy in a group yet.

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
  them. Read at the newest release tag (`crates/jmap/src/email/set.rs` consults
  `shared_mailboxes`; `crates/common/src/auth/access_token.rs` treats
  membership as access). There is no rank inside a group, and no per-account
  or per-collection right that would say "this member may bin the group's mail
  and that one may not".
- **Its destroy permission is role-wide.** `Email/set` with a `destroy` is
  gated on one permission for the whole role, so withdrawing it closes
  destroying everywhere the holder works — their own mail included — which is
  not a trade the product accepts. Setting it is the mail server's own user
  administration, which ADR 0001 puts outside the product.
- **Gilbert has one administration, and it is installation-wide.** The session
  carries a single `isAdmin` flag, resolved from Stalwart's own permission list
  (ADR 0001). There is no group administrator: a group mailbox is an ordinary
  working group, and a member cannot even read their group's roster — that read
  needs a permission the built-in User role does not carry (`gilbertstalwart`).

What is reachable from the client, and destroys a message for good, is three
things: deleting a message that already sits in Deleted Items or Junk Mail,
emptying one of those two folders, and deleting a folder **together with** the
mail in it. Everything else a member does in a group — moving, labelling,
archiving, replying, forwarding, drafting, sending — is a change that can be
taken back or put right by somebody.

## Decision

**In a group mailbox, mail is destroyed by an installation administrator only.
Every other member is refused the three entry points that destroy, and told so
in one sentence.**

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
  disagreement the surfaces had with one another before it existed — whether
  Junk Mail counts alongside Deleted Items when a delete is described as final.
- **The guard is where the effect is.** `destroy`, `emptyMailbox` and
  `destroyMailbox(id, removeEmails)` in the mail store refuse in a group, so the
  action is refused whatever calls it — a menu, a keyboard shortcut, a swipe —
  and the surfaces draw themselves from the same answer so that nothing offers
  what would be refused.
- **A drafts composer is not in the way.** Discarding a draft, and the write
  that replaces a draft when a message is sent, are the compose store's own
  `Email/set` calls (ADR 0007's sending path), not the mail store's delete.
  A member's unsent mail goes away in a group exactly as it does anywhere.
- **The agents hold no delete at all.** The capability catalogue
  (`AGENT_ACTION_SPECS`) names no action that destroys mail, so what this record
  grants an administrator is a surface for a person; nothing an automation can
  be written to do changes with it.
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

- **ADR 0001.** `isAdmin` keeps its meaning — Stalwart's answer, re-resolved on
  every privileged call. Here it decides an action in the client; the server is
  still the only door that guards an account, and this does not add one.
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

- `web/src/lib/mailDelete.ts` — the rule: what a delete does, and who may take
  one, with the refusal sentence
- `web/src/store/mail.ts` — `destroy`, `emptyMailbox`, `destroyMailbox`, where
  the guard sits on the effect
- `web/src/lib/swipe.ts` — a direction with no meaning here resolves to nothing
- `web/src/views/mail/` — `MailView`, `MessageList`, `MessageView` and
  `ThreadView`, which ask the rule before drawing an entry
- `web/src/lib/mailAccounts.ts` — `isGroupMailboxAccount`, the classifier the
  rule reads a group by
- `web/src/store/__tests__/group-mail-delete.test.ts` — the invariant: a
  member's destroy in a group reaches no server, an administrator's does
- ADR 0001 — administration is Stalwart's, and `isAdmin` is its answer
- ADR 0005 — a group owns its data, and membership is the grant
- ADR 0007 — identity in a group, and the sending path the drafts composer uses
