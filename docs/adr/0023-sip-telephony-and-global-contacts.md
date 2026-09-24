# ADR 0023 — SIP telephony and Global contacts

Status: Proposed

Implementation: Partly built. The top-bar phone entry exists and is inert
(`web/src/views/AppShell.tsx`); nothing else is built — no SIP user agent, no
call surface, no Global contacts, and no credentials in the
identity-enforcement door.

## Context

A deployment already runs its own SIP server — a PBX or registrar that is not
one of Gilbert's four blocks — and an administrator sets each identity's SIP
address and password in the identity-enforcement surface (ADR 0007). What is
missing is the client: a softphone in gilbertmailer that makes and receives
calls from the desktop and from a phone's browser, offers a contact as speed
dial, and carries its state in one top-bar entry. And the contacts it dials
need a source every reader shares.

Four facts decide the shape.

- **A browser can hold a call only while it is awake.** SIP over WebSocket and
  WebRTC media both need a live page, and a service worker cannot hold an
  `RTCPeerConnection`. A closed browser, or a phone's app suspended, therefore
  cannot be made to ring. That is a platform limit and not a choice of library;
  the answer is below rather than a workaround.
- **The telephony server already answers "is anybody there".** A SIP endpoint's
  registration is its presence: with none registered for an address the server
  takes the call by its own routing (a mailbox), and with several registered it
  forks to them. The client's part is to register honestly, with its own
  contact and a life, and to end that registration when it leaves.
- **The engine is a research decision.** The mature SIP-over-WebRTC user agents
  are SIP.js and JsSIP. SIP.js was chosen: it is written in TypeScript, the
  tree's language, keeps a typed user agent, invitation and registerer, and is
  the base the other browser softphones are built on. Its release cadence is
  slow — 0.21.2, 2022 — while its main branch is alive, which is accepted for a
  library this old and this widely deployed.
- **Contacts are books, and none of them is everybody's.** The reader's own, a
  group's — membership is the subscription (ADR 0021) — and a colleague's,
  added deliberately. `All contacts` merges the books the reader may read.
  Re-built per group or per person, the installation's own directory —
  **Global contacts** — would drift, and the same address would be spelled
  three ways in three books.

## Decision

### The engine

The softphone is **SIP.js**, over **SIP over WebSocket** (WSS) with **WebRTC**
media, for **audio calls**. The `UserAgent` is built from the identity's
credentials, the `Registerer` owns the registration's life, and an `Inviter`
or `Invitation` is one call. Nothing in gilbertserver proxies the signalling or
the media: the browser speaks to the deployment's SIP server directly.

### The connection, and how it survives

**Reliability is this surface's priority.** A bad network and a lost server are
ordinary conditions and not error states, and the client answers them by
itself: it reconnects the socket, re-registers, restarts ICE when the media
path breaks and renegotiates the session's codecs as the path degrades and
recovers — so a call survives a Wi-Fi-to-mobile handover, or a few seconds of
silence, with the reader touching nothing. What cannot be recovered ends
cleanly, the entry going back to idle, rather than leaving a dead call on
screen; the server's registration state is what takes the call that follows.
The reader learns about trouble only from the entry's colour, and only while it
lasts.

The client reaches the server over **SIP over WebSocket** (WSS), and the
connection is **reliable and unattended**: the endpoints are configured in the
order they are tried, and when the one in use drops the client reconnects with
backoff and re-registers — the reader is asked for nothing, and the call
surface never leans on a socket that is quietly gone.

A browser has WebSocket as its SIP transport and no other: TCP, TLS and UDP are
not the page's to open. "Another transport" therefore means another endpoint. A
deployment whose fallback is a transport the browser does not speak — plain SIP
over TLS or UDP — puts a WSS-speaking gateway in front of its server and lists
that endpoint, so the failover is seamless from the client's side. A connection
that is not there is not called registered, which is the red the entry shows.

### Where the phone is configured

The installation's telephone settings are **one administration page, SIP
Phone**: the server endpoints in the order they are tried, the STUN/TURN
servers media needs, and whether the phone is offered at all. They are
installation-wide — every client reaches the same server — and belong with the
installation's own configuration (ADR 0011), not in the environment and not per
account.

Each person's SIP address and password are **not** on that page. They belong to
an identity and are set per identity in the identity-enforcement surface (ADR
0007), where the administration already sets, and can lock, what an identity is.

### Credentials

