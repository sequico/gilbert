# ADR 0017 — What notifies a closed Gilbert: the permission door, every mailbox, and chat

Status: Accepted

Implementation: Partly built. The permission door is built: the switch asks for
permission in its own gesture and nowhere else, `webPushBlocker()` names why a
browser cannot be offered background notifications — the iOS install case among
them — and the surface composes the sentence from that code
(`web/src/lib/webpush.ts`, `web/src/lib/webpushEnable.ts`,
`web/src/views/settings/NotificationsSettings.tsx`). Not built: the coverage of
the group mailboxes and the chat wake-up, whose four live probes the section
below holds as owed.

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

That second path is what notifies a closed client today, and it is narrow:
`subscriptionPayload()` (`web/src/lib/webpush.ts`) asks for `types: ["Email"]`
and one `emailPush` entry, for `ownAccountFor(CAP.mail)` — the reader's own
account only — filtered to that account's Inbox, unread. So a message arriving
in a **group mailbox** reaches a closed client not at all, and neither does a
chat message.

Chat is one JSON node per message in the group account's `gilbert/chat`, with a
per-member read marker in `gilbert/chat-state` (ADR 0005), and it is live over
`FileNode` state changes — that is, live while a tab or gilbertserver holds a
connection. A new chat node *is* a `FileNode` change, so Stalwart can wake a
closed client for one. What it cannot carry is the message: `emailpush` is a
draft for `Email` objects, a `StateChange` names types rather than content, and
a `FileNode` has no payload vocabulary of its own.

The permission is the OS's, granted to the origin and never to an
installation's "app": Web Push needs the browser's notification permission, and
on iOS that permission is offered only to a Home Screen installation at all
(`display-mode: standalone`). A permission prompt with no gesture behind it is
one iOS refuses outright and every other browser teaches people to dismiss, and
nothing in the surface has told a browser that cannot be granted the permission
from one that simply has not been asked.

Two facts about the account a background subscription spends are worth holding
while reading this: an account's push subscriptions are a bounded pool — the
fifteen told about in `webpushEnable.ts`, shared with gilbertserver's own
per-account row — and the browser is woken by a push whether or not the
notification it produces is one the reader wanted.

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

Each account's entry carries its own filter: that account's Inbox, unread, so
spam and filed mail still never leave the server. The payload stays what the
server already knows how to send — sender, subject and preview where the server
implements `emailpush` — because the alternative is carrying mail content
through our own process for no gain.

The account list is derived at registration time, which is every app start:
join a group and the next start covers it, leave one and its subscription is
released by our own hand as it is today. A closed client is therefore not
"subscribed to Gilbert" but subscribed to the accounts the session had at the
last start.

### Chat reaches a closed client as a wake-up and a read

Chat cannot ride an `EmailPush`, so it rides the mechanism Stalwart does have:
`types` for a chat-capable group account gains `FileNode`. A state change is all
the worker gets, and reading the message is the worker's own work — it already
holds the door for that: a same-origin `fetch` to `/api/jmap` carries the
session cookie, and `sw.js` does exactly this today to archive from a
notification.

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
  the ordinary case for a phone that just sent one;
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
  permission and the same trust requirement the personal path already carries.
- The account's subscription pool is spent per browser: an Email subscription
  per account, and a `FileNode` one beside it wherever chat is involved unless
  the fourth probe below says that one subscription's `filter` can be read per
  type after all. A
  member of several groups therefore occupies several slots per device, against
  the bound of fifteen per account; that is the number to watch, and the reason
  the registration is per group mailbox and not per account the session lists.
- A browser is woken by *any* file change in a chat-capable group account when
  the `FileNode` subscription carries no usable filter, and the reader sees
  nothing for most of them. This is battery and push-service traffic, not user
  noise: the notification, not the wake-up, is what is gated by the watermark
  and the sender.
- `PushVerification` is no longer one pending code per browser. With more than
  one subscription the cache holds the last code and the others stay
  unverified — which reads as "push is on and nothing arrives" — so the worker
  answers the verification itself, as the comment on `VERIFY_KEY` already
  anticipates. The account that issued it is the one the code belongs to.
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

These are the first work, because each one changes the shape above if the
answer is not the expected one, and none of them has been tried against a live
0.16:

<!-- owed: push-per-account -->
1. whether one browser subscription may carry `emailPush` for several accounts,
   or whether it must be one subscription per account. The design above assumes
   the second and collapses to the first if the server allows it;
<!-- owed: group-subscription -->
2. whether a `PushSubscription/set` by a member in a **group** account is
   accepted at all, and whether that account's `emailPush` arrives with the
   payload naming the account — without which a group notification cannot offer
   archive or a deep link, and the honest fallback is a notification that opens
   the mailbox and nothing else;
<!-- owed: filenode-filter -->
3. whether a `FileNode` subscription accepts a `parentId` filter naming the chat
   folder, which is the difference between waking on chat and waking on every
   file change in the account;
<!-- owed: filter-per-type -->
4. whether Stalwart's `filter` is applied per type or across a subscription's
   types, which decides whether the Email and `FileNode` wakes can share one
   subscription.

Until they are answered the four items are the record's debt, and the
implementation marks them where the code owes them (the repository's
`ADR-0017 OWED:` convention).

## The order of the work

1. The four probes above, on a live 0.16, written down as answers rather than
   as an intention.
2. The permission door: the reason-shaped availability question with the iOS
   install case, the request inside the gesture, and the removal of the
   gesture-less request and the comment that describes it as lazy. **Built.**
3. Group mail: targets from the probed `mailAccounts`, per-account inbox ids,
   per-account release, and a "subscribed" answer that reads every target.
   Personal mail is unchanged by this step and must stay unbroken by it.
4. The briefing: per-account Inbox, archive and chat folder, the watermark and
   the reader's own address.
5. Chat: the `FileNode` wake, the worker's read, the notification and its
   suppression rule, and the direct answer to `PushVerification` that more than
   one subscription makes necessary.
6. The same three kinds from the open-tab path, so a visible Gilbert is not the
   quiet one.
7. Settings and the record: the device-local switches for the two new kinds,
   the policy table and the settings surface, `FEATURES.md` (the notifications
   section and the capability table), `KNOWN-ISSUES.md` for what an operator
   has to know (the subscription pool, iOS needing an installed app, a browser
   that must be running), and the mock in step with all of it.
8. The invariant tests above, and the iOS and Android checklist on real
   devices — an installed PWA on 16.4+, and Chrome on Android with a
   manufacturer's battery saver on, which is where a correct implementation
   still looks broken.

## References

- `web/src/lib/webpush.ts` — `subscriptionPayload()`, `webPushAvailable()`, the
  per-device registration and its release
- `web/src/lib/webpushEnable.ts` — `registerThisBrowser()`, `renewWebPush()`,
  `webPushActive()`, and the fifteen-slot pool
- `web/src/lib/swFacts.ts`, `web/public/sw.js` — the briefing, the push handler,
  the `VERIFY_KEY` handshake, `runAction`
- `web/src/store/mail.ts` — `notifyNewMail()`, the per-account folder trees
- `web/src/store/chat.ts`, `web/src/lib/chat.ts`, `server/src/shared/chat.ts` —
  the chat node and its marker
- `web/src/views/settings/NotificationsSettings.tsx` — the door
- `server/src/mock/index.ts` — the simulated server
- ADR 0009 — gilbertserver's own subscription, which fans out to tabs
- ADR 0005 — chat's documents and the per-member marker
- ADR 0001 — what a group mailbox is, and why no name-based exclusion remains
