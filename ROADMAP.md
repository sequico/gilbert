# Roadmap / not yet

Things Gilbert does not do, and why. An issue number says where the entry came
from — upstream's thread where the item quotes one — not that it is tracked
there. An entry is here because the answer is "no", or because the work is
Gilbert's own and listed in this repository.

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what is built but worth knowing about.

- **What the agent still owes is a live probe, not a feature.** The Master's agent is
  designed by ADR 0027 (its tools), 0028 (what
  it decides and what only a person decides), 0029 (the conversation, in chat and
  mail), 0030 (a run is a document, and the record is the product), 0031 (a
  group's engagement is a rule in prose), 0032 (one installation claims its
  agent) and 0033 (its memory is a graph of facts it recalls). What the tree
  carries is a run's durable
  state (`server/src/shared/run.ts`, `server/src/agent/runs.ts`), the catalogue of
  tools a run's steps are taken with (`server/src/agent/tools.ts`), a group's
  rules and the three levels of prose every call is told
  (`server/src/agent/rule.ts`, `rules.ts`, `instruction.ts`, `prose.ts`), the
  installation's memory of facts (`server/src/agent/memory.ts`,
  `server/src/shared/memory.ts`), the installation's one model and its two turns
  of decision
  (`server/src/agent/model.ts`), the claim that holds the installation's one agent
  (`server/src/agent/claim.ts`), the loop that works a run
  (`server/src/agent/loop.ts`) — a pass claims
  the installation, re-arms the waits it finds, reads each account's changes, and
  works a run from the model's own choices with the budget, the guard and the
  record — and **the supervisor the server's own boot starts with itself**
  (`server/src/agent/supervisor.ts`, started in `server/src/index.ts`): it runs on
  the installation's model, reads the Master's groups from the mail server on
  every pass — so a group added in Stalwart's own directory is worked by the next
  one, with no restart — and asks for a pass every ten seconds, or thirty while
  the wake stream is connected, with the claim
  keeping an installation to one agent when a second copy of the server runs.
  The writing half of the catalogue does the reversible work of the group's own
  account, and three of its tools are the acts the inventory promises:
  `mail.draft` drafts a reply to everyone into the group's Drafts, sent by
  a person and by nobody else; `workorder.settle` settles a step of a workorder
  signed as the agent (ADR 0024); `knowledge.propose` writes a page's draft for a
  person to approve (ADR 0020). A conclusion
  against a person's fact is proposed beside it rather than written over, and
  Administration accepts or dismisses it (ADR 0033). The conversation runs in
  **mail** as well as in chat (ADR 0029): `mail.ask` sends the question to a
  principal with access and parks the run on it, the reply that names it in its
  thread continues the run, and `mail.send` carries a message outward once a
  person's own words or a rule's own declaration license exactly that message
  (ADR 0028). The destructive acts are **`mail.trash`**, `files.overwrite`,
  `files.delete`, `calendar.update` and `calendar.delete`, each licensed by the
  object it names: `mail.trash` moves a message to Deleted Items, a person
  licenses it by naming the message. An installation administrator's override is
  read once the **directory** says the sender is one. What is owed is
  what no test here can answer: a live provider, the arrival record a real
  Stalwart writes, and the change log's own paging cap (the `owed:` markers in
  ADRs 0027, 0029 and 0030).

- **The `workers` directory an installation has already written is left where it
  is.** It is one folder inside an account's app folder, created by an earlier
  design and named by a client that spoke a different vocabulary; nothing in the
  tree reads or removes it today, and it costs an installation nothing but a
  hidden folder. `GILBERT_AGENT_ADDRESS` and `GILBERT_AGENT_PASSWORD` are the
  Master's own handshake and stay as they are: they are an operator's spelling,
  and the installation's document is read with them (ADR 0009). Anything that
  gains the agent's vocabulary later follows the same rule — it moves with every
  reader and writer of it in one change, or it does not move.

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
  eleven translations), and their extraction is done — what each one is, which are
  out of Beta and what is still owed is
  [FEATURES.md](FEATURES.md#interface-language). Reading a few hundred strings
  and saying so is the most useful contribution available right now.

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

- **Granular roles and privileges.** A human account is one of two things: a
  normal user, or an installation administrator whose door is proved by the
  directory (ADR 0015). A normal user reaches their own account and the groups
  they belong to, and inside a group there is no role to hold — membership is the
  grant. To meet an ISO-style access-control requirement — least privilege,
  segregation of duties, per-area grants that can be reviewed — an installation
  needs more: roles, and a privilege per area (mail, calendar, contacts, files,
  the KB, workorders, chat, administration), so a person can be trusted with one
  part of the work and not another. That model is **not designed and not
  built** — no model, no ADR, no code — and until it exists the product offers
  the two-level boundary and the trace of every administrative act, which is not
  the same thing.

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
  base](FEATURES.md#the-knowledge-base)). ADR 0020 defers real-time co-editing and
  diagram pages. The company KB is read through the server route ADR 0019's probe
  settled on: a `shareWith` naming every account cannot work (Stalwart caps a
  share at 10 principals per item), so no share probe is owed.

- **Ask Gilbert from a selection.** ADR 0035 records the command and its shape;
  the tree does not carry it. It needs a shared action in Files and group mail, a
  per-account chat draft read by the group conversation's composer, and a member
  route answering whether the agent serves the group and the matrix it carries.
  The agent needs no new capability: the chat message it is sent is the one the
  chat rule already watches.

