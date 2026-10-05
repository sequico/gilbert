# Roadmap / not yet

Things Gilbert does not do, and why. An issue number says where the entry came
from — upstream's thread where the item quotes one — not that it is tracked
there. An entry is here because the answer is "no", or because the work is
Gilbert's own and listed in this repository.

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what is built but worth knowing about.

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
  approval, the surface and BlockNote editor, Orama search, the fleet's
  `knowledge` read/write/review — [The knowledge
  base](FEATURES.md#the-knowledge-base)). ADR 0024 defers real-time co-editing
  over Yjs/Hocuspocus (v1 saves the whole draft under `ifInState`) and Excalidraw
  diagrams. The company KB is read through the server route ADR 0023's probe
  settled on: a `shareWith` naming every account cannot work (Stalwart caps a
  share at 10 principals per item), so no share probe is owed.

- **Checks on an agent that is hung rather than gone.** An agent that stops
  making progress is recovered but never diagnosed: three missed heartbeats, the
  claim lapses, a successor takes over the work left mid-run, and an abandoned job
  is recorded as a `timeout`. Missing is *what it was doing and where it stopped*
  — the account and job in flight, the call it waits on, and errors swallowed
  into one log line per account and pass. It is optimisation, not a hole in the
  guarantee that the work moves.
  - It matters because the server can run an agent beside the web tier in one
    process (ADR 0003), so "agent hung" and "server hung" are one restart, and a
    quiet fleet inside a responsive process is the state nothing would name.
  - The shape is decided (ADR 0003: nothing supervises the fleet): the heartbeat
    record gains the unit and job with their start instant; the model's and JMAP
    clients' `AbortSignal.timeout` timeouts are named where a person looks; the
    health endpoint reports both, so a restart policy tells *working* from
    *stuck*. No supervisor — it would be a second coordinator beside the claims,
    and restarting what looks stuck is the double execution a claim prevents.
    Diagnosis first; concurrency, if it comes, is a bounded fan-out over units
    holding their own claim.

- **More than one agent inside one group.** The account is the unit of
  exclusivity — a claim on `<group>/gilbert/agent/claim.json` held by one agent at
  a time (ADR 0003), which keeps two agents from acting on the same mail twice.
  Between groups, work spreads by lease; inside one group everything is serial.
  The shape for parallelism: the account claim becomes the pieces needing
  exclusivity (a lease per reconcile type carrying its catch-up anchor, an entry
  per schedule rule); job execution keeps its lease; job *creation* stops
  depending on one holder — name derived from rule and trigger, created under a
  folder-state compare-and-set, so two matchers racing produce one document. It
  rests on an unverified premise: that `FileNode/set` refuses a create whose
  `ifInState` no longer matches, making a create a mutex (`writeAppFileAt` passes
  `ifInState`; a create conditioned on folder state has not been tried live). So
  the first step is a probe, then job identity, the per-type leases with a race
  test, the schedule, and the admin surface (which today says which agent holds a
  group). Worth doing when a measurement shows an intra-group bottleneck; it buys
  a bounded fan-out over units holding their own claim, never a child-process pool
  contending for the same account claim.

- **The prose still says "worker" where the product says "agent".** The vocabulary
  is one **master**, its **agents**, its **automations**, and "worker" for the
  browser's service worker. The identifiers follow: entrypoint
  `server/src/agent/agent.ts` and built path `server/dist/agent/agent.js`
  (package script, imports, `docker-compose.yml`, `.env.example`, README, ADRs);
  `AgentHandle`, `AgentDeps`, `startAgent`/`startAgents`, `AgentRecord`,
  `AgentStatusRow`, `LiveAgent`; the admin status carries `agents`; a claim names
  its holder in `agent`, with heartbeats under `agent/agents/`
  (`AGENT_HEARTBEATS_DIR`). What still says worker is prose in comments outside
  the fleet's directory.

- **The environment variables stay as they are** (owner decision 2026-09-12):
  `GILBERT_AGENT_ADDRESS` and its neighbours name the master's credentials, and a
  rename is a change to somebody's deployment file, not a codebase.

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
