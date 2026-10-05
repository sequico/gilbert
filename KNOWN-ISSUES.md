# Known issues and verified behaviour

What was checked, against which Stalwart, and when. For what is not built yet,
see [ROADMAP.md](ROADMAP.md).

These are not unknowns but facts: where Stalwart departs from a spec, where a
setting must be turned on for a feature to work, and what Gilbert deliberately
does not do. Nothing here is pending.

Each entry names the server and date it was exercised against; a behaviour
carrying an earlier version was checked against that one and has not changed
since. The newest server named is **0.16.22**, the release this build follows.

**0.16.21** was exercised by hand — mail, calendar and contacts — including
editing one occurrence of a recurring series and confirming the rest stayed. Four
behaviours a client must get right are covered below: an occurrence identified by
its recurrence id; `Calendar/get` and `AddressBook/get` returning every property
when none are named; EventSource advertising its ping interval in seconds; and a
calendar write requesting scheduling messages refused when the account may not
send them.

Entries say what and when because a claim of live verification can be wrong: the
0.16 registry path reads as verified live only when the capability is sought where
Stalwart advertises it.

An entry citing a live **0.15.5** on 2026-08-25 or earlier records a finding about
Gilbert, not the server — a byte cap that applies, a flow that works the same way.
Stalwart 0.15 is not supported.

