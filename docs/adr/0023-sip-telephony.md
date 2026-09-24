# ADR 0023 — SIP telephony

Status: Accepted

Implementation: Not built. The phone this record decides — a browser on the
Janus SIP plugin, one tab holding the line — does not exist. The tree still
carries an earlier client-side softphone that speaks SIP over WebSocket from the
browser (`web/src/lib/phone/agent.ts`, `web/src/store/phone.ts`,
`web/src/views/phone/PhoneLauncher.tsx`, `web/src/views/admin/AdminSipPhone.tsx`),
which this decision replaces and which is to be removed. Global contacts is a
record of its own (ADR 0024).

## Context

A deployment reaches telephony through a **SIP server of its own** — a provider
or a PBX that is not one of Gilbert's four blocks, and that gives each person an
account: a server, a user name and a password. What the product needs is a
softphone in gilbertmailer that makes and receives calls, offers a contact as
speed dial, and carries its state in one top-bar entry.

Two facts decide the shape.

- **A browser cannot speak SIP.** A page opens no UDP, TCP or TLS socket: its
  transports are WebSocket and WebRTC. And the provider may not offer SIP over
  WebSocket at all — Zadarma, the provider this was designed against, does not —
  so the browser cannot reach it directly whatever the client library. A bridge
  is therefore what puts a page on a classic SIP server.
- **A page rings only while it is alive.** A desktop tab in the background keeps
  ringing; a phone suspends the page when the app is in the background or the
  screen is locked, and a service worker can hold neither a WebSocket nor an
  `RTCPeerConnection`. The phone is therefore a **desktop** surface; ringing a
  locked phone needs a native app and is out of scope.

## Decision

### The bridge

Telephony runs on **Janus**, the WebRTC server, with its **SIP plugin**: a
process of its own inside the Gilbert deployment, a sibling of gilbertserver,
not one of the four blocks. The browser attaches to `janus.plugin.sip`,
registers the account and negotiates the media; Janus terminates the WebRTC,
registers at the provider and relays SIP and RTP.

**The browser does not speak SIP; it speaks the Janus API.** Its signalling —
the plugin's requests and events, and the JSEP SDP and ICE that carry the media
— is JSON over a WebSocket that gilbertserver **proxies on its own origin and
certificate and authenticates with the Gilbert session**, so the page reaches no
second endpoint. The bridge is a **deployment capability**: where it lives, and
the media ports it needs, are the deployment's, never an installation setting.

### One tab holds the line

Exactly one tab of one browser holds the phone; every other tab of the same
origin shows no phone at all. The seat is a **Web Lock** (`gilbert-phone`): the
first tab to ask holds it and is the phone, and each later tab waits on the lock
and renders nothing. Closing, reloading or crashing the holder releases the lock
— the browser releases it, so there is no stale seat — and the next waiting tab
takes the seat and registers.

**The registration is the tab's.** The Janus handle that registers lives and dies
with the tab holding the seat; with no tab holding it there is no registration,
and the provider's own routing — its scenarios, forwarding or voicemail — takes
an inbound call. Gilbert keeps no registration of its own.

### Media

Audio only, **G.711 (PCMU/PCMA)** negotiated end to end and **passed through
without transcoding**. **DTMF is RFC 2833**: the browser's own `RTCDTMFSender`
inserts the telephone-event RTP into the stream, and Janus relays it. The leg to
the provider runs over **TLS**. There is **no STUN/TURN**: the bridge is on a
public IP and is the browser's ICE peer. The media range is the **only** port a
deployment opens inbound — the SIP leg to the provider is outbound, so
5060/5061 are never opened.

### A second call

The SIP plugin carries one call per handle, so a second invitation is refused
**486** by the plugin while one is live and the provider's routing takes it. The
client implements no call waiting, hold or transfer: where the provider wants
DTMF sequences for them, its own documentation is the reference and the keypad
is how they are sent.

### Where the credentials are configured

Each person's **server, user name and password** are account data, set by an
administrator in the identity-enforcement surface (ADR 0007) — the section named
**Identities and SIP Phone**. They live in the account's own `sip.json`, keyed
by identity email (`@gilbert/shared/phone`), the same app-folder pattern the
settings document follows, and the account's own client reads them. They are
that person's own account, read through the door that account is already signed
in by — not a shared secret, and not a second door.

**There is no installation-level phone configuration and no SIP Phone page.**
No `sip` section, no endpoints, no STUN/TURN: where the bridge lives and which
ports it needs are the **deployment's** own facts, like `STALWART_URL`, and not
an administrator's settings. A user with no account has no phone and no entry; a
user with one has it. There is no per-user switch.

### Desktop only

The entry is offered **on desktop only** and hidden on touch devices: a page
rings only while it is alive (Context), and a phone suspends it. Within desktop,
a tab left in the background still rings, and only closing it stops the ring.

### The phone in the top bar

The phone is one entry in the top-bar action cluster, beside the chat launcher.
Its state is one glyph, and it returns to idle on its own:

- **outline** — registered, no call;
- **green** — a call is live, incoming answered or outgoing connected;
- **red** — the line is not available: a second call while one is live, a
  registration that has dropped, or a call that failed or was declined.

