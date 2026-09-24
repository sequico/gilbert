# ADR 0023 — SIP telephony through a Janus bridge

Status: Accepted

Implementation: Not built. The phone this record decides — the Janus bridge, the
server-held registration, a browser client that speaks the Janus API — does not
exist. The tree still carries an earlier client-side softphone that speaks SIP
over WebSocket from the browser (`web/src/lib/phone/`, `web/src/store/phone.ts`,
`web/src/views/phone/PhoneLauncher.tsx`, `web/src/views/admin/AdminSipPhone.tsx`),
which this decision replaces and which is to be removed. Global contacts is a
record of its own (ADR 0024).

## Context

A deployment reaches telephony through a **SIP server of its own** — a provider
or a PBX that is not one of Gilbert's four blocks, and that gives each person an
account: a server, a username and a password. What the product needs is a
softphone in gilbertmailer that makes and receives calls, offers a contact as
speed dial, and carries its state in one top-bar entry.

Three facts decide the shape.

- **A browser cannot speak SIP.** A page opens no UDP, TCP or TLS socket: its
  transports are WebSocket and WebRTC. And the provider may not offer SIP over
  WebSocket at all — Zadarma, the provider this was designed against, does not —
  so the browser cannot reach it directly whatever the client library. The
  answer is a bridge, not a library.
- **The browser is only a WebRTC peer.** WebRTC gives the page real-time audio
  with ICE and DTLS-SRTP, and a WebSocket for signalling — any signalling. It is
  the media that matters, and the signalling can be the bridge's own.
- **A page rings only while it is alive.** A desktop tab in the background keeps
  ringing; a phone suspends the page when the app is in the background or the
  screen is locked, and a service worker can hold neither a WebSocket nor an
  `RTCPeerConnection`. The phone is therefore a **desktop** surface; ringing a
  locked phone needs a native app and is out of scope.

## Decision

### The bridge

Telephony runs on **Janus**, the WebRTC server, with its **SIP plugin**: a
process of its own inside the Gilbert deployment, a sibling of gilbertserver,
not one of the four blocks. Janus terminates the browser's WebRTC — ICE,
DTLS-SRTP — and the SIP plugin registers and relays to the provider's SIP and
RTP. gilbertserver orchestrates it and owns the deployment's configuration.

**The browser does not speak SIP.** It uses the **Janus API** — JSON over a
WebSocket — with WebRTC media. gilbertserver **proxies Janus's WebSocket on its
own origin and certificate and authenticates it with the Gilbert session**, so
the page has no second endpoint to reach and never holds a SIP credential.

### Registration is the server's

gilbertserver creates a **persistent Janus SIP handle per user**, from that
account's credentials, and keeps the account **registered with the provider**:
one registration per user, held by the server, not by a tab. A browser
disconnecting does not deregister — that is what lets the server take a call
while no page is open — and the registration is renewed for as long as the user
has credentials and the process runs, re-established after a restart.

**Incoming.** An INVITE that reaches Gilbert is **forked to every connected
desktop client of that user**: the first to answer wins and the others receive
CANCEL, so nothing keeps ringing once the call is taken. With **no client
connected** Gilbert does not answer; the call rings out and the **provider's
own routing** (its scenarios, forwarding or voicemail) decides what it becomes.
Gilbert ships no voicemail.

**A second call while one is live is the provider's.** The SIP plugin carries
one call per handle, so Gilbert refuses a second invitation with **486** and the
provider's routing takes it. The client implements no call waiting, hold or
transfer: where the provider wants DTMF sequences for them, its own
documentation is the reference and the keypad is how they are sent.

### Media

Audio only, **G.711 (PCMU/PCMA)** negotiated end to end and **passed through
without transcoding**, with **DTMF as RFC 2833** passed through. Codec and
transport belong to the Gilbert SIP side and are the same for every user; the
leg to the provider runs over **TLS**. There is **no STUN/TURN**: the bridge is
on a public IP and is the browser's ICE peer, with a UDP range open on the
firewall. The browser leg is Gilbert's to shape; a network that blocks direct
UDP is met, later, with ICE-TCP or a relay on 443 rather than with an STUN/TURN
an operator configures.

