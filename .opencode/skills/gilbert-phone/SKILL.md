---
name: gilbert-phone
description: The SIP softphone and Global contacts law of the Gilbert client — SIP.js over SIP-over-WebSocket with WebRTC media, registration and reliability rules, the top-bar phone and its call surfaces, where SIP credentials and the SIP Phone configuration live, and the one Master-owned Global contacts book every account reads. Load before touching the phone, the dialer, Global contacts, or the SIP administration surface.
metadata:
  short-description: Softphone & Global contacts law
---

# Gilbert — the phone, and Global contacts

ADR 0023 is the decision; this file is how the tree keeps it. Read the ADR
before changing any of it, because a sentence here that disagrees with the
record is a bug in one of the two.

## The phone is a client, not a server

- The softphone is **SIP.js**, over **SIP over WebSocket** (WSS) with **WebRTC**
  media, audio only. It speaks **directly** to the deployment's own SIP server —
  a PBX or registrar that is not one of Gilbert's four blocks.
- Gilbert adds **no registrar, no media relay, no durable telephony state**.
  Nothing durable is the phone's: the credentials are an identity's
  (`gilbert-stalwart`), the settings are the installation's (`gilbert-project`
  §installation), and a call lives only as long as the page.
- The browser's only transport is WebSocket. "Another transport" means
  **another endpoint**: a deployment whose fallback is plain SIP over TLS or UDP
  puts a WSS-speaking gateway in front and lists that endpoint, and the client
  fails over to it unattended.
- **Reliability is this surface's priority.** A bad network and a lost server
  are ordinary conditions: reconnect, re-register, ICE restart, renegotiate as
  the path degrades and recovers, and try the configured endpoints in order. A
  call that cannot be recovered ends cleanly rather than leaving a dead call on
  screen.

## Registration

- **One line, the default identity's.** Not every identity with credentials.
- A **30-second life**, renewed while the page is alive.
- **One tab per device registers.** A second tab shows the call rather than
  registering a second contact, so a device never rings twice and never plays
  the audio twice.
- **Deregister explicitly only when the page actually goes** — `pagehide`
  (close or navigation), **never** `visibilitychange`. A hidden tab, a suspended
  phone app or a window behind another **stays registered and is rung**; the
  short expiry, not a visibility handler, is what covers a browser killed
  outright.
- What an absent registration means is the **server's** decision: with none it
  takes the call (a mailbox), with several it forks. The client does not decide
  and does not try to. Ringing with the browser closed is impossible and is not
  worked around.

## The entry and the call surfaces

The phone is one entry in the top-bar action cluster, beside the chat launcher.
Its glyph is the state and returns to idle on its own:

- **outline** — registered, no call;
- **green** — a call is live (incoming answered, outgoing connected);
- **red** — the line is not available: a second call while one is live, a
  dropped registration, a failed or declined call.

- A press opens the call surface.
- An incoming call is **full screen on a phone** and a **banner under the top
  bar on a desktop**; both answer and decline.
- **A live call collapses into the top bar** on phone and desktop alike, so the
  reader goes on working; the collapsed control brings it back. Nothing about a
  live call blocks the rest of the app.
- Controls are **mute and a DTMF keypad**. Hold and transfer are **not** client
  features: where a server wants DTMF sequences, the operator documents them and
  the keypad sends them.
- A **second call is the server's to offer** and the client answers both ways —
  call waiting (first held, second answered) where the server forks, 486 and a
  red line where it expects busy. Which one happens is the deployment's.
- **A number can also be composed by hand**, through a keypad, so the phone is
  not limited to the contacts it can read.
- Signing out, or switching the account under the phone, **ends the call**.
- A **reload cannot carry a call** (the media stack dies with the document), so
  a reload with a call live **asks for confirmation first** and nothing more is
  attempted.

## Permission and ring

- The microphone is asked for **as early as the surface can**, in its own
  gesture, by the same door the notification permission already follows (ADR
  0016): asked silently is a permission nobody grants, deferred to the first
  call is a call that fails at the worst moment. Until it is granted the phone
  says what is missing rather than pretending.
- An incoming call rings, a device that cannot play the ringtone still gets the
  visual ring, and the reader's **notification settings are respected** — a
  reader who silenced Gilbert is not rung audibly by it.

## Where the configuration and the credentials live

- The installation's telephone settings are **one administration page, SIP
  Phone** — the server endpoints in the order they are tried, the STUN/TURN
  servers, and the on/off switch. They are installation-wide and belong with the
  installation's own configuration (**ADR 0011**, the installation document),
  **not** in the environment and **not** per account. This is why there is no
  `sip` entry in the settings system (`gilbert-settings`): it is not a
  preference and does not follow an account.
