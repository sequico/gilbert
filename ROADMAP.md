# Roadmap / not yet

Things Gilbert does not do, and why. An issue number here says where the entry
came from — upstream's thread where the item quotes one — not that it is
tracked there. An entry is here because the answer is "no", or because the
work is Gilbert's own and is listed in this repository.

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what is built but worth knowing about.

- **A scheduling view of its own**, for asking "when is everyone free next week?" without an event in hand. The grid itself is built and lives in the event editor — a row per participant, steppable, and clickable to place the event — which is where the question gets asked while you are arranging something. What is not built is the same thing as a destination you can visit with nothing in progress. #172 is where the ask came from, and the panel in the editor answers it: the reasoning for putting it there is that a separate surface can only ever tell you a time you then retype, whereas one beside the event can set it. It stays here because nobody has yet said they want to ask the question on its own.
- **Per-message actions from the message list on a touchscreen.** Reply, Forward and compose-as-new are on the list row's context menu, which is a right-click — and holding a row on a phone starts selection instead, so none of them are reachable there. They are all available inside a thread, which is where the actions on a single message belong; what is missing is the shortcut from the list. Fixing it means deciding what a long press should do when it already means something, which is a bigger question than the actions themselves.
- Snooze (nothing in JMAP or Stalwart supports it, and Gilbert never stores a password, so nothing could act on a mailbox while you are away)
- **A translation anybody has checked.** Ten translations ship alongside English, and the extraction they need is done — see [FEATURES.md](FEATURES.md#interface-language). What is *not* done is the other half, and it is the half that cannot be bought or automated. All ten were produced by AI against standard dictionaries and **not one has been read by anybody who speaks the language**, which is exactly where a bad translation does harm rather than merely looking untidy. They ship marked Beta, with that said in Settings and a link for reporting anything wrong, because shipping them quietly would ask people to trust text nobody has checked. A language loses the Beta mark when a speaker reads it and says so — a deliberate act by a person, not something a coverage percentage earns. If you speak one of them and are willing to read a few hundred strings, that is the single most useful thing anyone could contribute right now.
- **Right-to-left languages.** Arabic, Hebrew and Persian are held back deliberately, and not for want of translators. RTL is bidi and layout work throughout — mirrored panes, gesture directions, icon sides, the message list's own geometry — and a catalogue without it produces a page that is translated and unusable. Adding one is not another entry in the picker.
- **Two-factor sign-in.** Today an account with 2FA must use an app password (see [Quick start](README.md#quick-start-docker)), and Settings › Security offers no way to switch 2FA *on* — only off, for an account that already has it. Supporting a TOTP code directly means implementing OAuth: Stalwart offers the authorization-code and device flows and no password grant, so Gilbert would hand sign-in to Stalwart's own login and come back with a token. That is a better security posture than the sealed password it holds now — a refresh token rather than a credential — but it replaces Gilbert's own sign-in page for those users and may need an OAuth client registered. #75 is where it came from, and the refusal names the problem and points at app passwords.

- **Signing and encrypting mail.** *Reading* a signature is built: S/MIME signed mail is checked as it is read, and the signer is remembered so a change is called out — see [Checking a signature](FEATURES.md#checking-a-signature). What is not built is anything that produces a signature or touches ciphertext, and the reason is not Stalwart. This is client work over the message body: JMAP hands over the MIME blob and the rest is ours.

  The blocker is a security model, not code. Signing and decrypting need a **private** key in a page served by the same host that would handle it, which runs straight into two things Gilbert says about itself: that it never stores a credential, and that it runs immutably with nowhere to keep one. Verifying needs none of that — the certificate travels inside the message — which is exactly why verifying comes first.

  **OpenPGP signatures are not checked, and this is a harder problem than it looks.** A PGP signature does not carry the key, so verifying one means having the sender's public key already. Gilbert has no source for it: `x:PublicKey` is the account's *own* registry, and fetching from a keyserver or WKD would tell a third party who you correspond with, which is precisely the leak the image proxy exists to close. A local store of correspondents' keys is possible and is not a small feature; nobody has asked for it yet.

  *Managing* keys — publishing your own to `x:PublicKey` — is not built (PR #67, PR #285), because a Settings page for keys nothing uses is furniture: nothing in Gilbert reads one. What signature checking uses is the certificate inside the message, not anything in the registry, so publishing your own key is a feature waiting for a consumer.

  **Encryption at rest is refused rather than deferred.** Stalwart offers it as `encryptionAtRest`, a field on `x:AccountSettings` beside `description`, `locale` and `timeZone` — there is no `x:EncryptionAtRest` object whatever the docs suggest, and its value is a typed object (`{"@type": "Disabled"}`) rather than a bare string. It is self-service, needs no administrator, and would be easy to offer. It will not be: turning it *off does not decrypt what is already there*. Every message delivered while it was on stays encrypted on disk, readable only by a client holding the private key, so switching it on is a one-way door — and a toggle that reads as "make my mail safer" while quietly being irreversible is the wrong thing to hand an ordinary user.

  **Why S/MIME rather than OpenPGP, and why neither is urgent.** End-to-end encrypted mail never reached the mainstream and is not on its way there: as a share of the world's email, PGP-encrypted messages are a rounding error, and the most successful use of OpenPGP is signing packages rather than sending mail. The reasons are structural rather than a matter of better tooling. Everyone in a thread has to take part, so the network effect works against it from the first reply. Key discovery was never solved — keyservers were unauthenticated and got weaponised in the 2019 certificate-flooding attacks, which made specific people's keys unusable by any client that fetched them, and WKD is better without being universal. There is no forward secrecy, so one compromised key retroactively opens everything ever received. The metadata stays in the clear: subject lines are cleartext in classic PGP/MIME, and who corresponded with whom is often the sensitive part. Losing a key loses the mail permanently. And it breaks the client — no server-side search, degraded spam filtering, awkward on a phone — while EFAIL showed in 2018 that the clients themselves were exploitable through MIME and HTML handling. Meanwhile the actual privacy win arrived invisibly and without anyone participating, in STARTTLS, MTA-STS and DANE.

  So if one of the two gets built here it is S/MIME, because it is the one that is *more* deployed in the places that pay for software: native in Outlook and Apple Mail, and routine in defence, healthcare, finance and government, where a CA issues and revokes certificates that an IT department can actually administer. The web of trust never became something anybody could run at scale.

  Expect the asking to be far out of proportion to the using. A self-hosted webmail for Stalwart draws self-hosters, privacy-minded users and European SMEs, which is about the densest concentration of PGP users left alive — so this will be requested much more often than it would be used, and that is an argument for keeping it here, described honestly, rather than either building it on the strength of the requests or refusing it outright.

- **The knowledge base.** A company-wide KB owned by the Master and shared with
  every account, plus a KB per group owned by the group, holding documents in
  Stalwart under one shared draft per article and an administrator's approval
  with an effective date issuing a revision (ADR 0024). Every document is written
  through the server acting as the Master, which is where the administrator check
  an approval is gated on lives, and the company KB is read through a read-only
  share to every account; the KB is the strategic layer — policies, procedures
  and the checklist templates a workorder instantiates (ADR 0028). The record is
  **Proposed** and deliberately a working notebook: the editor (BlockNote) and the
  search (Orama) come off the shelf, and the storage, ownership, versioning,
  approval and the fleet's document-controller behaviour are Gilbert's own. What
  still decides it —
  co-editing in v1 or a lock, the editor, the search index, the anonymous
  surface — is in its **Questions, settled and open**.

- **Checks on an agent that is hung rather than gone.** An agent that stops making progress is recovered today but never diagnosed. The lease covers the outcome: three missed heartbeats and it reads as not reporting, the claim lapses, and a successor takes the account over with the work it left mid-run — a job nobody comes back for is recorded as a `timeout`, not a failure. What is missing is the answer to *what it was doing and where it stopped*: the account and job in flight, the call it is waiting on, and the errors it swallowed into one log line per account and per pass, with nothing counting them. This is optimisation work, not a hole in the guarantees: the guarantee is that the work moves, and it does.

  It matters because the server can run an agent beside the web tier in its own process (ADR 0003), so "the agent hung" and "the server hung" are one event and one restart, and a fleet that is quiet inside a process that still answers requests is exactly the state nothing would name.

  **The shape of it is decided (ADR 0003: nothing supervises the fleet).** The heartbeat record each agent already rewrites — which names the groups it holds — gains the unit it is working and the job it is in, with the instant that started, so "hung" and "in the middle of a long model call" stop reading the same from outside; the timeouts the model and JMAP clients already carry (`AbortSignal.timeout`) are named where a person looks, with the job and the call they ended, instead of being a line in a log; and the health endpoint reports the same two, so a restart policy can tell *working* from *stuck*. No supervisor and no process manager is introduced to get it: a supervisor would be a second coordinator beside the claims, and restarting what looks stuck is the double execution a claim exists to prevent — a lease already takes an account over from a dead holder. Diagnosis first, because it is what a person actually lacks; concurrency, if it ever comes, is a bounded fan-out over units that hold their own claim (below).
- **More than one agent inside one group.** Today the account is the unit of exclusivity: a claim on `<group>/gilbert/agent/claim.json` is held by one agent at a time (ADR 0003), which is what keeps two agents from acting on the same mail twice. Work *between* groups already spreads — several agents split the groups between them by lease — but inside one group everything is serial: one change type at a time, jobs one after another. What is not built is parallel execution inside a group, and the shape of the change is known: the account claim stops being one document and becomes the pieces that actually need exclusivity (a lease per reconcile type, carrying that type's catch-up anchor, an entry per schedule rule), while job execution keeps the lease it already has and job *creation* stops depending on a single holder — the job's name derived from the rule and its trigger, created under a folder-state compare-and-set, so two matchers racing produce one document instead of two.

  That last piece is the load-bearing one and it rests on something unverified: that `FileNode/set` refuses a create whose `ifInState` no longer matches, which would make a document create a mutex. `writeAppFileAt` already passes `ifInState` and every read-modify-write in the agent store uses it, but a *create* conditioned on the folder state has not been tried against a live 0.16 or taught to the mock. So the first step is a probe, not a refactor. Order after that: job identity, then the per-type leases with a test that two agents racing one trigger leave one job, then the schedule, then the admin surface — which today says which agent holds a group, and would have to say which unit.

  Worth doing when a measurement says the bottleneck is inside one group. Nothing in the product is slow because of this yet, and the failure it can cause (two effects on the same message) is the one the current design spends a whole document on preventing. What it buys is a bounded fan-out over units that hold their own claim — never a pool of child processes inside one process, which would contend for the same account claim and buy nothing (ADR 0003).

- **The prose still says "worker" where the product says "agent".** The
  vocabulary is one **master**, its **agents**, its **automations**, and
  "worker" for the browser's service worker. The identifiers, the wire and the
  stored documents follow it: the fleet's entrypoint is
  `server/src/agent/agent.ts` and its built path `server/dist/agent/agent.js`,
  named the same way by the package script, the two imports, the deployment's
  own command in `docker-compose.yml`, `.env.example`, the README and the ADRs;
  `AgentHandle`, `AgentDeps`, `startAgent`/`startAgents`, `AgentRecord`,
  `AgentStatusRow` and `LiveAgent` are the code's own names; the admin status
  answer carries `agents`, which the client reads; and a claim names its holder
  in `agent`, its stream claim too, with the heartbeats under `agent/agents/`
  (`AGENT_HEARTBEATS_DIR`). What still says worker is the prose in comments
  outside the fleet's own directory.
- **The environment variables stay as they are** (owner decision 2026-09-12):
  `GILBERT_AGENT_ADDRESS` and its neighbours name the master's credentials, and
  a rename is a change to somebody's deployment file rather than to a codebase.

- **The web's test suites still fake the JMAP envelope for themselves.** Thirty
  of them wrote the same loop out: parse `methodCalls`, answer one
  `methodResponses` entry per call in the call's own id, each with its own map of
  methods to answers and its own grab-bag default. `web/src/test/jmapServer.ts`
  is that loop once — a suite registers the methods its assertions are about
  (`srv.on("Mailbox/set", ({ args }) => …)`), closes over whatever state it
  keeps, and reads back what was asked (`srv.calls`, `srv.callsTo`, `srv.count`).
  Four suites use it (`files-push-tree`, `thread-not-found`,
  `select-all-in-folder`, `archive-by-date`); the other twenty-six migrate as
  they are touched, which is the moment a suite is read closely anyway.

  What the shared fake deliberately does not do is model Stalwart: it answers the
  envelope and records the calls, and a method nobody registered comes back as
  the empty result of every shape. The simulation is `server/src/mock`, the one
  that has to agree with a real server. Pointing the client's suites at *that*
  instead of at a fetch stub is the change that would make "one Stalwart" literal
  rather than rhetorical, and it is a bigger change than this file's shape:
  the mock is a Node server, and the suites stub `fetch`.