### Where the credentials are configured

Each person's **SIP server, username and password** are account data, set by an
administrator in the identity-enforcement surface (ADR 0007) — the section now
named **Identities and SIP Phone**. They live in the account's own `sip.json`,
keyed by identity email (`@gilbert/shared/phone`), the same app-folder pattern
the settings document follows. gilbertserver reads them to register and relay;
the browser never sees them, and no tab can change them.

**There is no installation-level phone configuration and no SIP Phone page.**
No `sip` section, no endpoints, no STUN/TURN: how Gilbert reaches Janus — its
address and port, the RTP range, the public IP — is a **deployment fact**, like
`STALWART_URL`, and not an administrator's setting. A user with no credentials
has no phone and no entry; a user with credentials has it. There is no per-user
switch.

### Desktop only

The entry is offered **on desktop only** and hidden on touch devices. This is
the platform's limit stated plainly: a page rings only while it is alive, and a
phone suspends it in the background or with the screen locked. Within desktop, a
tab left in the background still rings — the page is alive — and only closing
it stops the ring.

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
`sip:<number>@<server>`.

### What is not in it

- **A phone.** Mobile is out: a page suspended in the background or behind a
  locked screen cannot ring, and a native app is out of scope (see Context).
- **Voicemail, call waiting, hold and transfer.** The provider's, by its own
  routing and its own DTMF sequences; Gilbert refuses a second call 486 and
  ships none of them.
- **The system call log.** Writing Android's `CallLog` needs a native app and a
  permission, and iOS offers no public API for it. Neither is in scope; a call
  list inside the phone surface may come later.
- **A PBX.** The SIP server is the provider's, external to the four blocks. The
  Janus bridge is the deployment's own WebRTC-to-SIP leg, not a registrar and
  not a telephone system: it holds the registration the provider grants and
  nothing else durable.
- **Video, recording and conferencing.** Audio calls only; anything the
  provider does beyond that is the operator's.
- **A second contacts store.** The directory the dialer reads is Global contacts
  (ADR 0024), a Stalwart book; the phone keeps nothing of its own.

## Consequences

- The deployment runs a second process with a public IP and a UDP range open on
  its firewall. Media traverses it, so a call costs the bandwidth twice and the
  relay's CPU; **G.711** keeps that relay a pass-through rather than a
  transcoder. A restart drops the calls in progress, and the registration is
  re-established when the process returns.
- A call lives as long as the page and cannot be carried across a reload, so a
  reload with a call live asks first. A crash or a closed browser ends it, and
  the provider's routing, not the client, is what turns an unanswered call into
  whatever it becomes.
- Backgrounding is not absence on the desktop: a hidden tab keeps ringing. On a
  phone it is absence, which is why the surface is not offered there.
- The credentials being account data means a change reaches every device and can
  be enforced, and removing them is how a person is given no phone. The browser
  never holds them, which is the point of the bridge.
- **The documents state the feature, and the public ones first.** When the phone
  is built, `FEATURES.md` gains its entry and `README.md` names it among what
  Gilbert does, rather than the feature living only in the code.
- **Owed a live probe**: the Janus SIP plugin registering through the provider
  and carrying a call end to end (Zadarma as the reference), its WebRTC-to-SIP
  media path and ICE restart, and the provider's own behaviour for a second call
  while one is live.

## References

- `web/src/views/AppShell.tsx` — the top-bar phone entry
- Janus WebRTC Server — <https://github.com/meetecho/janus-gateway>
- Janus SIP plugin — <https://janus.conf.meetecho.com/docs/sip>
- ADR 0004 — a contact group is not a recipient
- ADR 0007 — the identity-enforcement surface the credentials are written in
- ADR 0016 — what reaches a closed client, and why the browser's own push
  cannot answer a call
- ADR 0024 — Global contacts, the directory the dialer reads
