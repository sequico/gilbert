---
name: gilbert-phone
description: The browser phone and Global contacts law of the Gilbert client — the Janus WebRTC-to-SIP bridge, the server-held registration per user, the Janus API the browser speaks through gilbertserver, where SIP credentials live, the desktop-only surface, and the one Master-owned Global contacts directory. Load before touching the phone, the dialer, Global contacts, or the telephony administration surface.
metadata:
  short-description: Browser phone (Janus) & Global contacts law
---

# Gilbert — the browser phone, and Global contacts

ADR 0023 is the phone's decision and ADR 0024 the directory's; this file is how
the tree keeps them. Read both before changing any of it — a sentence here that
disagrees with a record is a bug in one of the two.

## State

The phone is **not built**: the tree still carries an earlier client-side
softphone that speaks SIP over WebSocket from the browser, which ADR 0023
replaces. Global contacts (ADR 0024) is built.

## The bridge (ADR 0023)

- A browser cannot speak SIP — it opens no UDP, TCP or TLS socket, only
  WebSocket and WebRTC — and the provider may not offer SIP over WebSocket at
  all (Zadarma does not). The phone therefore runs on **Janus**, the WebRTC
  server, with its **SIP plugin**, as a **process of the deployment's own**, a
  sibling of gilbertserver.
- The browser **never speaks SIP**: it uses the **Janus API** (JSON over a
  WebSocket) with WebRTC media. gilbertserver **proxies Janus's WebSocket on its
  own origin and certificate and authenticates it with the Gilbert session**;
  the browser holds no SIP credential.
- Janus terminates ICE and DTLS-SRTP and the SIP plugin relays to the provider
  over SIP and RTP. **No STUN/TURN**: the bridge is on a public IP and is the
  browser's ICE peer, with a UDP range open on the firewall.
- Audio only; **G.711 (PCMU/PCMA)** negotiated end to end and passed through
  **without transcoding**; **DTMF as RFC 2833**. TLS on the leg to the provider,
  one shared transport for every user.

## Registration and calls

- gilbertserver creates a **persistent Janus SIP handle per user** and keeps the
  account **registered with the provider** — one registration per user, held by
  the server, not by a tab. A browser disconnecting does not deregister.
- An incoming INVITE is **forked to every connected desktop client** of that
  user: the first answer wins and the rest receive CANCEL. With **no client
  connected** Gilbert does not answer; the provider's own routing (scenarios,
  forwarding, voicemail) takes it. Gilbert ships no voicemail.
- One call per user: the SIP plugin carries one call per handle, so a second
  invitation is refused **486** and the provider decides. The client implements
  no call waiting, hold or transfer; where the provider wants DTMF sequences,
  its documentation is the reference and the keypad is how they are sent.
- The phone is **desktop only**. A page rings only while it is alive; a phone
  suspends it in the background or with the screen locked, so the entry is
  hidden on touch devices and a native app is out of scope.

## The surface

- One top-bar entry: **outline** registered, **green** in a call, **red**
  unavailable. A press opens the call surface; an incoming call is a banner
  under the top bar; a live call collapses into the top bar. Controls: mute and
  a DTMF keypad.
- The microphone is asked **as early as the surface can**, in its own gesture,
  by the principle the notification permission already follows (ADR 0016). The
  reader's notification setting decides whether a call rings.
- A reload cannot carry a call, so it asks first; signing out ends the call.

## Credentials and configuration

- Each person's **SIP server, username and password** are account data, set by
  an administrator in the identity-enforcement surface (ADR 0007) — the section
  named **Identities and SIP Phone** — and kept in the account's own `sip.json`
  (`@gilbert/shared/phone`). The browser never sees them.
- **No installation-level phone configuration and no SIP Phone page**: no `sip`
  section, no endpoints, no STUN/TURN. How Gilbert reaches Janus is a
  **deployment fact** (environment/container), like `STALWART_URL`.
- A user with no credentials has no phone and no entry. There is no per-user
  switch.

## The dialer

Reads Contacts separated the way Contacts draws them: **Global contacts (ADR
0024), each group, the reader's personal books, all together**. It is
**read-only** — search and dial, never a write — and a number can be typed by
hand.

## Global contacts (ADR 0024)

- One address book in the **Master's account** (`gilbert@…`), **created by the
  installation itself at boot** (`ensureGlobalContacts`) rather than by hand,
  shared read-only with every account, and written only by an administrator from
  inside Contacts through a server route that acts as the Master. The book's
  name is the marker (`@gilbert/shared/phone`).
- It has a section of its own in the Contacts sidebar as well as being merged in
  `All contacts`; its cards are ordinary cards; the phone offers them as speed
  dial. The exact Stalwart shape of a share naming every account at once is owed
  a live probe.

## The map

- **Not built**: the Janus process, the gilbertserver proxy and registration,
  the browser client on the Janus API. The tree's current
  `web/src/lib/phone/`, `web/src/store/phone.ts`,
  `web/src/views/phone/PhoneLauncher.tsx` and
  `web/src/views/admin/AdminSipPhone.tsx` are the earlier SIP-over-WebSocket
  client this record replaces.
- **Built**: Global contacts — `server/src/globalContactsAdmin.ts` (the write,
  the share, and the boot-time `ensureGlobalContacts`), `server/src/index.ts`
  (its call), `server/src/shared/phone.ts`,
  `web/src/views/contacts/GlobalContactsEditor.tsx`,
  `web/src/views/contacts/ContactsSidebar.tsx`, `web/src/lib/contacts.ts`.

## Rules

1. Read ADR 0023 and ADR 0024 before changing the phone or the directory; when a
   decision moves, rewrite the record **in place** and this file with it.
2. Never let the browser hold a SIP credential, and never add
   installation-level telephony settings or an STUN/TURN an operator configures.
3. **If something is needed, make it happen** — the directory is created by the
   installation, not by a button, and there are no per-user setup steps.
4. Desktop only: the phone is not offered on touch devices.
5. The mock cannot prove a bridge; a real Janus and a provider are what the owed
   probe asks.

Companion skills: Stalwart objects load `gilbert-stalwart`; group books load
`gilbert-groups`; strings load `gilbert-i18n`.
