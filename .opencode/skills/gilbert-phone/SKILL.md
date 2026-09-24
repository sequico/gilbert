---
name: gilbert-phone
description: The browser phone and Global contacts law of the Gilbert client — the Janus SIP plugin the browser is a user agent through, the gilbertserver WebSocket proxy that authenticates it by session, the single tab that holds the line by a Web Lock, where the SIP account lives, and the one Master-owned Global contacts directory. Load before touching the phone, the dialer, Global contacts, or the telephony administration surface.
metadata:
  short-description: Browser phone (Janus) & Global contacts law
---

# Gilbert — the browser phone, and Global contacts

ADR 0023 decides the phone, ADR 0024 the directory; this file is how the tree
keeps them. **Read both before changing either** — a sentence here that
disagrees with a record is a bug in one of the two.

## State

The phone is built: the browser's Janus client, the gilbertserver proxy, the
single seat and the administration are in place. Global contacts is built.

## The phone (ADR 0023) — the invariants

1. It runs on **Janus** with its SIP plugin, a process of the deployment's own,
   a sibling of gilbertserver.
2. The browser **is the SIP user agent**: it attaches to `janus.plugin.sip`,
   registers the account and negotiates the media; Janus terminates the WebRTC
   and relays SIP and RTP. The page **never frames SIP** — it speaks the
   **Janus API** over a WebSocket that gilbertserver proxies on its own origin
   and certificate and authenticates by session.
3. **Exactly one tab of one browser holds the line**, seated by a **Web Lock**
   (`gilbert-phone`). Every other tab of the same origin renders no phone; the
   holder's release — close, reload or crash — hands the seat to the next tab,
   which registers then.
4. **The registration is the tab's**; the Janus handle lives and dies with it.
   With no tab holding the seat there is no registration, and the provider's own
   routing takes an inbound call. Gilbert keeps none.
5. One call per handle: the plugin refuses a second invitation **486**. No
   client call waiting, hold or transfer.
6. Audio only; **G.711 passed through** without transcoding; DTMF is **RFC 2833**
   through the browser's own `RTCDTMFSender`; TLS to the provider. **No
   STUN/TURN**: the bridge is the ICE peer on a public IP. The media range is the
   **only** inbound port; the SIP leg is outbound, so 5060/5061 are never opened.
7. **No installation-level phone settings** — no `sip` section, no SIP Phone
   page, no STUN/TURN. Where the bridge lives and which ports it needs are the
   deployment's own facts.
8. **Desktop only**: a page rings only while it is alive.
9. Each person's **server, user name and password** are account data, set in
   **Identities and SIP Phone** in the identity-enforcement surface (ADR 0007),
   kept in the account's `sip.json` (`@gilbert/shared/phone`) and read by that
   account's own client.
10. **The phone appears only where it can work**: the account must hold a SIP
    account, the Janus API must answer, and the media path must be proven before
    the entry is drawn. A deployment whose bridge ports are closed shows no
    phone; the administration states the bridge's media range as the one thing
    to open.

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

- **The phone**: `web/src/lib/phone/janus.ts` (the Janus API),
  `web/src/lib/phone/sip.ts` (the SIP plugin, the media and the connectivity
  probe), `web/src/lib/phone/credential.ts` (the account, read from the
  person's own Files), the seat and the state in `web/src/store/phone.ts`, the
  surface in `web/src/views/phone/PhoneLauncher.tsx`; the proxied socket in
  `server/src/phone/proxy.ts`, the bridge's address in
  `server/src/phone/bridge.ts`, the document and the media range in
  `server/src/shared/phone.ts`, and the administration in
  `web/src/views/admin/IdentitiesAndSipPhone.tsx`.
- **Global contacts**: `server/src/globalContactsAdmin.ts` (the write, the
  share, the boot-time `ensureGlobalContacts`), `server/src/index.ts` (its
  call), `server/src/shared/phone.ts`,
  `web/src/views/contacts/GlobalContactsEditor.tsx`,
  `web/src/views/contacts/ContactsSidebar.tsx`, `web/src/lib/contacts.ts`.

## Rules

1. A decision moves by rewriting its record **in place**, and this file with it.
2. The phone is the browser's: one seat, one tab, the registration with it. Do
   not add a server-held registration or a second seat.
3. **If something is needed, make it happen** — no buttons, no per-user steps.
4. Never add installation telephony settings or a STUN/TURN an operator
   configures; how Gilbert reaches Janus is the deployment's.
5. Never let the browser frame SIP: it speaks the Janus API.
6. Desktop only.
7. The mock cannot prove a bridge; a real Janus and a provider are the owed
   probe ADR 0023 names.

Companion skills: Stalwart objects load `gilbert-stalwart`; group books load
`gilbert-groups`; strings load `gilbert-i18n`.
