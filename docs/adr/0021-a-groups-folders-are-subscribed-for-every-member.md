# ADR 0021 — A group's folders are subscribed for every member

Status: Proposed

Implementation: Built. One answer for whose tree is on screen
(`isOwnMailAccount` in `web/src/lib/mailAccounts.ts`, read by
`web/src/views/mail/MailboxTree.tsx` for the active account's tree, for the
sections below it and for the folder menu's own entry), one write for the
subscriptions membership owes (`unsubscribedFolders` in
`web/src/lib/groupSubscriptions.ts`, applied by `adoptMailboxes` in
`web/src/store/mail.ts` wherever a mailbox tree is read). The invariants are
pinned in `web/src/store/__tests__/mail-group-subscriptions.test.ts`,
`web/src/views/mail/__tests__/group-tree.test.tsx` and
`web/src/lib/__tests__/groupSubscriptions.test.ts`, and the mock hands a member
its group's folders unsubscribed as a real server does (`server/src/mock/index.ts`,
asserted in `server/src/mock/group-mailbox.test.ts`).

## Context

A group mailbox is an account a member reaches by **membership** rather than by
a share (ADR 0005): the account is granted to them, and the whole of it comes
with the grant. A subscription is not part of that grant — `isSubscribed` is
read state kept **for one principal**, and being added to a group writes none of
it. Read off a live installation (2026-09-22, `Mailbox/get` on a group of four
members, folder for folder): the administrator held 12 of its 13 folders
subscribed, and every member held **0 of 13** — the same tree, the same ids, the
same parentage, the same rights, one field apart. The folders they had been in
the group for months to see, and the ones created since, were all of them
unsubscribed.

Two consequences followed from that one field.

- **The sidebar has an answer of its own, and needs it.** A tree filtered by
  subscription would be Inbox and nothing else for every member of every group,
  which is what `gilbertmailer` decided against: a tree that is not the reader's
  own is drawn **whole** (`buildMailTree` in
  `web/src/views/mail/MailboxTree.tsx`). That answer is why this is not a
  visibility bug inside Gilbert — and it also means the field stayed invisible
  to everyone who only ever looked through this client.
- **Every other client honours the field.** Thunderbird, Outlook, an IMAP
  client, the mail server's own webmail: a member who opens the group anywhere
  but here finds almost nothing of it, and nothing in the product told them why
  or gave them anything to do about it.

The product already has the vocabulary for the first half. A group's **address
books** answer a member without each of them adding the book, and the sentence
in `FEATURES.md` is *membership is the subscription*. What was missing was the
same sentence applied to the folders the membership is about.

## Decision

**Membership subscribes the group's folders: a client that reads a group's
folder list writes a subscription for every folder of it that is not
subscribed, and a tree that is not the reader's own is drawn whole whatever
that write does.**

- **One read, one rule, one write.** Every read of a mailbox tree goes through
  one adoption (`adoptMailboxes` in `web/src/store/mail.ts`), and the answer to
  *what is missing* comes from one module
  (`web/src/lib/groupSubscriptions.ts`), never from the surfaces that draw a
  tree. The three reads that exist — the probe that discovers which accounts are
  group mailboxes, an account's tree re-read on its own change beat, and the
  active account's tree — had been assembling the same map three times, and
  they now share the builder, the cache write and the reconcile with it.
- **Whose tree it is, is asked of the session.** The rule reads
  `isOwnMailAccount`, which the session answers at any moment, rather than the
  group classifier, which answers "group" only once the account probe has listed
  the account. That classifier is right for what it is for — the surfaces that
  offer group-owned creation — but a tree drawn on it fails closed for the whole
  window a boot sits in, and failing closed here means a member's group tree,
  whose folders arrive unsubscribed, drawn down to Inbox alone. The active
  tree, the sections below it and the folder menu now ask one question the same
  way (ADR 0015 makes the same move for the same reason: an account nobody has
  classified yet is not the reader's own).
- **Never the reader's own mailbox.** Their own tree keeps its subscriptions,
  because there an unsubscribed folder is one they hid themselves, and the
  entry that hides one exists only there. Nothing about the write touches an
  account that is the reader's own.
- **The write rides the read, and is idempotent.** It is asked on every read of
  a group's folder list, and sends nothing when nothing is missing — so a folder
  that appeared a moment ago, whoever created it, is covered by the same rule
  that covers the folders that were already there, without an event to catch.
  One reconciliation runs per account at a time, and the batch is cut by the
  session's own `maxObjectsInSet`.
- **A refusal is remembered, not retried.** Whether a **member** may write
  `isSubscribed` on a folder of their group is not verified: a subscription is
  read state kept for one principal, and the server is of two minds about that
  write elsewhere — it accepts it on a calendar shared read-only and refuses it
  on an address book. A refusal is logged once, remembered for the rest of the
  session, and the tree is drawn whole either way, so the reader loses nothing
  either way. The probe that settles it is owed, and named in the
  `gilbertstalwart` skill.
- **In a group nothing is hidden per user.** *Hide from list* is not offered on
  a group's folder (the tree does not read the field, so hiding one would do
  nothing to this client), which is also why setting the field for a member
  cannot be taking a decision away from them: in a group, no member has said
  anything with it.

