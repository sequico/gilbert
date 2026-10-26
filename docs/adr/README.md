# Architecture decision records — index

One file per decision (`NNNN-kebab-case-title.md`), numbered by the owner: a
new record takes the number after the highest. A number is minted for a
decision that is new, never for a version of one already here.

A citation names a record that is a file here, and a section inside it is
named rather than numbered: the record's own structure is what a code
comment is read against.

Each record describes the decision as it stands and how it is built —
architecture, not a changelog. **A record is edited in place when the thing it
describes changes**, in the change that alters it: a later version of one
decision is the same file rewritten, so nothing here supersedes anything and no
record carries a `Superseded` status beside an ordinary decision, and nothing
narrates what used to be true. A reader who wants the version before this commit
asks git for it. The one exception is the owner asking for otherwise,
explicitly: only then does a decision get a record beside the existing one
instead of a rewrite of it, and that earlier record states `Status: Superseded
by NNNN.` — one line, naming the record that carries the decision now.

A record names a block — **gilbertmailer**, **gilbertserver**,
**gilbertagents**, **gilbertstalwart** — the way `README.md` defines it, and
redefines none of them: the definitions live there and are not restated here.
What
Gilbert *does* is the inventory in `FEATURES.md` and the code itself; a
record here explains why a piece of the architecture is shaped the way it
is, not what a user sees.

## The decisions

- **0001 — Administration.** Gilbert admin is Stalwart admin: a principal is
  an administrator exactly when its permission list carries a configured
  marker, read fresh on every privileged call. Every privileged write into
  an account goes through impersonation; the installation policy, the
  identity lock and the forced-password directive are all per-account
  documents written that way.
- **0002 — Upstream is download-only.** Releases are fetched at merge time,
  nothing flows back, and no mirror branch is kept. Hand-taken commits are
  recorded in `docs/upstream.md`, because taking one never makes a release's own
  commit an ancestor of `main`.
- **0003 — A contact group is not a recipient.** A group card
  (`kind: "group"`, its `members` named by `uid`, no address of its own) is a
  client-side convenience over addresses: the composer's To/Cc/Bcc
  autocomplete, the recipient picker and the contact card's "Email group"
  action resolve it through one resolver, when it is chosen, into chips for the
  individual addresses — one per member, the preferred one — so the wire, the
  drafts and the replies never know a group exists. Resolved against every book
  the reader may read, a group mailbox's books among them; a member that cannot
  be resolved is skipped and counted; no nesting, and no threshold of its own.
- **0004 — Group chat and the group label catalog.** Both are layers on the
  group account's own JMAP Files, owned by the group from creation.
- **0005 — Identity administration.** An administrator sets a person's or a
  group's identity through the same doors impersonation and the agent
  already open; a locked account has no path of its own to change it, and the
  lock is about personal mailboxes only. Which identity a member sends as in
  a group is **an assignment the administration records** in the group's own
  app folder — next to the identity it writes, in the same action — and not a
  comparison of display names: the name is what a recipient reads, and a name
  that is also a key fails on any spelling, any rename and any name nobody
  set. A member with no assignment sends as **the group's own identity**, the
  one the agent sends as, and only a group holding no identity at all leaves
  the composer with nothing to offer.
- **0006 — System Sieve scripts.** An admin editor for Stalwart's own
  trusted, server-wide Sieve scripts — a JMAP registry object
  (`x:SieveSystemScript`), not an account's own script — written directly as
  the administrator's session, no impersonation, gated by a permission
  separate from Gilbert's admin marker. Shares its editor component with the
  personal "Scripts (advanced)" tab rather than duplicating one.
- **0007 — The push subscription covers every live type, at the request's
  own origin.** One subscription per account names every state type a
  Gilbert surface keeps live, and its callback address is derived from the
  request rather than configured.
- **0008 — The policy publish is a job with an id.** One id per publish,
  carried by every copy it writes, and the job — the population the
  directory reported, the accounts the policy reached, the ones it did not
  with a code each, and whether the installation can be said to carry the
  policy — is one document in the publishing administrator's own app
  folder. Every per-account write is conditional, and the outcome cannot
  claim more than it reached.