- **Plural and locale rendering were confirmed live on the deployed instance
  (2026-08-31)** against a 6,289-message mailbox: role folders localise, the ~20
  custom folders keep the owner's names, dates and the calendar follow the
  language, and 6,289 renders as *6289 листувань* — the genitive plural a number
  ending in nine takes. The catalogue model is in
  [FEATURES.md](FEATURES.md#interface-language) and
  [CONTRIBUTING.md](CONTRIBUTING.md#translations); the gap that no catalogue has
  been read by an independent reviewer is [ROADMAP.md](ROADMAP.md).

- **`npm run i18n:coverage` counts only what it can see; an unseen string renders
  English however many catalogues ship.** It reads JSX text, missing a
  `toast.error(…)` argument, a `confirmDialog({ title, confirmLabel })` prop, a
  `title=`/`aria-label=` attribute, a template literal, and a computed label. The
  calendar view switcher spells its four labels out (`v[0].toUpperCase() +
  v.slice(1)` is untranslatable); **Day**, **Week**, **Month** and **Agenda** are
  in all twelve catalogues. `npm run i18n:check`'s second half
  (`scripts/i18n-literals.mjs`) accepts a string wrapped where written or present
  as a catalogue key (constant-table convention: `SECTIONS` holds
  `label: "About"`, the render site calls `t(s.label)`) and refuses one that is
  neither. A coverage number measures only what it can see.

- **A contact photo must be a `data:` URI; a `blobId` in a card's `media` is
  refused.** RFC 9610 allows a JSContact `Media.blobId` and the mock accepted
  one; **confirmed live on 0.16.22 (2026-09-16)**, a `ContactCard/set` carrying
  `media.*.blobId` fails with `invalidProperties` on `media` ("blobIds in media
  is not supported.") and the whole call fails. The RFC 9553 `uri` form holding
  `data:image/jpeg;base64,…` is accepted on create and update and returned
  unchanged (a 134 KB value was accepted). Photos are saved inline (`withPhoto`
  in `web/src/lib/contacts.ts`); other card media is left as it was; a `blobId`
  already on a card is still read back through the proxy. The mock refuses a
  `blobId` the same way, pinned by
  `server/src/mock/contact-photo-media.test.ts`.

- **A download honours a byte range but says nothing about it, and a range past
  the end is not a 416.** Stalwart answers a single `Range` with a 206 and
  `Content-Range` but sends no `Accept-Ranges` — **confirmed live on 0.16.22
  (2026-09-16)** — so the proxy advertises `bytes` itself (a PDF viewer needs it
  to page). A range the server cannot serve comes back as the **whole file with
  a 200**, never 416. The mock answers the same, pinned by
  `server/src/blob-ranges.test.ts`. Server-side `ContactCard/changes` reports
  creates, updates and destroys exactly (the contacts sync relies on it, same
  check).

- **A compressing hop in front of Stalwart truncates a blob download, silently.**
  - Node decompresses gzip before the code sees the body but leaves
    `content-length` describing the compressed bytes; copying it onto the longer
    forwarded body makes the browser stop there and call the download complete.
  - Case #76: a Coolify deployment whose Traefik compress middleware engages
    above 1 KiB — rules one and two pass, the third pushes a 1.3 KB filter script
    past it and it returns cut off mid-rule (384 bytes).
  - The save guard does not fire: a truncated script is neither unknown nor empty,
    so it parses with rules missing and the next save writes the short version
    over the real one.
  - Every blob download shares the fault, not only Sieve: message source, vCards,
    signature HTML, forwarded attachments and the `settings.json` sync. Settings
    fail `JSON.parse`, caught, leaving the local cache in charge — so they stop
    syncing rather than being overwritten.
  - The proxy asks upstream for `identity` and, for a hop that compresses anyway,
    forwards no length; the image proxy uses `node:http` directly, sends no
    `accept-encoding` and never decompresses.
  - The save path checks the script against the generator's shape (every
    `# rule:` comment parses; every enabled rule has an `if` and a closed body;
    every block ends with a blank line) and refuses on anything short; the rule
    editor reports it unreadable. The check is structural, so a differently
    serialized script stays editable.
  - It catches every cut except the end of a complete rule block (a legitimately
    shorter script, indistinguishable in bytes), which the `identity` request
    covers.

- **Delete all spam destroys; it does not pass through Deleted Items.** It is
  `Email/set destroy`, paged to survive `maxObjectsInSet`. **Confirmed live on
  0.16.19 (2026-08-26)**: Junk Mail emptied, Deleted Items stayed empty. No undo;
  the three entry points share one dialog saying so. Only Deleted Items and Junk
  Mail can be emptied, enforced in the store. **In a group mailbox, refused for
  everyone but an installation administrator** (ADR 0015), as are destroying out
  of Deleted Items/Junk Mail and deleting a folder with its mail — so a group's
  Deleted Items and Junk Mail fill and cannot be emptied, and the installation
  watches the group's quota. The rule is a client convention, **not a boundary**
  (another JMAP or IMAP client, or the server administration, destroys the same
  mail); ADR 0015: a group has no server-readable rank and destroy permission is
  per role, so withdrawing it would close the holder's own mail too.

- **Sharing a mail folder is accepted and does nothing.** `Mailbox/set` with
  `shareWith` is applied and read back, but the folder never appears for the
  shared-with account — **confirmed live on 0.16.19 (2026-08-27)**, a folder
  shared read-only to another account on the same server. Stalwart's docs list
  calendars, address books and file storage as shareable, not mail folders.
  Nothing reports failure; the share is stored, so a client trusting the read-back
  shows it live for ever. The entry point is not offered; an already-shared folder
  still offers **Stop sharing** (the only way to clear a share). File sharing is
  unaffected.

- **Address book sharing works.** Shared books appear in Contacts under "Shared
  with me" (not behind an account switch), and their contacts are offered when
  addressing.

- **Stalwart lets a sharee subscribe to a shared calendar but not a shared address
  book.** Subscribing writes the *owner's* account (`isSubscribed` lives on the
  collection), and 0.16.19 refuses it for a read-only shared book:
  `AddressBook/set` returns success with the id in `notUpdated`, `forbidden`
  ("You are not allowed to modify this address book."), while the identical
  `Calendar/set` is accepted. **Confirmed live on 0.16.19 (2026-08-27)** from a
  second account holding both shares; from the owner's account the write succeeds.
  Gilbert asks the server first and keeps the answer in synced settings
  (`addedShares`) when refused. The refusal is a *successful* response (code
  ignoring `notUpdated` sees nothing) and invisible from the owner's account.

- **A mailbox's `shareWith` is not returned unless asked for by name.**
  `Mailbox/get` with no `properties` omits the field — **confirmed live on 0.16.19
  (2026-08-27)**, still so on **0.16.21 (2026-09-06)**; on 0.16.21 `Calendar/get`
  and `AddressBook/get` return every property unasked, `shareWith` included.
  Gilbert names properties on all three, so a share is readable on any 0.16. The
  omission is silent: nothing is badged shared, "Stop sharing" does not appear,
  the dialog says *"not shared with anyone yet"* over a live share — and for mail
  folders it hides the only **Stop sharing** entry that can clear a share. The
  mock omits it for a mailbox the same way.

- **Stalwart's `x:PublicKey` registry works; Gilbert deliberately does not expose
  it.** No Settings section (PR #67, PR #285) because **nothing in Gilbert signs,
  encrypts, decrypts or verifies with a key**, so the page would only say adding a
  key does nothing. **Confirmed live on 0.16.20 (2026-09-05)** from a non-admin
  account; the full round trip (create, read back, rename, patch, destroy)
  succeeded for both formats.
  - An ordinary user may read *and* write their own keys, though Stalwart
    documents every `sysPublicKey*` permission as administrative; a malformed key
    is refused with `invalidProperties` naming `key`, not `forbidden`.
  - It parses S/MIME certificates as well as OpenPGP keys. A self-signed X.509
    with `emailProtection` and an `email:` SAN registered and destroyed cleanly; a
    malformed one fails with *"Failed to decode X509 certificate: BER decoding
    error: Expected Tag { class: Universal, value: 16 } tag…"*. Every other registry
    message names OpenPGP, even for non-OpenPGP input.
  - A key can parse and still be refused, differently: an OpenPGP sign-and-certify
    key with no encryption subkey (`gpg --quick-generate-key`) returns *"Could not
    find any suitable keys in OpenPGP public key"*, distinct from *"Failed to
    decode OpenPGP public key: Malformed packet: Malformed CTB…"*. Certificates
    have no such trap.
  - `emailAddresses` comes back as `{}` when empty (an object, not an array); check
    the shape before `join()`.
  - A create returns the id alone, no `createdAt`; patching `key` is allowed, and
    replacing a key by add-and-remove keeps `createdAt` meaningful.
  - `expiresAt` is the registry's own field, not derived from the key: a year-valid
    certificate registers with `expiresAt: null`.

- **Signature checking is done here, with a deliberately small trust model.**
  Stalwart neither verifies S/MIME/OpenPGP signatures nor exposes a result, so
  Gilbert does it in the browser (raw message, MIME split, PKCS#7, WebCrypto). It
  does **not validate a chain of trust** (no system trust store, no CA bundle, no
  revocation): a "verified" signature only shows the sender held the key in their
  own message, which anyone can self-sign. Weight comes from trust on first use —
  the first signed message from an address pins its fingerprint in account
  settings, and a later different certificate is reported loudly, never
  overwriting the pin. Hence the interface never says "verified" and a first
  sighting is grey. Verified against real `openssl smime -sign` output (RSA,
  ECDSA, plus a tampered copy).

- **OpenPGP signatures cannot be checked.** A PGP signature carries no key, so
  verification needs the sender's public key in advance, and there is no source:
  `x:PublicKey` holds the account's *own* keys, and a keyserver or WKD would
  reveal who you correspond with — the leak the image proxy closes. Such a message
  says *could not check*, not *did not check out*.

- **Two signature shapes are declined.** SHA-1 signatures are refused outright;
  RSA-PSS is declined because the salt length is in parameters Gilbert does not
  read, and guessing wrong would report a good signature as *bad*. Both show as
  uncheckable, not broken.

- **Read receipts are built here, not by the server.** Stalwart does not implement
  JMAP's [RFC 9007](https://www.rfc-editor.org/rfc/rfc9007.html) `MDN/send`
  (`urn:ietf:params:jmap:mdn` is not among its capabilities), so Gilbert assembles
  the `multipart/report` itself — raw MIME uploaded as a blob, `Email/import`, then
  `EmailSubmission` — which is why the receipt lands in Sent. Non-ASCII parts are
  base64, not `8bit`. There is deliberately no "always send" setting; each receipt
  is a decision. Verified against the mock and **confirmed live on 0.16.19
  (2026-08-26)**: a real sender's receipt was assembled, uploaded, imported,
  submitted, landed in Sent and set `$mdnsent`.

- **Where 0.16 advertises `urn:stalwart:jmap` decides whether sign-in is
  allowed.** Stalwart builds session-level `capabilities` from a fixed list
  (`Session::new`, plus WebSocket) that lacks this capability in every 0.16.x,
  handing it per-account instead, so it appears in `primaryAccounts` and each
  `accountCapabilities`. Reading `capabilities` alone makes every real 0.16 read as
  older, which drives three things: the self-service credential path 0.16 does not
  answer (`POST /api/account/auth` is gone, so password changes, 2FA and app
  passwords fail with "this mail server does not offer self-service credential
  management"), the wrong generation in About, and the older Files path. Gilbert
  looks in all three places, tested on each. Getting it wrong refuses every sign-in
  against a good server.

- **HTML signatures** — Stalwart caps a signature at 2047 **bytes** (`value.len()
  < 2048`, UTF-8 bytes not characters). Gilbert compacts pasted HTML, moves images
  to Files, and keeps an oversized signature in Files behind a short marker with a
  text fallback for other clients. Confirmed live on 0.15.5 (2026-08-24):
  oversized, non-ASCII and inline-image signatures save, and a test message reached
  Gmail intact with the logo inline.

- **An identity's Bcc is deferred to the client by the spec; Stalwart carries
  it.** RFC 8621 says the client adds `Identity.bcc` recipients to the message;
  Gilbert writes them into the draft's own Bcc field as it opens (ADR 0007).
  **Confirmed live on 0.16.23 (2026-09-24)**: `Identity/set` accepts `bcc`,
  `Identity/get` returns it, and a submission from that identity is accepted. The
  mock matches.

- **Settings live in the account's Files, not the browser.** `localStorage`-only
  preferences follow nobody between devices; the sharpest case is the default
  identity — with none, the first-sorting address wins, so mail can go from an
  unrecognised address (#54). Settings are a `settings.json` in the `gilbert`
  folder in JMAP Files, beside the signature images, keeping Gilbert stateless (no
  volume, no database; covered by the mail-store backup). `x:AccountSettings` does
  not fit (`locale`/`timeZone`/`description`, no free-form field; writing needs
  `sysAccountSettingsSet`, and the built-in user role carries only `…Get`).
  `localStorage` is a cache: the first frame paints from it, and without one
  defaults show. Screen/browser settings stay local (list-pane sizes, density, font
  size, sidebar state, notification toggles — a per-device browser permission); the
  split is a list of exceptions, so later settings sync by default. Writes are
  debounced three seconds; tab close and sign-out flush. The `gilbert` folder is
  hidden from Files with its contents (hiding the folder alone would reattach its
  nodes to the root). **Confirmed live on 0.16.19 (2026-08-26)**: Chrome-set
  settings returned on a fresh Firefox login and an incognito session; confirmed
  again on the deployed instance. Requires 0.16 (`FileNode/query` cannot see
  directories before it; sign-in refuses older). Two limits: conflicts are
  last-write-wins, and another open device sees a change only on its next sign-in.

- **Files on 0.16** — every node carries a `nodeType` and rights are four flags,
  not one `mayWrite`. Finding/creating a folder, creating a node with `nodeType`,
  uploading/downloading its blob and repointing a node ran live on 2026-08-26 (the
  settings file); rename, move and delete are **confirmed live on 0.16.19
  (2026-08-26)**. Two fallbacks: `ensureFolder` and `findInFolder` filter on
  `parentId`/`isTopLevel` alone and match names client-side (`name` is not a filter
  Stalwart is known to implement, and an unknown one fails the whole query); a
  refused filter or sort does not fall back to fetching every node.

- **Destroying a non-empty folder without the cascade flag is refused with
  `nodeHasChildren`.** `FileNode/set { destroy: [aFolder] }` without
  `onDestroyRemoveChildren` on a folder holding a file returns `notDestroyed`
  `{"type": "nodeHasChildren", "description": "Cannot delete non-empty folder."}`
  and changes nothing — **confirmed live on 0.16.23 (2026-09-24)**. The Files
  view's delete sends the flag; a **folder merge**'s last step deliberately does
  not, so a folder it did not empty stops the merge instead of vanishing with late
  arrivals (ADR 0014). Empty folders are destroyed either way. The mock models it,
  pinned by `server/src/mock/destroy-non-empty-folder.test.ts`; the refusal reaches
  the reader as the server's sentence.

- **Self-service credentials** — confirmed live against Stalwart 0.16.19
  (2026-08-25): app passwords created and revoked, password changed, 2FA enabled
  and disabled, the session surviving the switch to an app password. The mock
  enforces the same rules (current password required, password policy, a TOTP code
  on every request once 2FA is on, app passwords exempt). For external-directory
  accounts (LDAP/SQL/OIDC) Stalwart refuses a password change and shows its own
  message.

- **Scheduled send needs a setting on and stays silent when it is off.** Stalwart
  advertises the delay in the *account's* `urn:ietf:params:jmap:submission`
  capability — `maxDelayedSend: 2592000` (30 days), `FUTURERELEASE` in
  `submissionExtensions` (the session-level capability is empty). The MTA honours
  a hold only when `futureRelease` is set under the session's MTA extensions, which
  [defaults to false](https://stalw.art/docs/ref/object/mta-extensions/); with it
  off, Stalwart takes `HOLDUNTIL`, skips the hold and sends immediately **without
  an error**. Set `futureRelease` (shorter than 30 days is fine; past it a request
  is refused with a `forbiddenMailFrom` naming the limit). `npm run
  dev:mock:no-future-release` reproduces the silent drop. Gilbert asks the delay as
  RFC 8621 requires (`HOLDUNTIL` on the envelope's `mailFrom`, since `sendAt` is
  read-only) and files the held message in a **Scheduled** folder (else
  `onSuccessUpdateEmail` puts it in Sent). Nothing moves it out on expiry, so
  Gilbert reconciles on the way in: released to Sent, cancelled back to Drafts. The
  hold is **confirmed live on 0.16.19 (2026-08-25)** (a `HOLDUNTIL` ten minutes out
  returned `pending`, `sendAt` as asked, `250 2.1.5 Queued`); delivery and
  reconciliation are **confirmed live (2026-08-26)**. If Gilbert is never reopened
  the message still goes out; only the folder waits.

- **Stalwart 0.16 and RFC 8984 disagree about the calendar vocabulary, and the
  server only says so half the time.** A participant's address is
  `calendarAddress` (not `sendTo`/`email`), the organizer
  `organizerCalendarAddress` (not `replyTo`), a recurrence a single
  `recurrenceRule` (not a `recurrenceRules` array). Written the RFC's way,
  `CalendarEvent/set` **keeps the event and silently discards the participant
  map** — guests gone, no invitation (#26); the array rule is refused honestly with
  `invalidProperties`, so the RFC spelling cannot create or read a recurring event
  (#30). Gilbert writes Stalwart's names and reads either; the mock refuses what
  the server refuses. Verified against 0.16.19 on 2026-08-25 end to end:
  participants, organizer and rule survive create/update/re-read; an external Gmail
  invite arrived as a card and the decline was applied (`needs-action` → `declined`,
  sequence 1); cancelling notified the guest; guests can be added and cleared with
  `null`. RSVP patches `participants/{key}/participationStatus` (and
  `participationComment`) aimed at the base event via `baseEventId`, so it answers
  for the series. Adding a new participant by patch is refused (`Patch operation
  failed`), so a changed guest list is written as the whole `participants`
  property. An expanded occurrence carries a `recurrenceId` but no rule of its own,
  and `baseEventId` is set on everything an expanded query returns (a one-off
  included), so neither tests for recurrence.

- **Free/busy between accounts needs no sharing; calendar contents cannot be
  reached at all.** **Confirmed live on 0.16.20 (2026-09-01)** on the deployed
  instance: `Principal/getAvailability` answered for all seven directory
  principals, none sharing a calendar with the caller, with no `forbidden`, and
  returned real data (the caller's own principal reported one busy period against
  the one event in sixty days). A `Principal` carries only `id`, `type`, `name`,
  `description`, `email` — **no `accountId`** — so no handle reaches anybody's
  calendars. Free/busy is the only channel between accounts and is open by
  default. **Not settled**: the other six principals reported nothing over nine
  months, equally consistent with empty calendars and with an unreadable principal
  answering empty; until a second account with an event is tested, an unreadable
  participant is drawn unknown, not free.

- **An override can move an occurrence, making `start` and `recurrenceId` two
  different times** — the slot stays, only the clock time moves. **Confirmed live
  on 0.16.20 (2026-08-31)**: a weekly 09:00 occurrence moved to 14:00 returned
  `start: 2027-06-14T14:00:00` with `recurrenceId` still
  `2027-06-14T09:00:00`. This is why `recurrenceId` is the handle Gilbert holds:
  it survives a move and a re-resolution. A mock can wrongly overwrite an
  override's `start` with the slot time, so per-occurrence time editing looks
  broken against the mock and correct against the server.

- **An occurrence is identified by its recurrence id; holding its id across a
  write stays correct.** Expanded ids name the occurrence, not a series position,
  so a `recurrenceOverrides` entry leaves the other ids where they were.
  **Confirmed live on 0.16.21 (2026-09-06)**: five weekly occurrences expanded, the
  third retitled via its own synthetic id, all five original ids re-read and still
  resolved with their own dates, none `notFound`; a second override behaved the
  same. Gilbert re-resolves by `recurrenceId` immediately before
  `updateEvent`/`destroyEvent` anyway, because a date can leave a series and the
  client supports all 0.16. Expanded query order is not fixed (the overridden
  occurrence is last), so clients sort by `start`. The mock reproduces this and
  the suite pins it.

- **A per-occurrence patch of only inherited properties creates an override that
  loses the title.** Stalwart drops twelve properties from a per-occurrence patch
  *after* deciding to write an override, so such a patch still writes one carrying
  only the server-filled `start` and `duration`. **Confirmed live on 0.16.20
  (2026-08-31)**: `{"privacy": "private"}` aimed at one occurrence answered
  `updated`, left `privacy` untouched on the series and left that date with no
  title. Gilbert narrows a per-occurrence patch and sends nothing when narrowing
  empties it.

- **Recurring events can be edited and deleted one date at a time.** A write at a
  synthetic id becomes a `recurrenceOverrides` entry, not a series change; "this
  occurrence" and "the whole series" are distinct questions asked before acting.
  **Confirmed live on 0.16.20 (2026-08-31)** against a five-week series: a legal
  patch landed on the override with server-filled `start`/`duration`;
  `useDefaultAlerts` was refused ("This property cannot be modified on a single
  occurrence."); a destroy removed one date and left the series; a base event and
  an instance in one request were refused together (both ids, "A base event and its
  instances cannot be modified in the same request."). Scope is chosen before the
  editor opens, since it decides which event the form is about.

- **Editable date boxes are always Gregorian and Latin-digit**, even for locales
  whose display uses another calendar or numbering system (`fa-IR`, `th-TH`,
  `ar-EG`); they keep the locale's field order and separator, but a Buddhist-era
  year does not round-trip against the Gregorian grid. Non-Gregorian calendars are
  not implemented.

- **The account locale is read from `x:AccountSettings/get`** (permission the
  built-in user role has), falling back to `x:Account/get` (admin-only
  `sysAccountGet`). Both are 0.16 methods; a locale the server will not answer for
  leaves the browser's own, with the language choosable by hand. Confirmed live on
  0.16.19 (2026-08-25), capability sought where Stalwart advertises it; a mere
  refusal does not downgrade the detected generation.

- **An agent's first pass anchors at "now", and the server's answer is what makes
  it.** Every claim starts with an empty `states` map, and the executor asks
  `Email/changes` (and `FileNode/changes`) with `sinceState: "0"`; its branch for
  `cannotCalculateChanges`/`invalidArguments` records the account's current state
  and acts on nothing, so a fresh claim serves only mail arriving after it.
  **Confirmed live on 0.16.23 (2026-09-24)**: a `sinceState: "0"` query on a
  populated mailbox answers `invalidArguments`, so a new claim starts from now
  rather than firing every rule over the mailbox. Pinned by the executor's
  `reconcile` against the mock.

- **An account holds fifteen push subscriptions; a create past that is refused
  with `overquota`.** The ceiling on `PushSubscription` is fifteen per account and
  the refusal is `notCreated` `{"type": "overquota", "description": "There are too
  many subscriptions, please delete some before adding a new one."}` — **confirmed
  live on 0.16.21 (2026-09-14)** with an agent credential (the same request
  accepted on another account, refused on the sixteenth). Subscriptions accumulate
  through lifecycle: a client registering under an identity it cannot return with
  leaves one behind each time that identity dies. The symptom is quiet — the
  account drops to the per-tab relay, mail is never lost, only the fast path.
  Three server properties, recorded nowhere else:
  - a subscription outlives the process that made it, and only the credential that
    created it can destroy it;
  - a POST to a URL nobody answers is answered 404 and retried, not revoked;
  - `PushSubscription/get` does not return `url` at all (`url: null` even for a
    registered row, live on 0.16.21, 2026-09-14), so a leftover is recognised by
    its `deviceClientId`.
  Gilbert handles all three: the installation carries one identity,
  `gilbert-<deviceId>` derived from its Stalwart, base path and origin and
  surviving restart, so a boot releases its predecessor's row instead of adding a
  sixteenth; the browser carries one surviving its lifetime and releases it before
  making a new one; a create refused for want of a slot reclaims rows a past build
  left under the same prefix, told apart by the shape of the device id (a
  sixteen-character installation identity vs a random browser UUID), never by
  types. **Not verified** (recorded as such): whether an expired subscription
  frees its slot without being destroyed ("seven days" is the server's default
  lifetime, not a measured expiry); and what a browser's own row does at the
  ceiling (the client releases the never-verified or soonest-expiring row of
  another browser). **Verified**: a create asking for an `expires` a day out
  carries it back (live 0.16.21, 2026-09-14), and `update` of `expires` is
  accepted (0.16.22, 2026-09-16), letting a client extend its row instead of
  adding one. `scripts/probe-push-subscriptions.mjs` lists an account's
  subscriptions, frees `gilbert-…` rows, and can prove `overquota` with a throwaway
  create.
  - Two more properties, read from Stalwart's source at **v0.16.22**
    (`crates/jmap/src/push/set.rs`,
    `crates/services/src/state_manager/push.rs`): **a push URL may not point at a
    local or reserved address** (`validate_push_url` requires `https`, rejects
    credentials in the URL and non-global IPs), so a same-LAN push service
    (self-hosted `ntfy`, an UnifiedPush distributor on `192.168.…`) cannot
    register, failing with `invalidProperties` on `url`; and **a subscription
    serves every account its principal is a member of**, registering a verified row
    for each id in the token's `member_ids()` (the account plus its
    `member_group_ids`), so a group member is woken by the group's mail regardless
    — which is why the per-account payload ADR 0016 owes is a map in one row.
  - **One delivery is two pushes** (same source): the storage transaction that
    writes a message broadcasts a `StateChange`
    (`crates/common/src/storage/transaction.rs`) and the delivery broadcasts an
    `EmailPush` (`crates/email/src/message/delivery.rs`); the push client POSTs
    both. The subscription's `types` bitmap decides which: asking for `Email` made
    every read, flag and move from any client arrive as "new mail" and deliveries
    arrive twice; asking for `EmailDelivery` removes that noise at the source (the
    bitmap admits no `Email` state change, and the reader's own delivery arrives as
    the `EmailPush` naming its sender). **What a delivery to a group mailbox does
    is owed**: it is degraded to a plain state change there and nothing read says
    which type it wears — if not `EmailDelivery`, the bitmap filters it out and the
    "New mail" group notification stops silently. That is the fifth item under ADR
    0016's debt.
