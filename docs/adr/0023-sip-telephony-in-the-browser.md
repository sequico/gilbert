# ADR 0023 — SIP telephony in the browser

Status: Proposed

Implementation: Partly built. The top-bar phone entry exists and is inert
(`web/src/views/AppShell.tsx`); nothing else is built — no SIP user agent, no
call surface, and no credentials in the identity-enforcement door.

## Context

A deployment already runs its own SIP server — a PBX or registrar that is not
one of Gilbert's four blocks — and an administrator sets each identity's SIP
address and password in the identity-enforcement surface (ADR 0007). What is
missing is the client: a softphone in gilbertmailer that makes and receives
calls from the desktop and from a phone's browser, offers a contact as speed
dial, and carries its state in one top-bar entry.

Three facts decide the shape.

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

## Decision

### The engine

The softphone is **SIP.js**, over **SIP over WebSocket** (WSS) with **WebRTC**
media, for **audio calls**. The `UserAgent` is built from the identity's
credentials, the `Registerer` owns the registration's life, and an `Inviter`
or `Invitation` is one call. Nothing in gilbertserver proxies the signalling or
the media: the browser speaks to the deployment's SIP server directly.

### Credentials

A SIP address and password belong to an identity and are account data: they
follow the account the way settings do, are written by an administrator through
the identity-administration door (ADR 0007) and can be enforced so a member
cannot change them. They are gilbertstalwart's — objects the server holds for
the account, an identity's among them — never device-local. A deployment that
has set none has no softphone, and the phone entry is not offered.

### Registration, and what "not connected" means

The client registers with its own contact and a **short life**, and renews it
while the page is alive. It **deregisters explicitly only when the page
actually goes away** — a `pagehide`, which is a close or a navigation, never a
`visibilitychange`: a tab sent to the background, a phone's app suspended, or a
desktop window sitting behind another keeps its registration, because the
reader is still there and a call should still ring. Only then is the server
asked to route the next call at once. A browser killed outright cannot run that
handler, and the short expiry is what covers it: the server treats the address
as unregistered once the life runs out.

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

A press opens the call surface. An incoming call rings, with answering and
declining, and the entry turns green when it is answered. **A live call
collapses into the top bar** — on the phone and on the desktop alike — so the
reader goes on with their mail while it lasts, and the collapsed control brings
the call back. Nothing about a live call blocks the rest of the app.

### Contacts in the dialer, and speed dial

The phone's own list — the dialer's mini surface — reads its contacts from
Contacts, under the same separation the Contacts view draws: **the global
directory, each group's book (group A, group B, and so on), the reader's
personal books, and all of them together**. A call starts from either place, a
line in the dialer's list or the contact itself in Contacts, and the two send
the same `Inviter`. It is a client-side action: the contact's address becomes
the call's target.

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

## Consequences

- A call lives exactly as long as the page: a reload, a crash or a closed
  browser ends it, and the server's routing — not the client — is what turns
  that into a mailbox.
- Backgrounding is not absence. A hidden tab, a suspended phone app or a
  window behind another stays registered and is rung; only a page that actually
  goes away leaves, and a crash is the expiry's to absorb.
- The operator needs a SIP server that speaks WSS and can reach the browser's
  media, with STUN/TURN where NAT demands it; a deployment without one shows no
  phone.
- The microphone is a browser permission, and on iOS a ringtone and the answer
  gesture carry their own restrictions: an incoming call may ring quietly until
  the reader has interacted with the page.
- The credentials being account data means a change reaches every device, and
  enforcement can lock them — which is the point of setting them in the
  identity door rather than in a per-device form.
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
- ADR 0007 — the identity-administration door the credentials are written
  through
- ADR 0016 — what reaches a closed client, and why the browser's own push
  cannot answer a call