- **0009 — The installation's configuration is the Master's own document.**
  `installation.json` in the Master account's `gilbert` app folder, read
  whole at boot and written by the administration through the same
  impersonation door; the environment carries only the handshake, the
  container's and the image's own facts, the operator's own switch, and the
  facts about the process itself. A publish applies from the next boot.
- **0010 — A durable write is caused by a change, not by a clock.** Stalwart
  charges an account for every blob it uploads and never gives one back, so a
  write on a clock — a session's activity stamp —
  spends a finite budget saying that a process is alive. Liveness and activity
  are process facts (the sessions store), a write that would
  store what is already there is not made, and an idle installation therefore
  costs nothing.
- **0011 — A dropped name is written over, in place.** A drop or a picker
  selection lands on a name the folder already holds by writing the bytes into
  the node that holds it — same id, same sharing, same place in the tree, only
  `blobId`, `type` and `size` change — so dropping a tree twice is one tree.
  The create's `alreadyExists` refusal is what identifies that node, so no level
  is listed first; a name a **folder** holds stops the file instead of writing
  into it, and saving an attachment into Files still refuses a taken name rather
  than replacing one.
- **0012 — Merging two folders is planned before it is written.** Both trees are
  read, the plan is built, and any collision — a name that is a folder on one
  side and a file on the other, or a right the reader does not hold — stops
  every step with nothing written. The folder whose name the reader keeps is the
  node that survives; a name both hold as a file is written into in place (ADR
  0011) and its source node destroyed; the folder given up is destroyed last and
  only once it is empty, so a stopped merge leaves both folders standing. The
  entry is offered for exactly two folders and drawn always, disabled until the
  selection is one it can act on.
- **0013 — A group's data is ended by an administrator only.** A group mailbox
  is reached by membership rather than by a share, so the mail server tells one
  member's delete from another's by nothing and offers no rank inside a group;
  the rule is the client's. Moving, binning, labelling, archiving and forwarding
  all stay, and the things that end a message for good — deleting it out of
  Deleted Items or Junk Mail, emptying one of those folders, and deleting a
  folder together with its mail — are refused for every member but an
  installation administrator, each refusal saying which one it is and what still
  works. Files answers the same question with a move: deleting a node puts it in
  the account's own Trash, whole, and restoring moves it back; emptying the Trash
  and ending one item inside it for good are the same administrator's decision in
  a group and the reader's own in their own account, and nothing empties on a
  clock. It is a rule the product keeps, not a boundary: another client destroys
  the same mail and empties the same Trash.
- **0014 — What notifies a closed Gilbert: the permission door, every mailbox, and chat.** A push subscription belongs to the
  principal that registered it and is served for every account that principal is
  a **member** of, so one row covers the reader's own mailbox and each of their
  groups — the group's mail already wakes a closed client today, as a
  notification that names nothing, and what it is owed is the per-account
  `emailPush` payload that names the sender, the subject and the mailbox it
  landed in. Chat rides the one vocabulary Stalwart has for a file: `FileNode`
  in the row's `types` wakes the service worker, which reads the message the
  app's watermark says it has not seen and stays quiet for its own. The
  notification permission is asked for in the reader's own gesture, iOS is
  answered with the install instruction rather than a switch that cannot work,
  and no sender of ours is introduced.
- **0015 — Administration is a door, not a menu.** The decision that a session
  may administer is made where the request is: the JMAP proxy refuses a body
  that names a registry object the session may not reach, behind an allowlist of
  the account's own objects, and every `/api/admin` route enforces the same two
  conditions — the installation offers administration (`server.administration`
  in its own document), and, where the installation asked for the rule, the
  session was signed in on a device marked as the person's own. The menu
  announces the decision and says why when it cannot; the server is the door.
- **0016 — A contact is moved between accounts by an administrator only.** A card
  is an object of one account and a group's card is the group's, so moving one
  across that line changes whose it is: the guard sits on the write
  (`moveCardTo`), the surfaces draw the entry from the same answer, and filing a
  new card into a group's book, editing one where it lives and re-filing a card
  inside one account are not moves and are unchanged.
