# Roadmap / not yet

Things Gilbert does not do, and why. An issue number says where the entry came
from — upstream's thread where the item quotes one — not that it is tracked
there. An entry is here because the answer is "no", or because the work is
Gilbert's own and listed in this repository.

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what is built but worth knowing about.

- **Timed runs are a placeholder.** The chat's header carries a clock between the
  open questions and the runs, and pressing it says "To be implemented": the place
  where an instruction will schedule an act for a time (a report at 08:00, a
  reminder before a deadline) is reserved, not built. No run is scheduled for a
  time today: the agent lives on changes, and the supervisor's pass is the only
  clock.

- **The agent is one instruction, four verbs, and three probes still owed.**
  ADR 0038 is its design: it replaces 0027 (the catalogue) and 0031 (the rules),
  amends 0029 (the conversation) and 0030 (the plan), and keeps 0028 (what it
  decides and what only a person decides), 0032 (one installation claims its
  agent), 0033 (its memory is entities, typed relations and facts with their
  interval), 0034 (a batched drop)
  and 0037 (the cursor as reconciliation). What the tree
  carries is a run's durable
  state (`server/src/shared/run.ts`, `server/src/agent/runs.ts`), the four verbs
  and their per-value schemas (`server/src/agent/tools/jobs.ts`), narrowed to the
  areas a group's one instruction declares (`server/src/agent/instruction.ts`,
  `areas.ts`, `prose.ts`), the installation's memory of facts
  (`server/src/agent/memory.ts`, `server/src/shared/memory.ts`), the
  installation's one model with its native tool calling and structured decision
  turn (`server/src/agent/model.ts`), the claim that holds the installation's one
  agent (`server/src/agent/claim.ts`), the loop that works a run
  (`server/src/agent/loop.ts`) — a pass claims
  the installation, re-arms the waits it finds, reads each account's changes, and
  works a run from the model's own calls with the guard and the
  record — and **the supervisor the server's own boot starts with itself**
  (`server/src/agent/supervisor.ts`, started in `server/src/index.ts`): it runs on
  the installation's model, reads the Master's groups from the mail server on
  every pass — so a group added in Stalwart's own directory is worked by the next
  one, with no restart — and asks for a pass every ten seconds, or thirty while
  the wake stream is connected, with the claim
  keeping an installation to one agent when a second copy of the server runs.
  The writing acts do the reversible work of the group's own
  account, and three of the inventory's promises are among them: `act` with
  `what: "reply"` drafts a reply to everyone into the group's Drafts, sent by
  a person and by nobody else; `what: "settle"` settles a step of a workorder
  signed as the agent (ADR 0024); `what: "page"` proposes a page (ADR 0020). A
  conclusion
  against a person's fact is proposed beside it rather than written over, and
  Administration accepts or dismisses it (ADR 0033). **The conversation is the
  chat** (ADR 0029 as 0038 amends it): `say` reports, `ask` parks the run on a
  person's answer, and an outward message leaves only as a draft a person sends.
  The destructive acts — `act` with `trash`, `delete`, `mailFolderDelete` or
  `overwrite`, and `cancel` — are each licensed by the
  object they name. An installation administrator's override is
  read once the **directory** says the sender is one. The judge on the evidence,
  the injection test against the structural defence and the keyless replay of the
  recorded answers are built; what the agent still owes is the judge's
  **calibration** on a human sample, the live **embeddings** probe and the
  pruning of closed facts (ADR 0038, *Owed*); a live provider, the
  arrival record a real Stalwart writes and the change log's own paging cap stay
  owed as their ADRs say. Three measures are owed beside them: a `pass@k` for the
  eval, because one retry of a failed task is not the reliability a person
  experiences; the `pass@1` of the **three tasks taken from the failures of
  2026-10-26** (a delivery in pieces, a reference that lives in the thread, a list
  carried whole), which are written and pinned but never run on the tree; and a read
  of the memory's index that is not O(facts) per pass up to the cap. **Folding a
  burst of mail into one case** is a group's own choice and not the harness's: the
  drop queue folds a folder's files, while a delivery that arrives as one mail per
  item is one run per mail, and the case's note is what makes the second one cheap.

- **Two models in the key: a small one for the cheap turns, a frontier one for the
  work.** The installation chooses **one** model (ADR 0038) and every turn runs on
  it, while the decision turn — one short JSON answer per change — costs the same
  model as the run that plans and acts. Splitting them is a **cost and latency**
  decision and not a correctness one: with the catalogue offered as the provider's
  own tools, one frontier model is
  enough for the loop. Not designed and not built: it needs a second provider and
  key in the installation document (ADR 0009), the rule for which turn uses
  which, and the administration's surface for the pair.

- **An outside agent harness is not adopted — to evaluate, not decided.** The
  loop, the tool catalogue and the run document are Gilbert's own, and the
  question left open is whether the transport, or the whole harness, should come
  from outside. Read from npm and GitHub, the four candidates cost this: `ai`
  (Vercel, Apache-2.0) ships a major roughly every six months — seven since 2023
  — with ~650 releases a year, three direct dependencies and its gateway in the
  tree; `@openai/agents` (MIT) is still `0.x`, so any minor may break it;
  `@langchain/langgraph` (MIT) is the most disciplined, one major in 2.7 years,
  but its checkpointer is a database; `mastra` carries 21 direct dependencies
  that spawn processes, write files and report telemetry, so it cannot run in a
  container with no writable filesystem; the Claude Agent SDK is not open source
  and drives a proprietary binary over Anthropic's own auth. The rule that
  decides any of them is the one already true of every dependency here: **an
  outside component may enter only if its state is the run document, or it holds
  no state at all.** Re-open when one of these is true and not before: a second
  provider family that is not OpenAI-compatible is served; the time goes into
  parsing a transport rather than into jobs and instructions; the interface
  needs the turn streamed; `@openai/agents` reaches 1.0 with a session that can
  be a document. The other direction — Gilbert as an MCP verb surface, with the
  brain supplied by an operator's own harness — is the same question from the
  other side: it needs an administrator-approved MCP trust boundary and leaves
  the installation unable to work alone, so it is part of this same evaluation.

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

