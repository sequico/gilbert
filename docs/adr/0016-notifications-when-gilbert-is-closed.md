# ADR 0016 — What notifies a closed Gilbert: the permission door, every mailbox, and chat

Status: Accepted

Implementation: Partly built. The permission door is built: the switch asks for
permission in its own gesture and nowhere else, `webPushBlocker()` names why a
browser cannot be offered background notifications — the iOS install case among
them — and the surface composes the sentence from that code
(`web/src/lib/webpush.ts`, `web/src/lib/webpushEnable.ts`,
`web/src/views/settings/NotificationsSettings.tsx`), and a nudge asks when a
switch is on and the browser has not answered (`shouldAskForNotifications`,
`web/src/App.tsx`). The noise half is built:
the subscription names `EmailDelivery` rather than `Email`, so a read or a move
no longer arrives as mail, the payload asks for `id` and `threadId`, which is
what lets a notification be tagged and carry its actions, and the worker stays
quiet while a focused window of this app is on screen — all three pinned by
`web/src/lib/__tests__/swPushRules.test.ts` and the payload's own assertions.
The open-tab chat half is built: a message from somebody else notifies from the
same live change mail does, sound and system notification alike, and the
reader's own never does (`notifyNewChat`, `web/src/store/chat.ts`, pinned by
`web/src/store/__tests__/chat-notify.test.ts`). The closed-client chat half is
built: a group in the briefing puts `FileNode` in the subscription's `types`,
the reader's chats travel with the folder and the watermark they need, and the
worker reads the newest nodes back and notifies what is newer than the
watermark and not the reader's own (`web/public/sw.js`, `web/src/lib/swFacts.ts`,
`web/src/lib/webpush.ts`, pinned by `web/src/lib/__tests__/swChat.test.ts`).
Built: the payload for the group mailboxes the subscription serves — the
`emailPush` map names every account with a known Inbox, each with its own filter
— the generic wake-up narrowed to the accounts the briefing does not describe,
and the open-tab path's group-mail half (`notifyGroupMail`). What those rest on
is read from Stalwart's source at v0.16.22 and written down below; what is still
owed is seeing a running server do it.

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
own `types` bitmap, and `EmailDelivery` is in it: so a delivery to a group
mailbox already wakes a closed client today.

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
`types: ["EmailDelivery"]` names no `FileNode`. A new chat node *is* a
`FileNode` change, so the type is all that is missing to wake for one:
`emailpush` carries `Email` objects and has no vocabulary for a file, and
Stalwart's only push filter is email-shaped (`EmailPush.filter` is
`Filter<EmailFilter>`).

**Why the bitmap names `EmailDelivery` and not `Email`.** `Email` changes on
every read, flag and move, from any client, and every one of those arrived as a
push the worker could only render as "New mail" — the app has its own event
stream while it is open, so this channel exists for when it is not.
`EmailDelivery` changes only when a message is delivered, and a subscription
carrying an `emailPush` filter is sent a delivery as an `EmailPush` alone. That
is what makes this channel mean "mail arrived" and nothing else.

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
the sentence says. Beside the switch the app also **nudges** when a switch is on
and the browser has still not been asked: a toast carrying a button, and the
button is the gesture (`web/src/App.tsx`). Nothing asks from an effect, a timer
or a start-up path — the request is still the reader's — and a browser that has
already answered, either way, is never nudged. The nudge is shown at most once a
week on a device, so it reminds rather than nags (`notificationAskDue`).

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

The account list is derived at registration time, and re-derived when the
probed group mailboxes change: joining a first group or leaving a last one
re-registers the device, because a subscription's `types` are fixed when it is
created and an extension only moves `expires` (`reregisterWebPush`). A closed
client is therefore subscribed to the accounts the session had at the last
registration.

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
generically **only for an account the briefing lists without an Inbox** — one
the `emailPush` map has no entry for, so this state change is the whole of what
arrives, and the briefing can name the mailbox it landed in. For every described
account — the reader's own, and each group with a known Inbox — the state change
is the duplicate of the payload and says nothing.

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
- The double notification is fixed in two steps, and the first is built: the
  subscription names `EmailDelivery` rather than `Email`, so a read, flag or
  move from any client no longer arrives at all, and a delivery to the reader's
  own Inbox produces the `EmailPush` that names its sender rather than a second,
  nameless notice beside it. What is left is the group case, which needs the
  second step: a `StateChange` notifies generically only for the accounts the
  briefing does not describe.
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
- `shouldAskForNotifications` asks while a switch is on and the browser has not
  answered, and never after an answer; the cooldown separates one ask from the
  next (`web/src/lib/__tests__/notificationAsk.test.ts`).