- **0017 — A group's folders are subscribed for every member.** A subscription
  is read state kept for one principal, and membership writes none of it: a
  member of a working group holds the whole tree unsubscribed, which is
  invisible inside `gilbertmailer` (a tree that is not the reader's own is drawn
  whole) and total everywhere else. So the client subscribes the folders its
  membership is about as it reads the tree — one idempotent write per folder
  that lacks it, on every read, never on the reader's own mailbox — and asks
  whose tree is on screen of the **session** rather than of the account probe,
  so a member's tree is whole from the first frame and whatever the probe
  answers later. A member may write that field — confirmed live on 0.16.23
  (2026-09-24).
- **0018 — Archive puts a conversation back where it was filed.** A reply
  arrives, joins the thread, and the conversation is back in the Inbox while the
  rest of it sits in the folder it was filed under — so the archive button
  returns it there, and only a conversation that was never filed anywhere goes
  to Archive. The newest filed message decides (that is where it was last put),
  Inbox/Sent/Drafts/Junk/Trash are not filing places, a message already in the
  destination is filed away as before, and every read and write is asked of the
  account the action is aimed at, because a group's copy of a conversation and
  the reader's own are two threads. The dated entries keep their literal
  meaning.
- **0019 — Global contacts.** One address book in the Master's account, created
  by the installation rather than by hand, **read by every account through a
  server route** and written only by an administrator from inside Contacts. It
  leads the Contacts sidebar, above `All contacts` and the reader's own books, as
  well as being merged in it; its cards are ordinary cards. A `shareWith` naming
  every account cannot work — Stalwart caps a share at 10 principals per item
  (live-probed, 2026-10-02) — so the route is the door.
- **0020 — The knowledge base.** An enterprise knowledge base inside
  Gilbert, for people and for agents: a company-wide one owned by the Master and
  one per group, over app-folder documents in Stalwart. An article has one shared
  unapproved draft that users and agents both edit, and only an administrator
  approves it into force. Built for v1; co-editing and diagrams are deferred.
- **0021 — One gate, and nothing merges or ships unverified.** The gate has one
  source — `npm run check:ci` — run by the pre-push hook and by the CI release
  pre-check, so the two cannot diverge; the action-pin rule is a check
  (`workflow:pin`) rather than a reviewer's memory; the dependency audit runs
  where a release is prepared, not on every push; a release is verified after it
  publishes, on both architectures and with `:latest` naming the same index; and
  a Dependabot pull request merges only on its CI run's green completion,
  through `workflow_run` so the token may write, merging the exact commit the CI
  verified. The procedure and the rollback are `docs/releasing.md`. Built.
- **0022 — Supply-chain scanning in CI.** What the one gate of ADR 0021 does not
  answer — a known-weak code pattern, a credential in the history — is a
  separate workflow (`ci-security.yml`), deliberately outside `check:ci`:
  Semgrep at ERROR level across the TypeScript, Node, security-audit and OWASP
  packs, and Gitleaks over the history through the official action pinned to a
  commit, with `.gitleaks.toml` for the project identifiers that are not
  secrets and `.semgrepignore` to point the SAST scan at the code that ships. A
  finding is work to do in the same change, and an allowlist entry is a positive
  proof rather than a silence. Built.
- **0023 — The CodeQL analysis runs with the release.** CodeQL is not a
  per-push gate: it is a 686 MB toolchain, so it runs as a release pre-check —
  `.github/workflows/codeql.yml`, called by `release.yml`, with `cut` waiting on
  it — plus weekly and on dispatch. A file names it rather than a repository
  setting, so it is reviewed and pinned like the rest; it runs **on GitHub only**
  and there is no local analysis or toolchain (owner decision 2026-10-18). Built.
- **0024 — Workorders are group-owned parts.** A workorder is one uid
  with a root document in the Master's and a part in each competent group's own
  app folder; nothing is copied and no marker is planted in a work folder. The
  Master does every read and write. A checklist instantiates a KB template in
  force (ADR 0020) and materialises its applicable steps by path (ADR 0026).
