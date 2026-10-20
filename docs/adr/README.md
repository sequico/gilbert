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
decision is the same file rewritten, so nothing here supersedes anything, no
record carries a `Superseded` status, and nothing narrates what used to be
true. A reader who wants the version before this commit asks git for it. The
one exception is the owner asking for otherwise, explicitly: only then does a
decision get a record beside the existing one instead of a rewrite of it.

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
- **0004 — A contact group is not a recipient.** A group card
  (`kind: "group"`, its `members` named by `uid`, no address of its own) is a
  client-side convenience over addresses: the composer's To/Cc/Bcc
  autocomplete, the recipient picker and the contact card's "Email group"
  action resolve it through one resolver, when it is chosen, into chips for the
  individual addresses — one per member, the preferred one — so the wire, the
  drafts and the replies never know a group exists. Resolved against every book
  the reader may read, a group mailbox's books among them; a member that cannot
  be resolved is skipped and counted; no nesting, and no threshold of its own.
- **0005 — Group chat and the group label catalog.** Both are layers on the
  group account's own JMAP Files, owned by the group from creation.
- **0007 — Identity administration.** An administrator sets a person's or a
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
- **0008 — System Sieve scripts.** An admin editor for Stalwart's own
  trusted, server-wide Sieve scripts — a JMAP registry object
  (`x:SieveSystemScript`), not an account's own script — written directly as
  the administrator's session, no impersonation, gated by a permission
  separate from Gilbert's admin marker. Shares its editor component with the
  personal "Scripts (advanced)" tab rather than duplicating one.
- **0009 — The push subscription covers every live type, at the request's
  own origin.** One subscription per account names every state type a
  Gilbert surface keeps live, and its callback address is derived from the
  request rather than configured.
- **0010 — The policy publish is a job with an id.** One id per publish,
  carried by every copy it writes, and the job — the population the
  directory reported, the accounts the policy reached, the ones it did not
  with a code each, and whether the installation can be said to carry the
  policy — is one document in the publishing administrator's own app
  folder. Every per-account write is conditional, and the outcome cannot
  claim more than it reached.
- **0011 — The installation's configuration is the Master's own document.**
  `installation.json` in the Master account's `gilbert` app folder, read
  whole at boot and written by the administration through the same
  impersonation door; the environment carries only the handshake, the
  container's and the image's own facts, the operator's own switch, and the
  facts about the process itself. A publish applies from the next boot.
- **0012 — A durable write is caused by a change, not by a clock.** Stalwart
  charges an account for every blob it uploads and never gives one back, so a
  write on a clock — a session's activity stamp —
  spends a finite budget saying that a process is alive. Liveness and activity
  are process facts (the sessions store), a write that would
  store what is already there is not made, and an idle installation therefore
  costs nothing.
- **0013 — A dropped name is written over, in place.** A drop or a picker
  selection lands on a name the folder already holds by writing the bytes into
  the node that holds it — same id, same sharing, same place in the tree, only
  `blobId`, `type` and `size` change — so dropping a tree twice is one tree.
  The create's `alreadyExists` refusal is what identifies that node, so no level
  is listed first; a name a **folder** holds stops the file instead of writing
  into it, and saving an attachment into Files still refuses a taken name rather
  than replacing one.
- **0014 — Merging two folders is planned before it is written.** Both trees are
  read, the plan is built, and any collision — a name that is a folder on one
  side and a file on the other, or a right the reader does not hold — stops
  every step with nothing written. The folder whose name the reader keeps is the
  node that survives; a name both hold as a file is written into in place (ADR
  0013) and its source node destroyed; the folder given up is destroyed last and
  only once it is empty, so a stopped merge leaves both folders standing. The
  entry is offered for exactly two folders and drawn always, disabled until the
  selection is one it can act on.
- **0015 — A group's mail is deleted by an administrator only.** A group mailbox
  is reached by membership rather than by a share, so the mail server tells one
  member's delete from another's by nothing and offers no rank inside a group;
  the rule is the client's. Moving, binning, labelling, archiving and forwarding
  all stay, and the three things that end a message for good — deleting it out
  of Deleted Items or Junk Mail, emptying one of those folders, and deleting a
  folder together with its mail — are refused for every member but an
  installation administrator, each refusal saying which one it is and what still
  works. It is a rule the product keeps, not a boundary: another client destroys
  the same mail.
