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
   through the browser's own `RTCDTMFSender`; SIP over **UDP/5060** to the
   provider (not TLS — see ROADMAP). **No STUN/TURN**: the bridge is the ICE peer
   on a public IP. The media range is the **only** inbound port; the SIP leg is
   outbound, so 5060/5061 are never opened.
7. **No installation-level phone settings** — no `sip` section, no SIP Phone
   page, no STUN/TURN. The bridge ships with the release (the image builds it
   from `deploy/janus/VERSION`; the release publishes a host tarball the
   installer fetches); the only deployment fact an operator acts on is the
   media range, `BRIDGE_MEDIA_PORTS`, opened inbound — with it closed the phone
   does not appear.
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
11. **The surface is a panel of three panes**, attached to the handset: the
    **contacts** on the left — two status rows with a dot and the cause on hover
    (the browser's path to Gilbert, and the account's registration), the tabs
    All/Global/My plus one row per group, a search with its own clear control,
    and every number a contact carries with its type — the **dialer** in the
    centre, whose title names the **SIP user** (not the login), and the
    account's **call history** on the right. Everything is the app's own
    vocabulary (`.tab`, `.nav-section`, `.input`, the theme tokens): no bespoke
    controls, and the two panes read the same contact sources so a number dialled
    resolves back to the same person.
12. **The browser is reached peer-reflexively, and mDNS names are link-local.**
    With no STUN the browser's own host candidates are the media path, and
    Chrome obfuscates them as random `<uuid>.local` names; a browser on another
    network can never be resolved to an address, so ICE learns where it is from
    its own first check. The **host installer** installs `avahi-daemon` and
    `libnss-mdns` and points `nsswitch.conf` at them, which removes the resolver
    error and gives a same-LAN browser's candidate directly; the container image
    runs unprivileged and read-only and cannot, so a containerised bridge keeps
    the peer-reflexive path.

## The directory (ADR 0024) — the invariants

1. One address book in the **Master's account**, **created by the installation
   at boot** (`ensureGlobalContacts`), not by hand.
2. Shared **read-only with every account**; written only by an administrator
   from inside Contacts, through a server route that acts as the Master.
3. The **first row of the Contacts sidebar**, above `All contacts` and the
   reader's books, merged in `All contacts`;
   the book's name is the marker (`@gilbert/shared/phone`).
4. The dialer reads it **read-only**, separated from groups and personal books;
   a number can be typed by hand.

## The map

- **The phone**: `web/src/lib/phone/janus.ts` (the Janus API),
  `web/src/lib/phone/sip.ts` (the SIP plugin, the media and the connectivity
  probe), `web/src/lib/phone/credential.ts` (the account, read from the
  person's own Files), `web/src/lib/phone/callLog.ts` (the account's call
  history, `calls.json` in its app folder), `web/src/lib/phone/mock.ts` (the
  `dev:mock` stub), the seat and the state in
  `web/src/store/phone.ts`, the surface in
  `web/src/views/phone/PhoneLauncher.tsx` with its panes
  (`PhoneContactsPanel.tsx`, `CallLogPanel.tsx`, and the shared
  `usePhoneSources.ts` they both read); the proxied socket in
  `server/src/phone/proxy.ts`, the bridge's address in
  `server/src/phone/bridge.ts`, the document and the media range in
  `server/src/shared/phone.ts`, and the administration in
  `web/src/views/admin/IdentitiesAndSipPhone.tsx`. The bridge itself is built
  and configured by `deploy/janus/` (the pinned `VERSION`, the Janus configs,
  the container entrypoint) and `install/install.sh` (the host services), with
  `scripts/janusConfig.mjs` deriving the media range from
  `@gilbert/shared/phone`, and `scripts/janusVersion.mjs` saying whether the pin
  is behind upstream.
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
7. **The call history is the account's own**, in its app folder (`calls.json`):
   written by the tab that holds the seat as each call ends, newest first and
   bounded. Nothing of gilbertserver's keeps a call.
8. The mock cannot prove a bridge, so `dev:mock` **stubs** the phone
   (`VITE_PHONE_MOCK=1`, `@/lib/phone/mock`): media proven and the line
   registered, and a dialled call that connects and ends on its own, so the
   surface can be seen with no Janus. The real bridge and a provider are the
   owed probe ADR 0023 names.

Companion skills: Stalwart objects load `gilbert-stalwart`; group books load
`gilbert-groups`; strings load `gilbert-i18n`. Installing and running the bridge
— both ways, and the one port — is `INSTALL.md`.
