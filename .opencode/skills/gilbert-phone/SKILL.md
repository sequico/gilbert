---
name: gilbert-phone
description: The browser phone and Global contacts law of the Gilbert client — the Janus WebRTC-to-SIP bridge, the server-held registration per user, the Janus API the browser speaks through gilbertserver, where SIP credentials live, the desktop-only surface, and the one Master-owned Global contacts directory. Load before touching the phone, the dialer, Global contacts, or the telephony administration surface.
metadata:
  short-description: Browser phone (Janus) & Global contacts law
---

# Gilbert — the browser phone, and Global contacts

ADR 0023 decides the phone, ADR 0024 the directory; this file is how the tree
keeps them. **Read both before changing either** — a sentence here that
disagrees with a record is a bug in one of the two.

## State

The phone is **not built**: the tree still carries a client-side
SIP-over-WebSocket softphone that ADR 0023 replaces. Global contacts is built.

## The phone (ADR 0023) — the invariants

1. It runs on **Janus** with its SIP plugin, a process of the deployment's own,
   a sibling of gilbertserver.
2. The browser **never speaks SIP** and **never holds a SIP credential**: it
   uses the Janus API over a WebSocket that gilbertserver proxies on its own
   origin and authenticates by session, with WebRTC media.
3. **Registration is the server's** — one persistent handle per user, held by
   the process, not by a tab.
4. An incoming call is **forked to every connected desktop client** (first
   answer wins, the rest are cancelled); with none connected, the provider's own
   routing takes it.
5. One call per user: a second invitation is refused **486** and the provider
   decides. No client call waiting, hold or transfer.
6. Audio only; **G.711 passed through** without transcoding; DTMF over
   **RFC 2833**; TLS to the provider, one shared transport for every user.
7. **No STUN/TURN**, and **no installation-level phone settings** — no `sip`
   section, no SIP Phone page. How Gilbert reaches Janus is a deployment fact.
8. **Desktop only**: a page rings only while it is alive.
9. Each person's **server, username and password** are account data, set in
   **Identities and SIP Phone** in the identity-enforcement surface (ADR 0007),
   kept in the account's `sip.json` (`@gilbert/shared/phone`).

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

- **Not built**: the Janus process, the gilbertserver proxy and registration,
  the browser client on the Janus API. The tree's `web/src/lib/phone/`,
  `web/src/store/phone.ts`, `web/src/views/phone/PhoneLauncher.tsx` and
  `web/src/views/admin/AdminSipPhone.tsx` are the client ADR 0023 replaces.
- **Built**: Global contacts — `server/src/globalContactsAdmin.ts` (the write,
  the share, the boot-time `ensureGlobalContacts`), `server/src/index.ts` (its
  call), `server/src/shared/phone.ts`,
  `web/src/views/contacts/GlobalContactsEditor.tsx`,
  `web/src/views/contacts/ContactsSidebar.tsx`, `web/src/lib/contacts.ts`.

## Rules

1. A decision moves by rewriting its record **in place**, and this file with it.
2. No SIP credential in the browser, no installation telephony settings, no
   STUN/TURN an operator configures.
3. **If something is needed, make it happen** — no buttons, no per-user steps.
4. Desktop only.
5. The mock cannot prove a bridge; a real Janus and a provider are the owed
   probe ADR 0023 names.

Companion skills: Stalwart objects load `gilbert-stalwart`; group books load
`gilbert-groups`; strings load `gilbert-i18n`.