- **0025 — The composer's editor is Squire.** Every surface
  that composes rich HTML — the message composer, templates and identity
  signatures — is driven by Squire (`squire-rte`, MIT), the editor built for
  email, whose HTML is the source of truth so a quote or a forward keeps a third
  party's markup and quoting is first-class. Against a hand-rolled
  `contenteditable` over `document.execCommand`, the engine normalises the
  browsers itself, keeps its own undo stack,
  ships no UI (the app's toolbar, popovers and translations are unchanged), and
  sets a link's `href` and an image's `src` as element properties rather than
  building markup, which removes the string-built-markup XSS class by
  construction. One component serves all three surfaces, sanitisation stays one
  policy (`sanitizeEditorFragment` for the engine, `sanitizeEditorHtml` for the
  rest), and the KB's block editor (ADR 0020) is a different tool. The library
  is taken unmodified — ADR 0002's download-only stance applied to a library —
  and its releases arrive through Dependabot's npm channel. Its MIT notice is in
  `NOTICE`.
- **0026 — A checklist template branches on data, not on groups.**
  One generic template per kind of job, in the company KB or a group's, and every
  group instantiates it; a group owns the **instance** and signs it, and is never
  a template of its own. The template is a **process document** — **variants**
  (choices with values), **sections** with steps, a **condition** on a section or
  a step, and a **repeat** that loops a section per item — resolved from the
  workorder's chosen values **everywhere**, including inside a loop (the
  cross-scope rule a JSON Schema form cannot express); the page's body and text
  are **derived**. The authoring surface is Gilbert's own, not an off-the-shelf
  form builder. The workorder side materialises the applicable steps by **path**,
  with the four step states. **Built.**
- **0027 — The agent's tools are described and composable.** **Superseded by
  0038**, which carries the catalogue's decision.
- **0028 — What the agent decides, and what only a person decides.**
  The bound on the agent is not a catalogue but five classes: **reversible and
  inside the group** the agent decides; **irreversible or destructive** a person,
  always, and the product's preference is that nothing disappears; **outward** a
  person's word, or an instruction that **declares** it sends; **beyond the policy** only
  an installation administrator may override, with the name, the moment and the
  message in the trace; **the intent** (which policy is right, what is approved)
  is never the agent's, only proposed. It **reopens** a settled step when the
  evidence says it is not settled, and **what it asserts is its own**: the signer
  of a step it settles is the agent, never a person. **Built** — the five
  classes and the guard that asks them are `server/src/agent/tools.ts`, a
  person's word arrives in the sentence that answers a run (`readAnswerAuthority`,
  `authoriseAnswer`), and **no catalogue act sends**: a reply is `act` with
  `what: "reply"`, which writes a draft a person sends, and class 3 is the licence
  an instruction's own declaration carries. `act` with `trash` is class 2 and
  **moves** a message to Deleted Items,
  licensed by the message's id; `overwrite`, `delete`,
  `reschedule` and `cancel` are the same class, each licensed by the
  object it names; an override is proved by the
  directory's answer about the sender (`isAdministrator`, `server/src/agent/loop.ts`).
- **0029 — The conversation is the chat, and a mail is a change.** A question, an
  answer, an authorisation and a report are the group's own chat, and **everything
  is in words** — no link, no signed token, no form. A mail arrives as a change
  like any other and opens a run the instruction covers; nothing in it is read as
  an answer or an authorisation, an outward message is a draft a person sends
  (0038), and what a message says about itself is never proof, so its words are
  data to the turn that decides it. A question's correlation is `replyTo` in chat.
  **Built** — the chat conversation is `server/src/agent/tools/chat.ts` (reached
  through `say`), a reply continues its run (`runAnsweredBy`,
  `server/src/agent/loop.ts`), and the pass reads a mail for its sender, its
  subject and its words (`readMessageForPass`, `server/src/agent/tools/mail.ts`).