- **0016 — What notifies a closed Gilbert: the permission door, every mailbox, and chat.** A push subscription belongs to the
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
- **0017 — Administration is a door, not a menu.** The decision that a session
  may administer is made where the request is: the JMAP proxy refuses a body
  that names a registry object the session may not reach, behind an allowlist of
  the account's own objects, and every `/api/admin` route enforces the same two
  conditions — the installation offers administration (`server.administration`
  in its own document), and, where the installation asked for the rule, the
  session was signed in on a device marked as the person's own. The menu
  announces the decision and says why when it cannot; the server is the door.
- **0018 — A contact is moved between accounts by an administrator only.** A card
  is an object of one account and a group's card is the group's, so moving one
  across that line changes whose it is: the guard sits on the write
  (`moveCardTo`), the surfaces draw the entry from the same answer, and filing a
  new card into a group's book, editing one where it lives and re-filing a card
  inside one account are not moves and are unchanged.
- **0021 — A group's folders are subscribed for every member.** A subscription
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
- **0022 — Archive puts a conversation back where it was filed.** A reply
  arrives, joins the thread, and the conversation is back in the Inbox while the
  rest of it sits in the folder it was filed under — so the archive button
  returns it there, and only a conversation that was never filed anywhere goes
  to Archive. The newest filed message decides (that is where it was last put),
  Inbox/Sent/Drafts/Junk/Trash are not filing places, a message already in the
  destination is filed away as before, and every read and write is asked of the
  account the action is aimed at, because a group's copy of a conversation and
  the reader's own are two threads. The dated entries keep their literal
  meaning.
- **0023 — Global contacts.** One address book in the Master's account, created
  by the installation rather than by hand, **read by every account through a
  server route** and written only by an administrator from inside Contacts. It
  leads the Contacts sidebar, above `All contacts` and the reader's own books, as
  well as being merged in it; its cards are ordinary cards. A `shareWith` naming
  every account cannot work — Stalwart caps a share at 10 principals per item
  (live-probed, 2026-10-02) — so the route is the door.
- **0024 — The knowledge base.** An enterprise knowledge base inside
  Gilbert, for people and for agents: a company-wide one owned by the Master and
  one per group, over app-folder documents in Stalwart. An article has one shared
  unapproved draft that users and agents both edit, and only an administrator
  approves it into force. Built for v1; co-editing and diagrams are deferred.
- **0025 — One gate, and nothing merges or ships unverified.** The gate has one
  source — `npm run check:ci` — run by the pre-push hook and by the CI release
  pre-check, so the two cannot diverge; the action-pin rule is a check
  (`workflow:pin`) rather than a reviewer's memory; the dependency audit runs
  where a release is prepared, not on every push; a release is verified after it
  publishes, on both architectures and with `:latest` naming the same index; and
  a Dependabot pull request merges only on its CI run's green completion,
  through `workflow_run` so the token may write, merging the exact commit the CI
  verified. The procedure and the rollback are `docs/releasing.md`. Built.
- **0026 — Supply-chain scanning in CI.** What the one gate of ADR 0025 does not
  answer — a known-weak code pattern, a credential in the history — is a
  separate workflow (`ci-security.yml`), deliberately outside `check:ci`:
  Semgrep at ERROR level across the TypeScript, Node, security-audit and OWASP
  packs, and Gitleaks over the history through the official action pinned to a
  commit, with `.gitleaks.toml` for the project identifiers that are not
  secrets and `.semgrepignore` to point the SAST scan at the code that ships. A
  finding is work to do in the same change, and an allowlist entry is a positive
  proof rather than a silence. Built.
- **0027 — The CodeQL analysis runs with the release.** CodeQL is not a
  per-push gate: it is a 686 MB toolchain, so it runs as a release pre-check —
  `.github/workflows/codeql.yml`, called by `release.yml`, with `cut` waiting on
  it — plus weekly and on dispatch. A file names it rather than a repository
  setting, so it is reviewed and pinned like the rest; it runs **on GitHub only**
  and there is no local analysis or toolchain (owner decision 2026-10-18). Built.
- **0028 — Workorders are group-owned parts.** A workorder is one uid
  with a root document in the Master's and a part in each competent group's own
  app folder; nothing is copied and no marker is planted in a work folder. The
  Master does every read and write. A checklist instantiates a KB template in
  force (ADR 0024) and materialises its applicable steps by path (ADR 0030).
