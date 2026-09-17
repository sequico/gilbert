# ADR 0016 — What notifies a closed Gilbert: the permission door, every mailbox, and chat

Status: Accepted

Implementation: Partly built. The permission door is built: the switch asks for
permission in its own gesture and nowhere else, `webPushBlocker()` names why a
browser cannot be offered background notifications — the iOS install case among
them — and the surface composes the sentence from that code
(`web/src/lib/webpush.ts`, `web/src/lib/webpushEnable.ts`,
`web/src/views/settings/NotificationsSettings.tsx`). Not built: the payload for
the group mailboxes the subscription already wakes for, the worker's rule for
the generic wake-up that double-notifies today, and the chat read. What those
three rest on is read from Stalwart's source at v0.16.22 and written down below;
the one thing still owed is seeing a running server do it.

## Context

Two transports already reach a client, and they are not the same subscription.

**gilbertserver's own subscription** registers one JMAP `PushSubscription` per
account, POSTs to a callback of *ours*, and fans each change out to that
account's open tabs (ADR 0009). It holds no upstream connection per tab, and
what it can reach is bounded by a tab being open: the last hop is the browser's
`EventSource`, which lives exactly as long as a page does.

**gilbertmailer's own subscription** is the browser's: a `PushSubscription`
created by the client in the reader's own session, naming the browser's push
endpoint as its `url`, signed by Stalwart with VAPID (RFC 9749). Stalwart POSTs
to the browser vendor's push service directly, the service worker wakes and
shows the notification (`web/public/sw.js`). Nothing on that path touches
gilbertserver — no relay, no secret of ours, no third party beyond the push
service Web Push requires of everybody.

That second path is what notifies a closed client today, and Stalwart reads
wider than the client's own payload asks for. A subscription is stored in the
account that asked for it (`access_token.account_id()`, `Collection::Principal`
/ `PrincipalField::PushSubscriptions`), and the push server registers each
**verified** one for every account in that token's `member_ids()` — its own
account **plus its group mailboxes**, which come from the account's
`member_group_ids` (`crates/jmap/src/push/set.rs`,
`crates/services/src/state_manager/push.rs` `load_push_subscriptions`,
`crates/common/src/auth/access_token.rs`). What wakes it is the subscription's
own `types` bitmap, and `Email` is in it: so a delivery to a group mailbox
already wakes a closed client today.

It wakes it **generically**, and that is the gap: an email event for an account
with no `emailPush` entry is degraded to a plain `StateChange`
(`crates/services/src/state_manager/push.rs`), and the worker renders any
payload that is not an `EmailPush` as "New mail" with no sender, no subject and
no name of the mailbox it landed in (`web/public/sw.js`). What a group is
missing is the payload, not the wake-up.

Chat is missing entirely. A chat message is one JSON node in the group
account's `gilbert/chat`, with a per-member read marker in `gilbert/chat-state`
(ADR 0005), and it is live over `FileNode` state changes — live while a tab or
gilbertserver holds a connection, and invisible to a closed client because
`types: ["Email"]` names no `FileNode`. A new chat node *is* a `FileNode`
change, so the type is all that is missing to wake for one: `emailpush` carries
`Email` objects and has no vocabulary for a file, and Stalwart's only push
filter is email-shaped (`EmailPush.filter` is `Filter<EmailFilter>`).

The permission is the OS's, granted to the origin and never to an
installation's "app": Web Push needs the browser's notification permission, and
on iOS that permission is offered only to a Home Screen installation at all
(`display-mode: standalone`). A permission prompt with no gesture behind it is
one iOS refuses outright and every other browser teaches people to dismiss, and
nothing in the surface has told a browser that cannot be granted the permission
from one that simply has not been asked.

Two facts about the account a background subscription spends are worth holding
while reading this: a principal's push subscriptions are a bounded pool —
fifteen, the `max_subscriptions` default the registry ships — shared with
gilbertserver's own per-account row; and the browser is woken by a push whether
or not the notification it produces is one the reader wanted.

## Decision

### The permission is asked for at a door the reader opened