### Rejected — subscribing members when they are added to the group

Gilbert does not administer the directory (ADR 0001): creating a group, adding a
member and the grants that come with it are the mail server's own
administration. An installation-side job that walked the groups would be a
second writer of membership, running the reconciliation this client already
performs from the read that shows it is missing — and it would still have to
reach each member's own subscription record, which is per principal and written
by that principal.

### Rejected — leaving the field alone, since this client ignores it

That is the state the decision was made from: every member's group is invisible
in every client but this one, silently, with nothing to point at. A rule that
keeps *this* client whole is not a reason to leave the account half-granted
everywhere else.

### Rejected — writing it from the tree that draws it

The write belongs where the tree is adopted, not where a row is drawn: a
sidebar that renders is not a reason to mutate an account, and two trees on
screen at once — an active group and a group below it — would have written
twice for the same read.

## What is not verified yet

Whether a **member** may write `isSubscribed` on a folder of their group is
read rather than confirmed. The folders grant them everything the write could
need (`myRights` on a group's folder carries rename, delete and share for every
member), and a subscription is the reader's **own** record rather than the
folder's, so the write has every reason to be accepted — but the same tree has
read the server refuse that field on an address book shared read-only while
accepting it on a shared calendar, which is why nothing here depends on the
answer: a refusal is remembered for the session, and the tree is drawn whole
whether the write lands or not. What a running server still has to be asked:

<!-- owed: member-subscription-write -->
1. that `Mailbox/set` with `update: {<folder id>: {isSubscribed: true}}` on a
folder of a group the credential is a member of answers `updated`, and that a
read back reports the folder subscribed — the write the decision above rests
on;
2. what a refusal looks like when it is not granted — a method-level error
inside a 200, an HTTP status, an `invalidProperties` — so that the line the
client logs says which one it was;
3. whether a folder **moved** within the group keeps the subscription its member
held. The reconcile runs on every read, so the product is unaffected either way;
what this settles is what a dated sentence in `gilbertstalwart` may claim.

Asked by `scripts/probe-group-subscriptions.mjs`, run by hand the way the other
probes are.

## Consequences

- **The client writes to a group account for the reader's own comfort**, once
  per folder per member that lacks the subscription. It is bounded by the
  folders that exist, it is idempotent, and a failure is not shown to the
  reader because the tree they are looking at is whole regardless.
- **A group's folders become subscribed for every member who has opened this
  client since the change.** Until a member's client reads the tree once, their
  record stays as the server left it; a member who never opens Gilbert still
  cannot read the group from another client. The rule reaches every member whose
  client reads the tree, which is what a client-side rule can do.
- **`isSubscribed: false` cannot mean "deliberately hidden" in a group** — the
  control is not offered there. If a per-member hide is ever wanted inside a
  group, this record is what has to change with it: the reconciler would undo
  each such choice on the next read.
- **The tree rule stands on a question the session answers**, so a member's tree
  is whole from the first frame after sign-in, before the account probe has
  answered and whatever the probe answers later. A probe that fails leaves the
  tree whole rather than half-drawn.
- **One adoption, three readers**: the probe, the change beat and the active
  tree can no longer disagree about what a mailbox tree is, and the reconcile
  cannot be reached by two of them and forgotten in the third.

## References

- `web/src/lib/groupSubscriptions.ts` — `unsubscribedFolders`, the whole rule:
  which folders of a tree membership owes a subscription to
- `web/src/lib/mailAccounts.ts` — `isOwnMailAccount`, the question that decides
  whether the rule applies at all; `isGroupMailboxAccount`, the classifier the
  group-owned creation surfaces keep asking
- `web/src/store/mail.ts` — `mailboxMap`, `adoptMailboxes` and
  `ensureSubscribed`: the one builder, the one guard and the one write, read by
  `loadMailboxes`, `refreshAccountTree` and `discoverMailAccounts`
- `web/src/views/mail/MailboxTree.tsx` — the tree rule and the folder menu, both
  reading the same answer, so hiding a folder is offered exactly where a
  subscription means something
- `web/src/store/__tests__/mail-group-subscriptions.test.ts` — the write: one
  `Mailbox/set` naming exactly the folders that are not subscribed, none when
  there is nothing to write, and none at all for the reader's own mailbox
- `web/src/views/mail/__tests__/group-tree.test.tsx` — the tree: a group's
  folders drawn whole with the account probe still empty, and the same tree
  filtered when it is the reader's own
- `web/src/lib/__tests__/groupSubscriptions.test.ts` — the pure answer, at every
  depth
- `server/src/mock/index.ts`, `server/src/mock/group-mailbox.test.ts` — the mock
  hands a member its group's folders unsubscribed, which is the state the write
  exists for
- ADR 0001 — the directory is the mail server's, so membership is written there
  and read here
- ADR 0005 — a group owns its data, and membership is the grant
- ADR 0015 — the other group rule this client keeps in one module, and the same
  reason for asking the session rather than the probe