- **0029 — The composer's editor is Squire.** Every surface
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
  rest), and the KB's block editor (ADR 0024) is a different tool. The library
  is taken unmodified — ADR 0002's download-only stance applied to a library —
  and its releases arrive through Dependabot's npm channel. Its MIT notice is in
  `NOTICE`.
- **0030 — A checklist template branches on data, not on groups.**
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
- **0031 — The agent's tools are described and composable.** The
  agent's capabilities are a small catalogue of **tools**, each one a task over an
  object Stalwart offers, and the **model chooses** which to call and in what
  order — **one or more in a single answer, together where independent** — never a
  list of permitted business actions, and no plan compiled at write time. It works on
  **five surfaces and has all of them**: the group's chat,
  mail, KB (checklist templates among its pages) and workorders, with its own runs
  beside them, each readable and writeable within the authority classes. A tool's
  description is the product's interface to the model; two tools that do one thing
  are a defect. The catalogue **grows freely** — a new tool is not an architectural
  decision, a new **object** or a change to the authority classes is — and every
  run carries a budget of steps, time and model calls. One model serves the
  installation, chosen in Administration → Installation
  (`web/src/views/admin/AdminInstallation.tsx`), in the installation's own
  document with a write-only key. **Built**, with the live provider probe owed —
  the catalogue is
  `server/src/agent/tools.ts`, both halves and the guard, the installation's one
  model is `server/src/agent/model.ts` (its two turns — the decision over the
  reading tools, the choosing over the whole catalogue and answering a plan), and
  the loop that works a run is `server/src/agent/loop.ts`, started by the server's
  own boot (`server/src/agent/supervisor.ts`).
- **0032 — What the agent decides, and what only a person decides.**
  The bound on the agent is not a catalogue but five classes: **reversible and
  inside the group** the agent decides; **irreversible or destructive** a person,
  always, and the product's preference is that nothing disappears; **outward** a
  person's word, or a rule that **declares** it sends; **beyond the policy** only
  an installation administrator may override, with the name, the moment and the
  message in the trace; **the intent** (which policy is right, what is approved)
  is never the agent's, only proposed. It **reopens** a settled step when the
  evidence says it is not settled, and **what it asserts is its own**: the signer
  of a step it settles is the agent, never a person. **Built** — the five
  classes and the guard that asks them are `server/src/agent/tools.ts`, a
  person's word arrives in the sentence that answers a run (`readAnswerAuthority`,
  `authoriseAnswer`), and `mail.send` is the outward act it licenses, for exactly
  the message it names; a rule that declares it sends is the authority of its own
  outward acts. `mail.trash` is the one destructive act and it **moves** a message
  to Deleted Items, licensed by the message's id; an override is proved by the
  directory's answer about the sender (`isAdministrator`, `server/src/agent/loop.ts`).
- **0033 — The conversation runs in chat and mail.** One
  conversation, two channels: a question, an answer, an authorisation and a report
  are the same in the group's chat and in mail, and **everything is in words** —
  no link, no signed token, no form, because a person away from the product has a
  mail client and nothing else. An instruction by mail is honoured only from a
  sender the installation knows or lists **and** with a passing authentication
  result from the receiving server; every message the agent sends carries
  `X-Gilbert-Run: <id>` so its own words can never drive it; the correlation is
  the thread in mail and a `replyTo` in chat. **Built** — the chat and mail
  conversation tools are in `server/src/agent/tools.ts`, the mail answer continues
  its run (`mailAnsweredBy`, `server/src/agent/loop.ts`), and `personWord`
  (`server/src/agent/trust.ts`) decides whether a message is anybody's word: a
  submission on the account the server authenticated, and an outside message
  refused until the `authserv-id` of a live verdict is probed.
- **0034 — A run is a document, and the record is the product.** A run
  is one document in the group's account and the whole of the agent's durable
  state: which rule or instruction started it, the plan, each step's outcome,
  what it touched, what it waits for and where it asked, every authorisation with
  its message and its authority, the evidence, and the budget it has spent. **A
  turn may carry several calls**, the independent ones made together and each its
  own step, and **a plan carries order and conditions**: a step waits on an
  earlier one and the outcome it needs, the loop takes the branch that outcome
  names, and a step no branch reaches is left unrun with its record saying why.
  **A
  wait is a date in the run**, re-armed on boot, so a restart or a dead container
  costs nothing — and a run blocked on a person keeps the question it left. A run
  ends done, blocked on a person, or out of budget — written down. There is no
  separate audit ledger, and a person can read a run and undo by hand what can be
  undone. **Built** — the run document is `server/src/shared/run.ts`, addressed by
  `server/src/agent/runs.ts`, the plan's order and conditions are worked out by
  `server/src/agent/loop.ts`, and an installation administrator reads a group's
  runs from Administration → Agent, where the record is drawn as it is stored and
  a document this build cannot read is said rather than guessed at
  (`server/src/routes/agent.ts`, `web/src/views/admin/AdminAgent.tsx`).