A SIP address and password belong to an identity and are account data: they
follow the account the way settings do, are written by an administrator in the
identity-enforcement surface (ADR 0007) and can be enforced so a member cannot
change them. They are gilbertstalwart's — objects the server holds for the
account, an identity's among them — never device-local. A deployment that has
set none has no softphone, and the phone entry is not offered.

### Registration, and what "not connected" means

The client registers **one line, the default identity's**, with its own
contact and a **30-second life**, and renews it while the page is alive. **One
tab per device registers**: a second tab on the same device shows the call
rather than registering a second contact, so a device never rings twice and
never plays the audio twice.

It **deregisters explicitly only when the page actually goes away** — a
`pagehide`, which is a close or a navigation, never a `visibilitychange`: a tab
sent to the background, a phone's app suspended, or a desktop window sitting
behind another keeps its registration, because the reader is still there and a
call should still ring. Only then is the server asked to route the next call at
once. A browser killed outright cannot run that handler, and the 30-second
expiry is what covers it: the server treats the address as unregistered once
the life runs out.

What the server does with that is the server's. With no contact registered it
takes the call itself — a mailbox — and with another client registered under
the same credentials it forks, ringing that one, or every one. The client does
not decide between them and does not try to.

### The phone in the top bar

The phone is one entry in the top-bar action cluster, beside the chat launcher.
Its state is one glyph, and it returns to idle on its own:

- **outline** — registered, no call;
- **green** — a call is live, incoming answered or outgoing connected;
- **red** — the line is not available: a second call while one is live, a
  registration that has dropped, or a call that failed or was declined.

A press opens the call surface. An incoming call announces itself where the
reader is — **a full screen on a phone and a banner under the top bar on a
desktop**, both with answering and declining — and the entry turns green when
it is answered. **A live call collapses into the top bar** — on the phone and
on the desktop alike — so the reader goes on with their mail while it lasts,
and the collapsed control brings the call back. Nothing about a live call
blocks the rest of the app.

### While a call is live

The controls are **mute and a DTMF keypad**. Hold and transfer are not client
features: where a server wants DTMF sequences for them, the operator documents
them and the keypad is how they are sent — a matter between the server and its
peers, not something the client models.

**A second call is the server's to offer, and the client answers both ways.**
Where the server forks a second invitation while one is live, the client takes
it the way the server means it to — call waiting, the first held while the
second is answered — and where the server expects busy, it refuses with 486 and
the line reads red (above). Which one happens is the deployment's, not the
client's.

Signing out, or switching the account under the phone, ends the call: the
credentials it was placed with go with the session.

### The microphone, and the ring

The microphone is asked for **as early as the surface can**, in its own
gesture, by the same principle the notification permission already follows
(ADR 0016): a permission asked silently is one nobody grants, and one deferred
to the first call is a call that fails at the worst moment. Until it is
granted, the phone says what is missing rather than pretending.

An incoming call rings, and a device that cannot play the ringtone still gets
the visual one. The reader's notification settings are respected: a reader who
has silenced Gilbert is not rung audibly by it.

### Contacts the phone reads, and speed dial

The phone's list — the dialer's mini surface — reads its contacts from
Contacts, under the same separation the Contacts view draws: **Global contacts,
each group's book (group A, group B, and so on), the reader's personal books,
and all of them together**. A call starts from either place, a line in the
dialer's list or the contact itself in Contacts, and the two send the same
`Inviter`. It is a client-side action: the contact's address becomes the call's
target.

**The dialer's list is read-only and searches and dials, nothing else.** No
contact is created, edited or deleted from it — not by a member and not by an
administrator — because editing a contact belongs to Contacts. The dialer
reads, searches and calls; every write is somewhere else. **A number can also
be composed by hand**, through a keypad in the call surface, so the phone is
not limited to the contacts it can read.

### Global contacts

**Global contacts is one address book, owned by the Master, shared read-only
with every account, and written only by an administrator, from inside
Contacts.**

- **It is an ordinary address book.** JMAP `AddressBook` and `ContactCard`,
  held in the Master's account — an object the server holds, gilbertstalwart's
  area. No new object type, and no second store in Gilbert.
- **Everyone reads it.** The share is universal: every account, including one
  created later. A reader sees it in `All contacts` beside their own book and
  the group books their membership subscribes, with no per-member patch and
  nothing to add by hand.
- **It has a section of its own, named Global contacts**, in the Contacts
  sidebar beside the reader's books and each group's, so it can be opened and
  browsed alone; merged into `All contacts` it is the same book.