A press opens the call surface. An incoming call announces itself as a banner
under the top bar; the entry turns green when it is answered. **A live call
collapses into the top bar** so the reader goes on with their mail while it
lasts, and the collapsed control brings the call back. Nothing about a live call
blocks the rest of the app. Signing out ends the call.

### The microphone, and the ring

The microphone is asked for **as early as the surface can**, in its own gesture,
by the same principle the notification permission already follows (ADR 0016):
asked silently it is granted by nobody, and deferred to the first call it is a
call that fails at the worst moment. Until it is granted the phone says what is
missing rather than pretending.

An incoming call rings, and the reader's notification settings are respected: a
reader who has silenced Gilbert is not rung audibly by it.

### Offered only where it can work

The phone appears **only where it can actually carry a call**, and it is not an
administrator's switch: the account must hold a SIP account, the Janus API must
answer, and the media path to the bridge must be proven before the entry is
drawn. A half-configured deployment — the bridge's media ports still closed,
above all — shows **no phone at all** rather than an entry that fails at the
first call. Because those ports are the deployment's, the administration states
them: a line naming the bridge's media range and saying that the SIP leg is
outbound, so whoever installs Gilbert knows exactly what to open.

### Contacts the phone reads, and speed dial

The phone's list — the dialer's mini surface — reads its contacts from Contacts,
under the same separation the Contacts view draws: **Global contacts (ADR
0024), each group's book (group A, group B, and so on), the reader's personal
books, and all of them together**. A call starts from either place, a line in
the dialer's list or the contact itself in Contacts. Every number a contact
carries is callable, and the action is absent where a contact has none.

**The dialer's list is read-only and searches and dials, nothing else.** No
contact is created, edited or deleted from it — not by a member and not by an
administrator — because editing a contact belongs to Contacts. A number can also
be composed by hand, through a keypad, and it is sent to the provider as
`sip:<number>@<server>`, on the account's own server.

### What is not in it

- **A phone.** Mobile is out: a page suspended in the background or behind a
  locked screen cannot ring, and a native app is out of scope (see Context).
- **Voicemail, call waiting, hold and transfer.** The provider's, by its own
  routing and its own DTMF sequences; the plugin refuses a second call 486 and
  Gilbert ships none of them.
- **The system call log.** Writing Android's `CallLog` needs a native app and a
  permission, and iOS offers no public API for it. Neither is in scope; a call
  list inside the phone surface may come later.
- **A PBX.** The SIP server is the provider's, external to the four blocks. The
  Janus bridge is the deployment's own WebRTC-to-SIP leg, not a registrar and
  not a telephone system.
- **Video, recording and conferencing.** Audio calls only; anything the provider
  does beyond that is the operator's.
- **An operator-configured STUN/TURN.** The bridge is the ICE peer on a public
  IP; there is no relay for a deployment to name.
- **A second contacts store.** The directory the dialer reads is Global contacts
  (ADR 0024), a Stalwart book; the phone keeps nothing of its own.
- **A registration the server holds, or a second seat.** One tab of one browser
  holds the line; a second tab shows no phone until the holder goes. A second
  machine reaches the provider as the provider's registrar allows.

## Consequences

- The deployment runs a second process with a public IP and a media UDP range
  open on its firewall: that range is the only inbound port, and the SIP leg is
  outbound. Media traverses the bridge, so a call costs the bandwidth twice and
  the relay's CPU; **G.711** keeps that relay a pass-through rather than a
  transcoder. A restart drops the calls in progress, and the tabs that hold the
  seat register again when their socket returns.
- The line is the browser's. Closing the tab that holds the seat drops the
  registration, and while no tab holds it the provider's routing, not Gilbert,
  decides what an inbound call becomes. A call lives as long as the page and
  cannot be carried across a reload, so a reload with a call live asks first.
- One seat per browser: a second tab renders no phone until the holder goes, when
  the Web Lock hands the seat on.
- The credential is the account's own, read from the account's own Files by the
  client that account is already signed in by. The Janus API being proxied by
  gilbertserver is what keeps the page on one origin and one certificate; it is
  not a second permission door.
- **The documents state the feature, and the public ones first.** When the phone
  is built, `FEATURES.md` gains its entry and `README.md` names it among what
  Gilbert does, rather than the feature living only in the code.
- **Owed a live probe**: the Janus SIP plugin registering through the provider
  and carrying a call end to end (Zadarma as the reference), its WebRTC-to-SIP
  media path, DTMF over RFC 2833, and the provider's own behaviour for a second
  call while one is live.

## References

- `web/src/views/AppShell.tsx` — the top-bar phone entry
- Janus WebRTC Server — <https://github.com/meetecho/janus-gateway>
- Janus SIP plugin — <https://janus.conf.meetecho.com/docs/sip>
- ADR 0007 — the identity-enforcement surface the credentials are written in
- ADR 0016 — what reaches a closed client, and why the browser's own push
  cannot answer a call
- ADR 0024 — Global contacts, the directory the dialer reads
