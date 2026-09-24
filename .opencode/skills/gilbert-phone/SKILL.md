---
name: gilbert-phone
description: The browser phone and Global contacts law of the Gilbert client — the two ways in (SIP over WebSocket directly, or through the Janus SIP plugin), the single tab that holds the line by a Web Lock, where SIP credentials live, and the one Master-owned Global contacts directory. Load before touching the phone, the dialer, Global contacts, or the telephony administration surface.
metadata:
  short-description: Browser phone (direct or Janus) & Global contacts law
---

# Gilbert — the browser phone, and Global contacts

ADR 0023 decides the phone, ADR 0024 the directory; this file is how the tree
keeps them. **Read both before changing either** — a sentence here that
disagrees with a record is a bug in one of the two.

## State

The **direct** way in is the earlier client-side softphone the tree carries
(`web/src/lib/phone/agent.ts` and the store and launcher beside it), which ADR
0023 keeps and reworks to the per-identity account and the single seat below.
The **bridge** way in does not exist. Global contacts is built.

## The phone (ADR 0023) — the invariants

1. **Two ways in, chosen by the server address** an administrator states and
   nothing else: a `wss://` address goes **directly** (the browser is the SIP
   user agent — SIP.js over WebSocket, WebRTC media, no bridge); a bare host goes
   **through the Janus bridge**.
2. Through the bridge, it runs on **Janus** with its SIP plugin, a process of
   the deployment's own. The browser never frames SIP: it speaks the **Janus
   API** over a WebSocket that gilbertserver proxies on its own origin and
   certificate and authenticates by session.
3. **Exactly one tab of one browser holds the line**, seated by a **Web Lock**
   (`gilbert-phone`), in both ways in. Every other tab of the same origin renders
   no phone; the holder's release — close, reload or crash — hands the seat to
   the next tab, which registers then.
4. **The registration is the tab's**; with no tab holding the seat there is no
   registration, and the provider's own routing takes an inbound call. Gilbert
   keeps none.
5. One call per line: a second invitation is refused **486** — by the server
   direct, by the plugin through the bridge. No client call waiting, hold or
   transfer.
6. Audio only; **G.711 passed through** without transcoding; DTMF is **RFC 2833**
   through the browser's own `RTCDTMFSender`; TLS where the server offers it.
   **No STUN/TURN**: the server, or the bridge, is the ICE peer on a public IP.
   Through the bridge the media range is the **only** inbound port; the SIP leg
   is outbound, so 5060/5061 are never opened.
7. **No installation-level phone settings** — no `sip` section, no SIP Phone
   page, no STUN/TURN, no way-in switch. The bridge, where it is and its ports,
   is the deployment's own fact; the direct way needs no bridge at all.
8. **Desktop only**: a page rings only while it is alive.
9. Each person's **server, user name and password** are account data, set in
   **Identities and SIP Phone** in the identity-enforcement surface (ADR 0007),
   kept in the account's `sip.json` (`@gilbert/shared/phone`) and read by that
   account's own client. The **form of the server** (`wss://…` or a host) is what
   selects the way in.
10. **The phone appears only where it can work**: the account must hold an SIP
    account, the Janus API must answer where the bridge is the way in, and the
    media path must be proven before the entry is drawn. A deployment whose
    bridge ports are closed shows no phone; the administration states the
    bridge's media range as the one thing to open.

## The directory (ADR 0024) — the invariants

1. One address book in the **Master's account**, **created by the installation
   at boot** (`ensureGlobalContacts`), not by hand.
2. Shared **read-only with every account**; written only by an administrator
   from inside Contacts, through a server route that acts as the Master.
3. A **section of its own** in the Contacts sidebar, merged in `All contacts`;
   the book's name is the marker (`@gilbert/shared/phone`).
4. The dialer reads it **read-only**, separated from groups and personal books;
   a number can be typed by hand.

## The map

- **Direct way in (present, to rework)**: `web/src/lib/phone/agent.ts` (SIP.js),
  `web/src/store/phone.ts`, `web/src/views/phone/PhoneLauncher.tsx`.
- **Bridge way in (not built)**: the Janus SIP plugin client and the
  gilbertserver WebSocket proxy in front of Janus.
- **Built**: Global contacts — `server/src/globalContactsAdmin.ts` (the write,
  the share, the boot-time `ensureGlobalContacts`), `server/src/index.ts` (its
  call), `server/src/shared/phone.ts`,
  `web/src/views/contacts/GlobalContactsEditor.tsx`,
  `web/src/views/contacts/ContactsSidebar.tsx`, `web/src/lib/contacts.ts`.

## Rules

1. A decision moves by rewriting its record **in place**, and this file with it.
2. The phone is the browser's: one seat, one tab, the registration with it. Do
   not add a server-held registration, a second seat, or a way-in switch.
3. **If something is needed, make it happen** — no buttons, no per-user steps.
4. Never add installation telephony settings or a STUN/TURN an operator
   configures; the direct way in needs none, and the bridge is the deployment's.
5. Never let the browser frame SIP: direct it speaks SIP over WebSocket, through
   the bridge it speaks the Janus API.
6. Desktop only.
7. The mock cannot prove a bridge; a real Janus and a provider are the owed
   probe ADR 0023 names.

Companion skills: Stalwart objects load `gilbert-stalwart`; group books load
`gilbert-groups`; strings load `gilbert-i18n`.