- **Only an administrator writes it, and from inside Contacts.** Global
  contacts is edited where it is read: the Contacts surface draws the edit
  controls for an administrator alone, and for everybody else the cards are
  read-only. The write itself goes through the same door every privileged write
  uses — impersonation as the Master, or the deployment's agent (ADR 0001, ADR
  0007). The share carries read only, so a member's own session cannot edit a
  card, and the client shows those cards as it shows any book it may not write
  (`cardWritable`): Edit and Delete withheld.
- **Its cards are ordinary cards**, so they take part in the composer's
  recipient suggestions and the contact search the way every readable book's
  do, under ADR 0004's rules for group cards.
- **The phone offers them as speed dial**, like any other contact.

### On the phone

The entry, the dialer's list, the ringing surface and the collapsed call are
laid out for a narrow screen and a fingertip from the start, not narrowed
afterwards. The phone works as well, and reads as one product with the rest of
gilbertmailer, on a phone as on a desktop — the same bar every other surface in
the client is held to.

### What is not in it

- **Ringing with the browser closed, or a phone's app suspended.** Not possible
  from a browser (see Context), and deliberately not worked around: the
  deregistration is what makes the server take the call instead.
- **The system call log.** Writing Android's `CallLog` needs a native app and a
  permission, and iOS offers no public API for it. Neither is in scope; a call
  list inside the phone surface may come later.
- **A telephony server.** The SIP server is the deployment's own, external to
  the four blocks. Gilbert adds no registrar, no media relay and no durable
  telephony state beyond the identity's credentials.
- **Video, recording and conferencing.** Audio calls only; anything the SIP
  server does beyond that is the operator's.
- **A second contacts store.** Global contacts lives in Stalwart as a book;
  Gilbert keeps nothing of its own.
- **Global contacts copied per member, or writable by one.** A per-account copy
  that could drift, or a write path for a member, is not this decision.
- **Global contacts per group.** A group's own books stay the group's; Global
  contacts is the installation's, owned by the Master and read by everyone.
- **An org chart.** Global contacts is a book of contacts, with the fields a
  card has, and nothing about reporting lines.

## Consequences

- A call lives exactly as long as the page and cannot be carried across a
  reload — the media stack dies with the document — so a reload with a call
  live asks first. A crash or a closed browser ends it, and the server's
  routing, not the client, is what turns that into a mailbox.
- Backgrounding is not absence. A hidden tab, a suspended phone app or a
  window behind another stays registered and is rung; only a page that actually
  goes away leaves, and a crash is the expiry's to absorb.
- The operator needs a SIP server that speaks WSS and can reach the browser's
  media, with STUN/TURN where NAT demands it, and lists the endpoints it is
  reached at in the order they are tried — with a WSS-speaking gateway in front
  of a server whose own transport the browser cannot open. A deployment without
  one shows no phone.
- The microphone is a browser permission, and on iOS a ringtone and the answer
  gesture carry their own restrictions: an incoming call may ring quietly until
  the reader has interacted with the page.
- The credentials being account data means a change reaches every device, and
  enforcement can lock them — which is the point of setting them in the
  identity door rather than in a per-device form.
- One edit of Global contacts changes what every reader sees: there is nothing
  to republish and no copy to keep in step, and a reader added later sees it
  without any patch because the share is universal rather than one written per
  member. The exact Stalwart shape of a share that names every account at once
  is to be confirmed against a live server; what the decision requires is that
  it is one rule.
- Reading Global contacts costs the client nothing new: it arrives with the
  shared books `loadShared` already loads, and `All contacts` already merges
  them. A deployment with no usable agent has no Global contacts
  administration, and the administration says so rather than refusing with a
  permission error.
- **The documents state the feature, and the public ones first.** The phone is
  a feature of the product and not a capability left to the code: when it is
  built, `FEATURES.md` gains its entry and `README.md` names the phone among
  what Gilbert does. The public documents are where a reader learns what the
  product offers, and a surface this visible is stated there — and in this
  record's index entry — rather than discovered. The phone entry already in the
  top bar becomes live in the same change.

## References

- `web/src/views/AppShell.tsx` — the top-bar phone entry
- SIP.js — <https://github.com/onsip/SIP.js>
- ADR 0001 — the administration door and impersonation
- ADR 0004 — a contact group is not a recipient
- ADR 0007 — the identity-enforcement surface the credentials are written in
- ADR 0011 — the installation's own configuration the SIP Phone page writes
- ADR 0016 — what reaches a closed client, and why the browser's own push
  cannot answer a call
- ADR 0018 — a contact is moved between accounts by an administrator
- ADR 0021 — a group's folders are subscribed for every member
