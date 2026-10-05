# Roadmap / not yet

Things Gilbert does not do, and why. An issue number says where the entry came
from — upstream's thread where the item quotes one — not that it is tracked
there. An entry is here because the answer is "no", or because the work is
Gilbert's own and listed in this repository.

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what is built but worth knowing about.

- **`gilbertagents` is not functional, and a refactor is planned.** The whole
  agent part — the Master principal, the fleet, the automations, the approvals
  and the audit — is present in the tree but does not work, and it is being
  reworked. Everything below about chains of agents, claims, heartbeats and
  automation limits is therefore not yet reachable in a running installation;
  see [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

- **A scheduling view of its own.** The grid is built in the event editor — a row
  per participant, steppable, clickable to place the event — but there is no
  destination to visit with nothing in progress. A separate surface could only
  tell you a time you then retype; one beside the event can set it. #172 is where
  the ask came from; nobody has since asked for the standalone question.

- **Per-message actions from the message list on a touchscreen.** Reply, Forward
  and compose-as-new are on the row's context menu (a right-click); a long press
  on a phone starts selection, so none are reachable. They exist inside a thread;
  the missing list shortcut means deciding what a long press should do when it
  already means something.

- **Snooze** — unsupported by JMAP and Stalwart, and Gilbert stores no password,
  so nothing could act on a mailbox while you are away.

- **A translation anybody has checked.** Twelve languages ship (English plus
  eleven translations), and their extraction is done — see
  [FEATURES.md](FEATURES.md#interface-language). All eleven were AI-produced
  against standard dictionaries; only Turkish has been checked, by its
  contributor **Hakan Arslan**, and **none by an independent reviewer of this
  project**. They ship marked Beta, said in Settings with a link for reporting
  anything wrong. A language loses Beta when a speaker reads it and says so — a
  person's act, not a coverage percentage. Reading a few hundred strings is the
  most useful contribution available right now.

- **Right-to-left languages.** Arabic, Hebrew and Persian are held back
  deliberately, not for want of translators: RTL is bidi and layout work
  throughout (mirrored panes, gesture directions, icon sides, message-list
  geometry), and a catalogue without it is translated but unusable.

- **Two-factor sign-in.** An account with 2FA must use an app password (see
  [Quick start](README.md#quick-start)); Settings › Security can only turn 2FA
  off, not on. TOTP directly means OAuth: Stalwart offers the authorization-code
  and device flows and no password grant, so Gilbert would hand sign-in to
  Stalwart and come back with a token — better than the sealed password it holds,
  but it replaces Gilbert's sign-in page and may need an OAuth client registered.
  #75 is where it came from; the refusal points at app passwords.

- **Signing and encrypting mail.** Reading a signature is built (S/MIME checked
  on read; signer remembered; a change called out — [Checking a
  signature](FEATURES.md#checking-a-signature)). Producing a signature or
  touching ciphertext is not; it is client work over the MIME blob, not a
  Stalwart gap.
  - The blocker is the security model: signing and decrypting need a **private**
    key in a page served by the same host, conflicting with Gilbert storing no
    credential and running immutably. Verifying needs neither — the certificate
    is in the message — so it came first.
  - OpenPGP signatures are not checked: a PGP signature carries no key, so
    verification needs the sender's public key, and `x:PublicKey` is the
    account's *own* registry. A keyserver or WKD would reveal correspondents —
    the leak the image proxy closes. A local key store is possible and not small;
    unasked.
  - Publishing your own key to `x:PublicKey` is not built (PR #67, PR #285):
    nothing reads a registry key, so the Settings page would be furniture.
  - Encryption at rest is refused, not deferred: `encryptionAtRest` on
    `x:AccountSettings` beside `description`/`locale`/`timeZone` (there is no
    `x:EncryptionAtRest` object; the value is a typed object,
    `{"@type": "Disabled"}`). It is self-service and easy to offer, but turning
    it **off does not decrypt existing messages** — a one-way door that reads as
    "make my mail safer".
  - Neither is urgent: E2E mail never went mainstream (PGP is a rounding error of
    email and mostly signs packages), and the blockers are structural — mandatory
    participation; unsolved key discovery (unauthenticated keyservers weaponised
    in the 2019 certificate-flooding attacks; WKD not universal); no forward
    secrecy; clear metadata (subject lines in classic PGP/MIME, and who
    corresponded with whom); permanent loss on key loss; client degradation (no
    server-side search, weaker spam filtering, awkward on a phone) and EFAIL
    (2018, MIME/HTML). The real win arrived in STARTTLS, MTA-STS and DANE.
  - If one is built it is S/MIME — the one *more* deployed where software is paid
    for (Outlook, Apple Mail; defence, healthcare, finance, government; CA-issued,
    revocable certificates). The web of trust never scaled. Expect the asking to
    outrun the using: Stalwart self-hosters, privacy-minded users and European
    SMEs are the densest concentration of PGP users left, so it stays here
    described honestly.

- **The knowledge base's later phases.** The KB ships (storage, lifecycle and
  approval, the surface and its editor, search — [The knowledge
  base](FEATURES.md#the-knowledge-base)). ADR 0024 defers real-time co-editing and
  diagram pages. The company KB is read through the server route ADR 0023's probe
  settled on: a `shareWith` naming every account cannot work (Stalwart caps a
  share at 10 principals per item), so no share probe is owed.

- **The web's test suites still fake the JMAP envelope.** Thirty wrote the same
  loop (parse `methodCalls`, one `methodResponses` per call in its id, own method
  map and grab-bag default). `web/src/test/jmapServer.ts` is that loop once —
  register methods (`srv.on("Mailbox/set", ({ args }) => …)`), close over state,
  read `srv.calls`/`srv.callsTo`/`srv.count`. Four suites use it
  (`files-push-tree`, `thread-not-found`, `select-all-in-folder`,
  `archive-by-date`); the other twenty-six migrate as touched. The shared fake
  deliberately does not model Stalwart (unregistered methods return an empty
  result of every shape); the simulation is `server/src/mock`, and pointing the
  suites at it would make "one Stalwart" literal — a bigger change, since the mock
  is a Node server and the suites stub `fetch`.