- Each person's SIP address and password are **not** on that page. They belong
  to an **identity**, are set per identity in the identity-enforcement surface
  (**ADR 0007**), are account data, and can be enforced. A deployment that has
  set none has no softphone and the entry is not offered.
- The client never hardcodes an endpoint: it reads the installation's SIP
  settings from the server for the signed-in session. A deployment with none
  shows no phone.

## Global contacts

**Global contacts is one address book, owned by the Master, shared read-only
with every account, and written only by an administrator, from inside
Contacts** (ADR 0023).

- It is an ordinary JMAP `AddressBook` + `ContactCard` in the **Master's
  account** — a Stalwart object, never a second store in Gilbert.
- The share is **universal**: one rule, every account, including one created
  later — the deployment's own share shape, which ADR 0023 leaves owed a live
  probe. The administration re-applies it on every write, which is what brings
  an account created since the last one in; there is no per-member copy and
  nothing to add by hand.
- It is **read-only to everyone but an administrator**, and the administrator
  edits it **from inside Contacts** (the same write door every privileged write
  uses, ADR 0001/0007). The share carries read only, so a member's own session
  cannot edit a card; the client draws those cards with Edit and Delete
  withheld (`cardWritable`).
- It has a **section of its own, named Global contacts**, in the Contacts
  sidebar, beside the reader's books and each group's, and it is the same book
  merged into `All contacts`.
- **It is not a group book.** A group's books belong to the group's own account
  through membership (`gilbert-groups`); Global contacts belongs to the
  installation, is owned by the Master, and is read by everyone. Never create a
  Global contacts per group and never copy it per member.
- The phone reads it as one dialer source, beside each group's book, the
  reader's personal books, and all of them together.

**Owed a live server:** the exact Stalwart shape of a share that names every
account at once — one rule, and one that brings an account created later in
without a re-publish. Confirm it against a running 0.16 before trusting the
implementation (`gilbert-stalwart`, probes).

## The dialer

- The dialer's mini list is **read-only**: search and dial, never a write. No
  contact is created, edited or deleted there — not by a member and not by an
  administrator — because editing a contact belongs to Contacts.
- The list separates its sources: **Global contacts, each group (group A, group
  B, …), personal, and all** — the same separation the Contacts view draws.
- A call starts from either place, a line in the dialer's list or the contact in
  Contacts, and the two send the same invitation.
- Every number a contact carries (`phones`) is callable; the action is absent,
  not disabled, on a contact with no number.

## The map

- **Shared configuration** — `server/src/shared/installation.ts` carries the
  `sip` section: `installationDefaults()`, the type and the validator the boot
  and the admin page both read. It is spread by `server/src/bootstrap.ts` beside
  the rest of the document (`gilbert-project` §installation).
- **The client's phone** — `web/src/store/phone.ts` is the state; `web/src/lib/phone/`
  is the SIP.js wrapper and the dialer's source separation;
  `web/src/views/phone/` is the panel, the dialer, the incoming surface and the
  collapsed bar. The top-bar entry is in `web/src/views/AppShell.tsx`, and it is
  live in the same change that builds the rest.
- **Administration** — the SIP Phone page under `web/src/views/admin/`, reached
  from the admin navigation the way the other admin pages are; the per-identity
  credentials are on the identity cards (`EnforceIdentities.tsx` /
  `IdentityCard.tsx`).
- **The mock** — `server/src/mock/` reproduces what the phone depends on (the
  Global contacts book and its share, the installation document) and says in a
  comment what it does not reproduce; a real SIP server is never simulated.
- **The public documents** — `README.md` and `FEATURES.md` state the phone and
  Global contacts when they are built, the public ones first (`gilbert-project`).

## Rules

1. Read ADR 0023 before changing the phone; when the decision moves, rewrite the
   record and this file in the same change.
2. Never put telephony configuration in the settings system or the environment,
   and never put SIP credentials anywhere but an identity.
3. Ask the server for endpoints; never hardcode one.
4. Keep Global contacts **one** book with **one** universal share; a per-member
   copy is the failure this decision exists to prevent.
5. A rule that must hold for every entry point (who may edit a Global contacts
   card, when a call ends) lives on the **effect**, not on the button that draws
   the entry (`gilbert-project`).
6. The mock proves the client against itself; a real SIP server and a live
   Stalwart are the only things that can answer whether the phone really rings.

Companion skills: identity surfaces and Stalwart objects load `gilbert-stalwart`;
group books and membership load `gilbert-groups`; anything string-shaped loads
`gilbert-i18n`.