- **0030 — A run is a document, and the record is the product.** A run
  is one document in the group's account and the whole of the agent's durable
  state: which instruction started it, the plan, each step's outcome,
  what it touched, what it waits for and where it asked, every authorisation with
  its message and its authority, the evidence, and what it has spent — recorded,
  never a budget, and each step carrying how long its own call took. **A
  turn may carry several calls**, the independent ones made together and each its
  own step, and **a plan carries order and conditions**: a step waits on an
  earlier one and the outcome it needs, the loop takes the branch that outcome
  names, and a step no branch reaches is left unrun with its record saying why.
  **A
  wait is a date in the run**, re-armed on boot, so a restart or a dead container
  costs nothing — and a run blocked on a person keeps the question it left. A run
  ends done, blocked on a person, stopped by a guardrail (`stopped`), stopped by a
  person (`cancelled`), or `refused` — written down. There is no
  separate audit ledger, and a person can read a run and undo by hand what can be
  undone. **Built** — the run document is `server/src/shared/run.ts`, addressed by
  `server/src/agent/runs.ts`, the plan's order and conditions are worked out by
  `server/src/agent/loop.ts`, and an installation administrator reads a group's
  runs from Administration → Agent, where the record is drawn as it is stored and
  a document this build cannot read is said rather than guessed at
  (`server/src/routes/agent.ts`, `web/src/views/admin/agents/GroupRuns.tsx`).
- **0031 — A group's engagement is a rule in prose.** **Superseded by 0038**,
  which carries the group's one instruction and the areas it works.
- **0032 — One agent per installation, held by a claim.** One
  `agent-claim.json` in the app folder of the account the agent signs in as — the
  Master's, one per installation and no per-group lease — taken by the
  compare-and-set JMAP offers and renewed while the holder works. It carries who
  holds it and when it stops being believed, and that instant means one thing:
  until it, the holder is believed; after it, the claim is free. A claim that is
  not renewed therefore lapses into the next process's hands; on this host a
  holder whose process is gone is taken at once, while another host waits the
  TTL. A release takes nobody's claim but its own; and a claim document that
  cannot be read is no claim at all, so a damaged one cannot leave the
  installation with no agent. **Built** (`server/src/agent/claim.ts`).
- **0033 — The agent's memory is a graph, and it recalls it on every call.** The agent **always** has memory: a graph of small facts with a
  provenance, in the **Master's own account**, in a **second store** beside the
  knowledge base — one memory for the installation, so a group reasons with what
  the whole installation knows. A call recalls a **selection** — the change's own
  subjects with their nearest links, plus the group's standing set, inside a
  ceiling — and what was recalled is written into the run's record (ADR 0030). The
  agent writes facts as it works, within the authority classes; an installation
  administrator reads, corrects and removes them from Administration → Agent, and
  **a person's fact is in force** — what the agent concludes against one it
  proposes, never overwrites. **Built**: the sheet and its selection are
  `server/src/shared/memory.ts`, the store, the agent's write and a person's
  correction and removal are `server/src/agent/memory.ts` in the Master's
  `memory/` folder, both turns carry the selection fenced as data
  (`server/src/agent/model.ts`), the run records what it recalled (`recalled`,
  `server/src/shared/run.ts`), a fact is kept with `act` (`what: "fact"`), and the surface is
  `server/src/routes/agent.ts` and `web/src/views/admin/agents/AgentMemory.tsx`. A conclusion
  against a person's fact is kept as a **proposal** (`FactProposal`) beside the
  person's sentence, and Administration accepts it — the correction path, whose
  write carries no proposal — or dismisses it.