- **0035 — A group's engagement is a rule in prose.** One rule is one
  document in the group's own account, giving **each surface a mode** — the
  account's chat, mail, KB, workorders, Files and calendar — and saying **in
  prose what should happen** when the rule is woken. `watch` wakes the rule and
  lets the run it opens write the surface; `ondemand` never wakes it but lets an
  open run write it; `off` neither wakes nor writes, and reading stays free.
  Chat is always `watch`. The matrix is the rule's and the run carries it; the
  guard refuses a write on an `off` surface (`surface_off`) and the authority
  classes (ADR 0032) still bound what an act may be. A v1 rule is read as the
  matrix it means (watched surfaces `watch`, the rest `ondemand`). The calendar
  surface is in the matrix; the change log that would wake a rule on it is owed.
  A rule may **declare that it sends**. The agent's prose has three levels,
  outermost first: the installation's line, the group's standing instruction,
  the rule's own; a member reads the rules, and an **installation
  administrator** changes them and the standing instruction through the
  administration's route. **Partly built** — the rule documents are
  `server/src/agent/rule.ts`, the modes `server/src/shared/surfaces.ts`,
  addressed by `server/src/agent/rules.ts`, and the three levels are built by
  `server/src/agent/prose.ts`; a run records the rule and its matrix
  (`server/src/shared/run.ts`), and the loop that matches an event against the
  rules and gives every rule that fits it its own run is
  `server/src/agent/loop.ts`, started by the server's own boot
  (`server/src/agent/supervisor.ts`).
- **0036 — One agent per installation, held by a claim.** One
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
- **0037 — The agent's memory is a graph, and it recalls it on every call.** The agent **always** has memory: a graph of small facts with a
  provenance, in the **Master's own account**, in a **second store** beside the
  knowledge base — one memory for the installation, so a group reasons with what
  the whole installation knows. A call recalls a **selection** — the change's own
  subjects with their nearest links, plus the group's standing set, inside a
  ceiling — and what was recalled is written into the run's record (ADR 0034). The
  agent writes facts as it works, within the authority classes; an installation
  administrator reads, corrects and removes them from Administration → Agent, and
  **a person's fact is in force** — what the agent concludes against one it
  proposes, never overwrites. **Built**: the sheet and its selection are
  `server/src/shared/memory.ts`, the store, the agent's write and a person's
  correction and removal are `server/src/agent/memory.ts` in the Master's
  `memory/` folder, both turns carry the selection fenced as data
  (`server/src/agent/model.ts`), the run records what it recalled (`recalled`,
  `server/src/shared/run.ts`), `memory.remember` is the tool
  (`server/src/agent/tools.ts`), and the surface is
  `server/src/routes/agent.ts` and `web/src/views/admin/AdminAgent.tsx`. A conclusion
  against a person's fact is kept as a **proposal** (`FactProposal`) beside the
  person's sentence, and Administration accepts it — the correction path, whose
  write carries no proposal — or dismisses it.
- **0038 — A burst of files is one drop, and a question is asked once.** A
  `FileNode` change is one file of a drop, not a change of its own: a file
  landing in a folder is queued against that folder in the group's own app
  folder and answered once — one decision, one run, one report — when the folder
  has been quiet for five minutes or the drop is twenty minutes old, with the
  whole pack in the prompt. A folder that appears is not a document and a
  removal with no known path wakes nothing. The plan turn is shown the questions
  the group already has open, and `chat.ask` does not post a duplicate: a
  question is asked once. A page's transcription is remembered by the content
  of its bytes, and an identifier the model cannot read is transcribed as
  `(unclear)`. The decision turn's calls are counted on the run it opens, a
  run's end is stamped when it ends, and the Work panel labels the steps a run
  spent and the plan entries that failed as the two tallies they are.
  **Built** (`server/src/agent/queue.ts`, `changes.ts`, `events.ts`, `model.ts`,
  `tools/chat.ts`, `web/src/views/admin/agents/AgentOverview.tsx`).