The notification switch asks for the permission **in the gesture that turned it
on**, and never from an effect, a timer or a start-up path. A browser that has
already answered is not asked again: `denied` is final inside the app, and the
surface says where it is undone (the browser's own settings for this site)
rather than offering a button that cannot work. An answer the browser has
forgotten while the switch stayed on is said out loud, and the gesture that
repairs it is the switch's own — turning it off and on again asks, which is what
the sentence says. The section draws no second door of its own, because a
gesture-shaped button here and an effect there would be the same request under
two guises, and only one of them is the reader's.

What the switch offers is decided by a reason rather than a boolean:
`webPushBlocker()` answers the surface with a code it composes a sentence from,
separating the browsers and servers that cannot do Web Push from the one
platform where the reader has to install the app first — on iOS the hint is the
install instruction, in Safari, and the switch is not drawn as though switching
it on were possible.

The device must be one the reader marked as their own, which is already
required of the existing path and is not relaxed: a subscription outlives the
tab, so on a shared machine it would keep delivering mail after the reader had
gone.

### A background subscription covers every mailbox the reader may open

The accounts a browser registers for become **the reader's own, plus every
account the mail probe answered with a folder tree** — `mailAccounts` with
`kind: "group"`, the one classifier (ADR 0001 removed the product-admin special
case). A calendar or files share is not a mailbox and is not registered.

They go into **one** subscription, in the reader's own account, as the
`emailPush` **map** Stalwart's object is: one entry per account, each with its
own filter, properties and urgency (`EmailPush` in
`crates/email/src/push/mod.rs`, filled entry by entry by `parse_email_push` in
`crates/jmap/src/push/set.rs`). The method is addressed at the reader's own
account, which is where a subscription is stored however the call is addressed,
and the group accounts are named in the map.

Each account's entry carries its own filter: that account's Inbox, unread, so
spam and filed mail still never leave the server. The payload stays what the
server already knows how to send — sender, subject and preview where the server
implements `emailpush` — because the alternative is carrying mail content
through our own process for no gain.

Membership is the whole of the permission, and it is the server's answer rather
than ours: an entry for an account the token is not a member of is refused with
`forbidden` — "No access to one of the accounts in the emailPush map." — where
membership means the reader's own account or a group they belong to
(`is_member`, `crates/common/src/auth/access_token.rs`). A calendar or a files
share cannot be named, and an account named in the map is one the subscription
already receives notifications for, so the map widens what is *described*, never
what is watched.

The account list is derived at registration time, which is every app start:
join a group and the next start covers it, leave one and its entry goes with the
others our own hand releases. A closed client is therefore not "subscribed to
Gilbert" but subscribed to the accounts the session had at the last start.

Two properties of the object are worth writing down because a client is tempted
to read them the other way. A subscription with **no `types` at all** is
`Bitmap::all()` — omitting the property asks for everything, not for nothing
(`validate_push_value`). And the **URL is validated**: `https` only, no
credentials in it, and no local or reserved address (`validate_push_url`).

### Chat reaches a closed client as a wake-up and a read

Chat cannot ride an `EmailPush`, so it rides the mechanism Stalwart does have:
`types` gains `FileNode`, which every account the subscription serves is
watched for. There is no way to narrow it — the only filter a subscription
carries is `EmailPush`'s, and it is email-shaped — so the wake-up is **every
file write in every account the device is subscribed for**: the group's chat,
its agent documents and jobs, an upload, and the reader's own `settings.json`.
Stalwart offers no filter that would make it the chat folder alone, and asking
for a narrower wake-up would mean asking upstream for one.

A state change is all the worker gets, and reading the message is the worker's
own work — it already holds the door for that: a same-origin `fetch` to
`/api/jmap` carries the session cookie, and `sw.js` does exactly this today to
archive from a notification.

The rule the worker applies, in order:

- the account's chat folder is one the briefing names (below), so a `FileNode`
  change in an account with no chat is a wake-up that notifies nothing;
- read the newest nodes of that folder, exactly as the client's own page read
  does, and take those newer than the **watermark the app wrote**: an instant,
  not a document. The worker does not read the reader's marker in
  `gilbert/chat-state`; the app hands it what it last had, the same way it hands
  it the archive mailbox id (`web/src/lib/swFacts.ts`), because a marker read is
  a second blob fetch on every wake-up and a waterfall the app has already paid
  for;
- skip a message the reader wrote (`from` is the reader's own address), which is
  the ordinary case for a phone that just sent one — a write its own device made
  wakes it too, because the subscription is registered for the account it wrote
  in;
- notify per node, tagged by node id, so a re-push or a second change in the
  same folder collapses rather than stacks, at most three per wake-up, and with
  the app icon marked by the dot it already uses rather than by a count the
  worker cannot know;
- stay silent when one of our own windows is focused on that chat, which is the
  suppression `showNotification` already does for a tab.

An agent's message in a group's chat is a message from an address that is not
the reader's, and it notifies like a member's. Nothing here is chat-specific
reconciliation: the documents, the marker and the transcript are exactly what
ADR 0005 decided.

### A plain state change notifies only where there is no payload

Today a delivery produces **two** pushes to the same device: the storage
transaction that wrote the message broadcasts a `StateChange`, and the delivery
broadcasts its own `EmailPush` (`crates/common/src/storage/transaction.rs`,
`crates/email/src/message/delivery.rs`), and both are POSTed. The worker turns
anything that is not an `EmailPush` into "New mail", so a reader with the app
closed is shown two notifications for one message — the rich one and a generic
one that names nothing.

The rule is per account, and the briefing already carries the answer: a
`StateChange` names the accounts it changed in `changed`, and the worker notifies
generically **only for an account the briefing does not list as having a rich
payload**. That is exactly the group case, where the generic notification is the
whole of what arrives — and where it can now name the mailbox it landed in
instead of saying "New mail". For the reader's own account, where the payload
carries the message, the state change is the duplicate and says nothing.

### The briefing the worker reads grows with it

The facts a tab writes for the worker (a cache entry, not a store) grow from
"the account, the archive folder, the strings" to what a notification now has to
know per account: its Inbox and archive ids, its chat folder, its name, the
watermark, and the reader's own address. It is rewritten whenever any of it
could have changed — a new group, a new language, a folder moved — because it is
what the worker will still be reading a week later with no tab open to correct
it.

### What the same three kinds do while the tab is open

A change does not mean different things depending on whether a window is
visible. Mail arriving in a group mailbox and a chat message notify from the
same store changes (`notifyNewMail` in `web/src/store/mail.ts`, chat's
`applyChanges` in `web/src/store/chat.ts`) with the same suppression rule, so a
reader who keeps Gilbert open on a group does not go quiet at the exact moment
they are using it.

### What is not done here

- **No sender of ours.** gilbertserver sending the notification itself — a
  VAPID key pair of the deployment, payload encryption, a subscription store, a
  route to register one — would carry chat content in the payload instead of
  the wake-up read. It is recorded as the alternative, not chosen: it puts a
  secret and a sender in a process whose value here is having neither, and it
  duplicates for `Email` what Stalwart already does natively. It becomes worth
  revisiting when a measurement of wake-up volume says the read is the problem.
- **No notification for calendars, contacts or files**, and none for an agent's
  own runs: the group has chat for that.
- **No third-party push service and no native app.** FCM and APNs are reached
  through the browser's own push service, which is the only way Web Push is
  allowed to work.

## Consequences

- A phone with Gilbert closed is woken by group mail and by chat, on the same
  permission and the same trust requirement the personal path already carries —
  and for group mail it is woken today, with a notification that says only that
  something arrived.
- **One row per device, not one per account.** The `emailPush` map is what
  widens the coverage, so a member of six groups spends one of the principal's
  fifteen subscriptions and not seven — which matters because gilbertserver's
  own fan-out row for the same account spends from the same fifteen, and
  because a pool that fills leaves every further create refused with `overquota`
  and the account back on the relay it does not use here.
- A browser is woken by *any* file write in any account it is subscribed for
  once `FileNode` is in `types`, and the reader sees nothing for most of them —
  an agent's document, an upload, the reader's own stored settings. This is
  battery and push-service traffic rather than user noise: the notification, not
  the wake-up, is what the watermark and the sender rule gate.
- The double notification is fixed by the same change that adds group mail: a
  `StateChange` notifies generically only for the accounts the briefing does not
  describe, so a delivery to the reader's own Inbox stops producing a second,
  nameless notification beside the one that names the sender.
- `PushVerification` stays one pending code per device, and the reason is now
  the server's own: only the **newest** unverified subscription of an account is
  sent a verification POST per pass, and the throttle on it is per account
  (`last_verify` in `crates/services/src/state_manager/push.rs`). One
  subscription per device makes that a non-question; several would have taken
  turns. The worker answering the verification directly remains the shape for a
  device that holds more than one, and the account that issued a code is the one
  it belongs to.
- Nothing about gilbertserver changes: `PUSH_MODE`, `PUSH_STATE_TYPES` and the
  fan-out are untouched, and a deployment with no actor identity still has the
  relay.
- The failure modes stay readable: no push key, no `emailpush`, an old browser,
  a denied permission and an untrusted device each keep their own sentence, and
  a wake-up the worker cannot read (session gone, folder moved) notifies
  nothing rather than inventing a sender.

## Invariant tests

A mechanism this record names is tested where it is built, and the tests still
owed are owed with it. Each fails when its mechanism is removed, which is the
point of naming them rather than waiting for somebody to notice.

Built, beside the permission door — the reason is what the surface reads, so a
boolean that came back would fail here:

- `webPushBlocker()` separates a browser that can be pushed from one whose
  server publishes no key, from an iOS browser that needs the install, from one
  with no Push API at all (`web/src/lib/__tests__/webpush.test.ts`).
- Entering the notifications section asks for nothing; a switch on over an
  answer the browser has forgotten is said out loud and draws no button of its
  own; and the answer the browser then gives is what the reader is told
  (`web/src/views/settings/__tests__/notifications-permission.test.tsx`).

Owed with the steps below:

- `subscriptionPayload()` builds one `emailPush` entry per target account, each
  with its own filter, so dropping an account from the target list fails the
  test (`web/src/lib/__tests__/webpush.test.ts`).
- "This browser is subscribed" is true only when **every** target account holds
  this device's row, so one group whose registration failed reads as off rather
  than as push being on (`web/src/lib/__tests__/webpush.test.ts`).
- The worker notifies for a chat node, does not notify for the reader's own,
  does not notify at or before the watermark, and stays silent when a window of
  ours has that chat focused — loading `web/public/sw.js` against a stubbed
  `self`, `caches` and `clients`
  (`web/src/lib/__tests__/swChat.test.ts`).
- The document fields the worker reads (`v`, `from`, `at`, `text`) are pinned
  against `server/src/shared/chat.ts`, the one definition of a chat node, so a
  rename there cannot leave the worker reading a field nobody writes
  (`web/src/lib/__tests__/swChat.test.ts`).
- The briefing carries a chat account's folder, its watermark and the reader's
  own address (`web/src/lib/__tests__/swFacts.test.ts`).
- `server/src/mock` answers the group-account subscription and a chat `FileNode`
  change as the live server does, with the assumption pinned next to the
  simulation (`server/src/mock/index.ts`, its test).

## What is not verified yet

The shape above rests on Stalwart's own source, read at **v0.16.22** (the newest
release, published 2026-09-13) together with its `docs/http/jmap/push.md`: where
a subscription is stored, which accounts it is registered for, how an email
event is degraded to a state change without an `emailPush` entry, that the
`emailPush` map is per account and refuses an account the token is not a member
of, that `emailPush` carries `Email` properties only, that a missing `types`
means every type, and that push URLs are validated for scheme, credentials and
address class. Those are read facts rather than a running server's testimony,
and four things still want the server's word before the code is called done:

<!-- owed: live-emailpush-map -->
1. that a running 0.16 accepts the whole subscription as one row in the reader's
ow account — `types: ["Email", "FileNode"]` beside an `emailPush` map naming the
reader's account and each group, each with its own filter — and answers it
`created` rather than refusing a property;
<!-- owed: group-emailpush-payload -->
2. that a delivery to a group mailbox then arrives with the account named, in
the shape `sw.js` expects: an `EmailPush` whose `accountId`/`changed` key is the
group, carrying that group's Inbox message rather than a bare state change —
which is what decides whether a group notification can offer its actions or
only open the mailbox;
<!-- owed: chat-wake-read -->
3. that a chat write actually wakes the worker — that a `FileNode` change in a
group account reaches a subscription whose payload it carries no part of — and
that what the worker then reads back through `/api/jmap` is the message whose
node changed;
<!-- owed: verification-per-device -->
4. that a device holding one subscription sees its verification arrive once, so
that the handshake `sw.js` already implements is enough for it; the server
sends a verification only for the **newest** unverified subscription of an
account, which is the same fact read from the other side.

Until they are answered the four items are the record's debt, and the
implementation marks them where the code owes them (the repository's
`ADR-0016 OWED:` convention).

## The order of the work

1. The permission door: the reason-shaped availability question with the iOS
   install case, the request inside the gesture, and the removal of the
   gesture-less request and the comment that describes it as lazy. **Built.**
2. Group mail: the `emailPush` map built from the probed `mailAccounts`, one
   entry and one inbox id per account, each account's filter its own, and the
   registration and release addressed at the reader's own account once rather
   than once per target. Personal mail stays what it is, and the step is not
   done until it still is.
3. The generic wake-up: `StateChange` notifies only for the accounts the
   briefing does not describe as carrying a payload, which is the group case —
   and which also stops the second, nameless notification a delivery to the
   reader's own Inbox produces today.
4. The briefing: per-account Inbox, archive and chat folder, the account's name,
   the watermark and the reader's own address.
5. `types`: the chat-capable accounts' wake-up gains `FileNode`.
6. Chat: the worker's read of the newest nodes, the sender rule, the watermark,
   the tag per node, and the suppression rule for a window of ours already on
   that chat.
7. The same kinds from the open-tab path, so a visible Gilbert is not the quiet
   one.
8. Settings and the record: the device-local switches for the new kinds, the
   policy entry and the settings surface, `FEATURES.md` (the notifications
   section and the capability table), `KNOWN-ISSUES.md` for what an operator
   has to know (the fifteen-subscription pool shared with gilbertserver's own
   row, iOS needing an installed app, a browser that must be running), and the
   mock in step with all of it.
9. The invariant tests above, and the checklist on real devices: an installed
   PWA on iOS 16.4+, and Chrome on Android with a manufacturer's battery saver
   on, which is where a correct implementation still looks broken.

## References

- `web/src/lib/webpush.ts` — `subscriptionPayload()`, `webPushBlocker()`, the
  per-device registration and its release
- `web/src/lib/webpushEnable.ts` — `registerThisBrowser()`, `renewWebPush()`,
  `webPushActive()`
- `web/src/lib/swFacts.ts`, `web/public/sw.js` — the briefing, the push handler,
  the `VERIFY_KEY` handshake, `runAction`
- `web/src/store/mail.ts` — `notifyNewMail()`, the per-account folder trees
- `web/src/store/chat.ts`, `web/src/lib/chat.ts`, `server/src/shared/chat.ts` —
  the chat node and its marker
- `web/src/views/settings/NotificationsSettings.tsx` — the door
- `server/src/mock/index.ts` — the simulated server
- Stalwart v0.16.22 — `crates/jmap/src/push/set.rs` (storage, the `emailPush`
  map, validation), `crates/email/src/push/mod.rs` (`PushSubscription`,
  `EmailPush`), `crates/services/src/state_manager/push.rs` (registration per
  member account, the verification rotation),
  `crates/services/src/state_manager/email_push.rs` (the filter's evaluation),
  `crates/common/src/auth/access_token.rs` (`member_ids`),
  `crates/common/src/storage/transaction.rs` (the state change every write
  broadcasts), `crates/registry/src/schema/structs_impl.rs` (`max_subscriptions`
  default 15), and `docs/http/jmap/push.md`
- ADR 0009 — gilbertserver's own subscription, which fans out to tabs
- ADR 0005 — chat's documents and the per-member marker
- ADR 0001 — what a group mailbox is, and why no name-based exclusion remains