- A change in the group mailboxes re-registers the device, replacing the row
  rather than extending it, because `types` cannot be changed after the fact
  (`web/src/lib/__tests__/pushRegistration.test.ts`).
- A chat message from somebody else notifies from the live store change, the
  reader's own does not, and the two switches gate it
  (`web/src/store/__tests__/chat-notify.test.ts`).
- The worker's chat rules — notify for a node from somebody else, not the
  reader's own, not at or before the watermark, and read the newest page of the
  folder from its end — held by reading `web/public/sw.js` back
  (`web/src/lib/__tests__/swChat.test.ts`), and the briefing carrying a chat's
  folder, watermark and the reader's address
  (`web/src/lib/__tests__/swFacts.test.ts`).

Built with the map:

- `subscriptionPayload()` builds one `emailPush` entry per target account with a
  known Inbox, each with its own filter, and none for one without, so dropping an
  account from the target list fails the test
  (`web/src/lib/__tests__/webpush.test.ts`).
- A change in the accounts the subscription covers re-registers the device,
  because the map and the `types` are fixed at creation (`web/src/App.tsx`).
- The worker announces a group's mail from the open-tab path, names the group in
  its notification, and notifies generically only for an account the briefing
  lists without an Inbox (`web/src/store/__tests__/group-mail-notify.test.ts`,
  `web/src/lib/__tests__/swChat.test.ts`).

Owed with the steps below:

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
and five things still want the server's word before the code is called done:

1. **Confirmed** live on 0.16.23 (2026-09-24): a running server accepts the whole
subscription as one row in the reader's own account — `types: ["EmailDelivery",
"FileNode"]` beside an `emailPush` map naming the reader's account and a group,
each with its own Inbox filter — and answers it `created` rather than refusing a
property;
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
account, which is the same fact read from the other side;
<!-- owed: degraded-statechange-type -->
5. **which type a degraded `StateChange` carries** when a delivery lands in an
account the subscription serves and no `emailPush` entry describes — which today
is every group mailbox. The bitmap decides what a subscription is sent, so if
that state change names `Email` rather than `EmailDelivery` then a subscription
asking for `EmailDelivery` alone is sent **nothing** for a group delivery, and
the notification that today says "New mail" for it stops arriving in silence.
What the source says is that the delivery is degraded to a plain state change;
what it does not say, anywhere this tree has read, is which name that state
change wears. Everything about group notifications that is already built rests
on the answer, which is why it is a probe of its own rather than a note inside
the one above — `scripts/probe-degraded-statechange.mjs`, run by hand against a
real instance, which asks it two ways: the event stream filtered to
`EmailDelivery`, and a subscription registering that type alone with no
`emailPush` entry so every delivery it could receive arrives degraded.

Until they are answered the five items are the record's debt, and the
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
   done until it still is. **Built.**
3. The generic wake-up: `StateChange` notifies only for the accounts the
   briefing does not describe as carrying a payload — an account it lists
   without an Inbox, so with no entry in the map — and names it. A described
   account's state change is the duplicate of its `EmailPush` and says nothing.
   **Built.**
4. The briefing: per-account chat folder, the account's name, the watermark, the
   reader's own address and the account's Inbox id, which the notification's
   deep link is built from. **Built.**
5. `types`: the chat-capable accounts' wake-up gains `FileNode`. **Built.**
6. Chat: the worker's read of the newest nodes, the sender rule, the watermark,
   the tag per node, and the suppression rule for a window of ours already on
   that chat. **Built.**
7. The same kinds from the open-tab path, so a visible Gilbert is not the quiet
   one: the chat half is `notifyNewChat`, and the group-mail half is
   `notifyGroupMail`, called by the dispatcher for a non-active account's Email
   change. **Built.**
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
- `scripts/probe-degraded-statechange.mjs` — the fifth item of debt, asked two
  ways (the filtered event stream, and a subscription naming `EmailDelivery`
  alone with no `emailPush` entry)
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