- **0034 — A burst is one drop, and a question is asked once.** A
  `FileNode` change is one file of a drop, not a change of its own: a file
  landing in a folder is queued against that folder in the group's own app
  folder and answered once — one decision, one run, one report — when the folder
  has been quiet for five minutes or the drop is twenty minutes old, with the
  whole pack in the prompt. A message is queued against its sender the same way,
  and a case keeps its scratchpad under the agent's own bookkeeping. A folder
  that appears is not a document and a
  removal with no known path wakes nothing. The plan turn is shown the questions
  the group already has open, and `say` with `ask` does not post a duplicate: a
  question is asked once. A page's transcription is remembered by the content
  of its bytes, and an identifier the model cannot read is transcribed as
  `(unclear)`. The decision turn's calls are counted on the run it opens, a
  run's end is stamped when it ends, and the Work panel labels the steps a run
  spent and the plan entries that failed as the two tallies they are.
  **Built** (`server/src/agent/queue.ts`, `changes.ts`, `events.ts`, `model.ts`,
  `tools/chat.ts`, `web/src/views/admin/agents/AgentOverview.tsx`).
- **0035 — Ask Gilbert from a selection.** A file or a message selected in a
  group's Files or mail is sent to the agent as a chat draft: the context menu
  opens the group's conversation with the mention and the references — a file's
  path, a message's id and subject — and the person completes the request and
  sends it. The agent needs no new capability: the group's chat wakes it on the
  message, reads the references with the tools it has, and acts within the
  surface matrix (ADR 0038) and the authority classes (ADR 0028). Offered only
  where the agent serves the group, answered by a member route with the matrix;
  at most ten items, because a bulk write is one step each in a twenty-step
  plan. **Not built.**
- **0036 — A workorder anchors the mail and the files that belong to it.** Open:
  does a workorder take its mail, and what binds a conversation to it? The
  copying act is in the tree (`files.save` takes an attachment or a Files
  document into a visible folder) and so is the ref vocabulary with its member
  route, which no surface writes yet. The decisions left are whether a
  conversation is bound at all rather than found in the mailbox; whether a
  declared key matched deterministically, the agent's judgement or a person does
  the binding; what a key is (a normalized list, one non-terminal holder per
  account, matched as a token, carried to a replacement); whether the relation is
  one ref on the thread; whether the workorder becomes a section with its files
  and its mail beside its checklist or stays the panel it is; and whether a
  binder-written name on a collision is numbered or refused. Flat, with no facet
  layout. **Partly built, Proposed.**
- **0037 — The reading cursor is a document.** The state each account's change
  log was read up to is `gilbert/cursors.json` in that account's own app folder,
  read on a process's first pass and written after a batch that moved the
  reading — so a restart resumes where the last process stopped instead of
  anchoring at the present and losing the window in between. An unreadable
  document is a gap the pass says out loud. **Built, Proposed**
  (`server/src/agent/cursors.ts`, `agent/loop.ts`, `agent/events.ts`).
- **0038 — The agent is areas, verbs, and a person's yes.** The whole shape of the
  agent in one record: independent areas (mail, calendar, contacts, files,
  knowledge, workorders, chat, memory) whose actions a run is handed by
  **selection** — the areas the group's **one instruction** declares, plus chat
  and memory — with four verbs over the endpoint tools (`open` reads, `act`
  changes, `say` speaks, `note` keeps the case) rather than one tool per endpoint,
  whose arguments say which kind of id they take and whose results are distilled
  rather than forwarded; three beats — read, act, report — as the common path and a plan
  only when the instruction asks for one; **the change as the trigger**, the stream
  as the clock and the cursor as reconciliation; a run document that is the session,
  read by the harness in bounded slices; an outward message as a **draft a person
  sends** — no tool submits, a question is asked in the conversation, and the worst
  a malicious mail obtains is a draft somebody reads; a second cheap call that
  judges a report against the ask, its evidence and the shape the group declared;
  an evaluation set taken from the runs that failed; and no credential inside a
  document the agent can read. Replaces 0027 and 0031. **Partly built,
  Proposed.**
- **0039 — A message points at an object, never at an address.** A chat message
  carries references (`thread`, `file`, `contact`, `event`) as a kind and an id —
  never a URL, so a mail a stranger wrote cannot dictate a link Gilbert draws —
  and the address is composed where the chip is drawn, in the conversation, which
  opens the object below the panel and leaves the panel where it is. **Built,
  Proposed** (`shared/chat.ts`, `agent/tools/chat.ts`, `lib/agentRefs.ts`,
  `views/chat/ChatPanel.tsx`).

