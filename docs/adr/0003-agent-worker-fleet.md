# ADR 0003 — Agent worker fleet: workers that act on Stalwart events and schedules

Status: Proposed (2026-09-06)

> **Scope confirmed by the owner (2026-09-06):** Gilbert's own agents
> ("Gilbert's own agents now, external agent fleets later" — ROADMAP), each
> agent having its own email address in Stalwart (e.g. `gilbert@…`), acting
> both on Stalwart events and on time schedules. First use cases: moving
> group messages, extracting files from incoming mail, and an open-ended rule
> set to grow from there ("chi più ne ha più ne metta"). The Sieve boundary is
> confirmed: Sieve owns delivery-time actions inside Stalwart; workers act
> afterwards, on delivered, durable state.
>
> A survey of established agent-fleet orchestration repositories (2026-09-06;
> re-surveyed 2026-09-09, findings in Decision §7) informs Decision §7:
> Gilbert adopts the field's *patterns*, never its
> infrastructure — every surveyed engine runs on a queue/database/volume of
> its own, which this repo's law forbids.

## Context

Gilbert's direction is a lifecycle butler whose agents act inside mail and
file storage for a person or a group. Today nothing runs outside the web
request path: the only live connection is each signed-in browser's push
stream, proxied by the Node server, and nothing in the product reacts to a
mailbox changing unless a user is looking at it.

Facts from the current machinery:

- Stalwart exposes no general application webhook bus. The client-visible
  event surface is JMAP state-change push
  (`urn:ietf:params:jmap:push:state`) over the account's EventSource: it says
  *which account* and *which type* changed, never *what* changed.
- The server already relays that stream to browsers (`/api/events` in
  `server/src/app.ts`, type filter, ping), and the web client treats each
  event as a refresh trigger per type (`web/src/jmap/push.ts`). Workers are
  headless: no proxy, no browser — a direct JMAP session to Stalwart, using
  the same EventSource protocol.
- A principal's JMAP session includes every account it is granted over, so
  one agent principal receives one multiplexed push stream for all the
  accounts it may see, keyed by `accountId`. That list is reach, not a role:
  since ADR 0007 the admin is a permission marker on the account's own
  capability list, not a group grant.
- Sieve scripts run at delivery time inside Stalwart itself. They are the
  delivery-time mechanism and stay that way; they are not a general executor
  for JMAP-level, application actions (move across shared mailboxes, file
  extraction, richer rules).
- JMAP has no compare-and-set. Concurrency primitives must be built from
  owned documents and conditional patches (expected-owner update), exactly as
  the account-owned policy documents are.
- Architecture law: everything durable lives in Stalwart — no own database,
  no writable volume; the container is disposable. New identifiers are named
  `gilbert`.

## v1 scope (owner decisions 2026-09-09, extended 2026-09-10)

The general model below (Decisions §1–§7) describes the full design. The
owner has since scoped v1 to a single self-hosted installation; this
section amends or defers parts of that model for v1, and the rest of this
record keeps its full shape as the evolution path.

- **One structure agent, `gilbert@`, fixed.** v1 ships exactly one agent
  principal — a persona that works across areas (mail, files, tasks,
  calendars, contacts) and across the groups it is granted, not one
  identity per group — created operator-side in Stalwart's own
  administration (the same surface that creates accounts), then registered
  with the installation and granted per group from the Gilbert admin.
  Further agent principals (`gilbert1@`, …) and external agent fleets
  (README: "Gilbert's own agents now, external agent fleets later") are
  future work on the same machinery, not a v1 configuration knob.
- **What is configurable is its workers, by area.** The agent's work is
  divided into areas — mail, files, tasks, calendars, contacts — and a
  deployment declares how many workers serve each. **A worker is its own
  process**, not a replica of gilbertserver: the same codebase with a second
  entrypoint, deriving its session as `gilbert@` the same way the web tier
  does. It needs no coordinator because the documents are the coordination
  (§6): each worker claims the `account × area` units it will serve by
  lease, and exactly one of them additionally holds the agent's event
  stream. v1 defaults to a single worker covering every area.
- **The worker lives beside gilbertserver, as its own process.** It shares
  the image and the codebase (`server/`) but not the process: the web tier
  stays client-facing, and the worker holds what a request path must not —
  long-lived sessions, claims and waits on people. Its state is the
  documents, so a deploy or a crash costs only the work in flight: the
  session is re-derived at boot (below) and stale leases are re-claimed.
  Wake-ups come from the agent's own event stream (Decision §3), held by one
  worker under the stream claim, with per-type polling from a recorded state
  as the fallback; nothing in the web tier relays events to the worker, so
  there is no cross-process queue to keep in sync. A single-container
  installation runs both processes from one image; a busy area is another
  worker, declared at deployment and coordinated by lease (§2, §6) — never
  a supervisor (resolution 8).
- **One bootstrap secret: the agent's own app password.** The deployment
  carries `GILBERT_AGENT_ADDRESS` and the matching app password, and the
  worker opens its session by authenticating as the agent — no
  impersonation at boot, no operator account, no derivation chain. (The web
  tier reads the same variables only to know which address to register and
  verify.) The
  secret is the agent's, not a person's: its reach is exactly the agent's
  grants (Consequences), and an operator leaving cannot strand the agent.
  Nothing needs a writable filesystem, so `IMMUTABLE=1` holds: the session
  stays in memory and is re-established at every boot. The environment (or a
  read-only mounted `GILBERT_AGENTS_FILE`, the `STALWART_SERVERS_FILE`
  shape) is the only place a pre-session credential can live — a
  runtime-written `.env` is impossible on a read-only root and pointless on
  a disposable container, because `.env` is read at boot and the container
  is replaced from the image. Rotating the secret therefore means updating
  the deployment and restarting; an installation that would rather never
  touch it keeps the recorded alternative — an operator credential holding
  `Impersonate`, from which the agent's app password is created or recovered
  under impersonation (Open questions, probes c and d).
- **The agent principal is not granted `Impersonate`.** v1 reaches groups by
  membership, never by becoming someone; Stalwart refuses impersonated group
  mailboxes anyway (live-verified, 403), so the permission would buy only
  the ability to act as human users — out of v1 scope — and would sit on the
  identity a model drives. The admin-facing direction stays: the signed-in
  admin impersonates the *agent* to manage it.
- **Management is automatic from the admin surface, via impersonation.**
  The signed-in admin selects the agent account; gilbertserver creates and
  rotates the agent's app passwords through JMAP `x:AppPassword/set` under
  impersonation (live-probe item — Open questions) and manages everything
  else through ordinary JMAP on Stalwart documents. No Management API, no
  hand-edited files, no fields to paste secrets into. Rotation lands on the
  deployment: the UI rotates the credential underneath, and the environment
  has to agree with it at the next restart — a rotation is complete when
  both say the same thing.
- **The agent's own account holds its configuration; the group's account
  holds the work.** Per-agent settings are documents in the agent account's
  own `gilbert/` app folder (Decision §4): its registration record and the
  **model providers per tier** — resolution 2's tiers (T1 classifier, T2
  agent; T0 calls no model) each name a provider, model, base URL and API
  key, so different tiers can run on different vendors or on a local model.
  Provider keys are write-only in the admin UI (stored, never read back,
  like app passwords), are read by the executor through the agent's own
  session, and the agent account is never shared with users: it belongs to
  the installation, not to a member. Everything members must be able to see
  — the association, the rules, the jobs, the decisions and the audit —
  lives in the **group's** account instead, because that is the account they
  can read.
- **Membership is presence; per-group rules and audit live in each group's
  own account** (its `gilbert/` app folder), following the group-ownership
  law and the ADR 0006 pattern (chat, `labels.json`): the agent is in a
  group exactly when the operator granted it — there is no second,
  in-product activation switch — and members see that the agent is active
  and what its
  automations do by construction, because group Files are already readable
  by members. Runtime scope is per changed account: the event's `accountId`
  selects which group's rules apply — the agent has no single global
  brief.
- **Admin surfaces.** The Gilbert admin (ADR 0007) gains an "Agents"
  section: register the agent principal with the installation (`gilbert@`),
  show which groups have granted it (and say so plainly when a group has
  not), author and version per-group rule documents, configure the model
  providers per tier, choose the tier each automation runs on, rotate app
  passwords, and see worker status and audit across groups. Membership is
  not written here: the grant happens in Stalwart's own administration, and
  the section **verifies** it per group — a group without the grant shows
  the consequence (no agent in its chat, no automations offered) instead of
  a control that cannot work. Agent identities are not a knob either: v1
  has one. Every write happens through the signed-in admin's session —
  impersonation where acting on the agent's account (`gilbert@`), the
  admin's own session on group documents. Writes into a group's own account
  (rules, labels, footer) carry ADR 0006's
  membership rule — an admin who is a member of that group — because
  Stalwart refuses to mint a session for an impersonated group mailbox: a
  non-member admin has no act-as-the-group path, so the surface says which
  membership a section needs instead of failing at the door. Nothing is
  configured by hand.
- **Members see, never change.** In a group's own view, next to the group
  chat (ADR 0006), an AI indicator opens the group's agent surface: which
  agents are active for the group, what instructions (rule documents) they
  carry, what they do and what they have done (the group's audit
  documents). Members read the group's own documents by construction and
  never edit them from the product — the folder is writable by a member by
  construction (that is how the chat works), so this is a UI convention and
  an accepted trust inside the group, not a server ACL; authoring and
  configuration stay in the admin UI; the
  one member actions are approving or rejecting a proposed action and
  addressing the agent (mention or reply), both through the group chat
  (resolutions 10 and 11).

**Resolutions of the recorded questions (owner decisions 2026-09-09):**

- *1 — app-password creation under impersonation*: **proven live on a real
  0.16.21 instance (2026-09-09)** — composite impersonation authentication
  (`{target}%{master}`, master credentials) opens a session as the target,
  and `x:AppPassword/set` create and destroy on the target's account are
  permitted under it; Stalwart's refusal rules cover *authenticating* with
  app passwords, not registry writes by an impersonating admin. The real
  server also returns the secret on `x:AppPassword/get` (the product API
  deliberately strips it), so an admin can recover a lost agent app
  password instead of only rotating it — the admin UI may offer either. The
  boot derivation above leans on both halves of that probe, with two
  follow-ups recorded in Open questions (an operator authenticated by app
  password, and the secret staying readable).
- *2 — automations, not rules*: an automation is built in the admin UI
  (never raw JSON) as "Quando [evento] / Se [filtri facoltativi] / Allora
  [azioni]" and stored as a JSON document validated against a standard
  JSON Schema — reusing standard primitives only: the JMAP filter grammar
  (RFC 8621) for matching and named capability-gated actions for effects.
  No new rule language; Sieve keeps the delivery-time boundary. Decisions
  are tiered so trivial work never pays for a model: T0 deterministic
  (zero tokens, fixed actions); T1 cheap classifier (small model, one
  structured-output call — category, then fixed per-category actions); T2
  agent (instruction, allowed capabilities, review policy — the model
  decides and executes). The tier is chosen per automation, with the group
  carrying a default; which model serves a tier is configuration, not code
  — the providers and their keys are documents in the agent's own account
  (v1 scope). Capabilities cover the whole JMAP surface the
  agent is granted — mail, files, tasks, calendars and contacts, read and
  write — each an audited action behind the ACL scope. High-impact actions
  (sending mail) are gated by the automation's review policy (resolution
  10); external sends keep a consent floor regardless of confidence.
  Sending on behalf of a group uses the **group's** footer and identity:
  the executor reads the group's own identities (JMAP `Identity` on the
  group account — `settings.json` is the app's settings document, not the
  identity), uses the group's default identity and applies its
  text/HTML signature exactly as the UI composer does — the From is the
  group, and the sent message lands in the group's Sent mailbox so members
  see what went out. **Proven live (2026-09-10, resolutions 12 and 14):**
  the group account carries its own identity for its own address, a
  member's rights on
  the group's mailboxes include `maySubmit` — the agent's own grant too — and
  a submission from the group account with that identity went out and filed
  itself in the group's Sent.
  The footer is that identity's signature. The concrete schema
  and editor are pinned when the first use case is implemented.
- *3 — rule granularity and context*: a rule acts on the single message;
  context is assembled on demand — the thread (grouped by In-Reply-To) and
  the group's mail folders — fetched narrowly when a rule needs them, never
  bulk-loaded.
- *4 — per-user gating*: out of scope for now; agents are group agents and
  nothing else.
- *5 — external agent fleets*: out of scope for now (future ADR; A2A stays
  the recorded candidate wire protocol).
- *6 — multi-Stalwart*: agent principals and documents are per cluster —
  the one gilbertserver runs against; if the cluster replicates, it does so
  on its own, outside this design.
- *7 — the model's role*: for v1 the LLM called by Gilbert is the primary
  decider and executor — Gilbert itself runs only deterministic,
  manual catalogue-style work, and most actions go through the model. The
  safety invariants hold: the model acts only through the same
  capability-gated actions, inside the agent's ACL scope, with every run
  audited; rules decide triggers, permissions and context, not every step.
  This reverses, for v1, the "deterministic routing first" field pattern
  (§7). Model routing and tiering: resolutions 2.
- *8 — workers are processes* (the owner delegated the call): a worker is a
  separate process of the same codebase — never a second gilbertserver — and
  when one no longer meets availability or throughput, another is declared
  at deployment (restart policy plus a health endpoint) and self-coordinates
  by lease (§2, §6): no in-product supervisor, no coordinator process. A
  supervisor is revisited only if operations asks for a single control
  point.
- *9 — the group attention convention*: agent work in a group's mail is
  tracked with **labels, not folders**: the reserved `G-` prefix marks
  Gilbert processing state on a message — `G-needattention` when the agent
  cannot process it confidently or a person must look at it, `G-processed`
  once handled, and the convention extends (`G-awaiting`, `G-rejected`, …)
  as use cases need. Labeling never moves the message. Moving is a
  separate, content-driven action: the message (with its thread as context)
  lands in the folder its classification chose. The labels come from the
  group machinery already in place (group label catalog, ADR 0006), and
  authorship follows ADR 0006's membership rule: an admin **who is a member
  of that group** authors the catalog through their own session, and the
  agent — a granted member, never an administrator — only applies and
  removes labels. The fixed `G-` set is created from the admin surface once
  the operator has granted the agent on the group — the surface verifies
  the grant first and says so when it is missing — and the admin adds one
  when a new automation needs it; the executor fails loudly when a rule names a `G-`
  label the group's catalog does not define, because a keyword outside the
  catalog is not rendered and a state nobody can see is a silent failure.
  Members read the state in the group's own mailbox by construction. State
  is per message in both storage and display: a reply arriving in an
  already-processed thread is a fresh event — it starts
  unlabelled and unread, is re-evaluated on its own, and never inherits the
  earlier message's `G-*` label or folder (the thread is context, not
  state). `G-*` labels are agent-owned and read-only to humans — a product
  convention rather than a server ACL, since a JMAP keyword is free-form and
  only the client's surfaces enforce the distinction: the UI renders them on
  the individual message, never aggregated onto the thread row, and keeps
  them out of the manual label picker; human labels keep their existing
  thread-scoped behaviour.
- *10 — review policy and human approval*: every automation carries a
  review policy — `always` (every run pauses), `threshold` (auto-execute
  when the decision's confidence is at or above the threshold, else pause)
  or `never` (always execute) — `threshold` is what a new automation starts
  at, its number is set per automation by the admin, and the external-send
  consent floor is never relaxed by it. T1 and T2 both return a
  confidence (0–1)
  with their decision; above the threshold the action runs unattended,
  below it the job pauses in `awaiting_approval` with a decision document.
  Approval is conversational: the executor posts the proposal to the group
  chat and the human answers in words (no Approve/Reject buttons); a
  pending outbound email is drafted in the group's Drafts mailbox (visible
  to members) and marked `G-awaiting`, the chat proposal references that
  draft, and only the approved draft is sent; alternatively the approver
  opens the draft in the group's Drafts and sends it directly, and the
  executor treats the draft leaving Drafts as the approval, closing the
  job — any member of the group may approve, not only an admin, and a
  member sending from the group account is exactly this path. Approval has
  one arbiter and no race: the job's decision document, patched with an
  expected-owner update, closes the job whichever way the approval arrived,
  and a draft that leaves Drafts before the conversational reply wins — its
  content as sent is what was approved, edits included, because a person
  sent it. T0 is deterministic and carries confidence 1, so a group that
  wants a person in the loop on a T0 automation chooses `always`, not a
  threshold. Gilbert's
  pending drafts are kept **unread** so a human sees them.
  The
  decision document in the group's own account records the outcome and
  resumes the job via push, and the admin "Approvals" queue surfaces the
  same pending decisions for oversight and as an escape hatch. The gate is
  deterministic where it matters: for reversible in-group actions the model
  may interpret the reply and ask a clarifying closed question when
  ambiguous; for irreversible or external actions (sending mail out of the
  group) the reply must resolve to an unambiguous yes/no and only explicit
  consent proceeds — never an LLM-guessed approval. Confidence is a model
  signal, not a guarantee: threshold auto-approval is an owner-accepted
  risk, and external sends keep a conservative default floor (consent
  required unless the owner explicitly raises it).
- *11 — chat is the human interface*: members and the agent talk in the
  group chat. Two ways to address the agent: an `@gilbert` mention, or a
  direct reply to a message the agent authored (a reply counts only when
  its direct parent is the agent's message — mention covers everything
  else). This is the executor's deterministic pre-filter, applied before
  any model call: a chat message that neither mentions the agent nor
  directly replies to an agent message is ignored. A mention is a general
  request with the group and chat as context; attaching a specific message
  or thread reference is deferred (too complex for the first chat build)
  and to be evaluated later. An agent appears in the chat as a participant
  at its own address exactly when it is granted on the group — membership is
  presence, and with several agents each is mentioned by its own address —
  and the client renders its messages and offers it in the `@` picker. The
  picker's second source is the group's own agent association: the client
  otherwise knows only the participants it has seen in the transcript, so a
  freshly granted agent that has never posted could not be mentioned at
  all. An agent's default context
  is bounded — the last 50 messages of the conversation (with their reply
  chain) — and it widens only when a human asks, step by step (whole
  conversation, then a folder) under a hard
  ceiling (300 messages / one folder slice); the agent never expands on its
  own, it only asks for more. Instructions come from the conversation;
  referenced mail, files and other content are data, never instructions
  (the capability allowlist and the review policy remain the final gate).
  The audit records who asked, so proactive automations and human requests
  stay distinguishable. Notifications and approvals also happen in the chat
  (resolution 10).
- *12 — the send path, live (2026-09-10)*: on the real 0.16.21 instance a
  group account carries its **own JMAP `Identity`** for its own address, a
  member's `myRights` on the group's mailboxes include `maySubmit`, and a
  submission from the group account with that identity (a draft in the
  group's Drafts, then `EmailSubmission/set` with `onSuccessUpdateEmail`
  into Sent) went out — `undoStatus: pending` — and filed itself in the
  group's Sent mailbox. So the group sends **as itself**: From is the group,
  the sent copy is the group's, and one agent serving several groups sends
  each group's own identity and footer. A sendAs identity for the group
  address also exists on a member's own account; v1 does not use it, because
  it would file the sent copy in the member's Sent instead of the group's.
  **Correction for the record:** on 0.16 `Identity` does not return
  `maySubmit` at all — the signal is the mailbox `myRights` — so neither the
  client types nor the mock should invent that field.
- *13 — the footer, and the shape of a real group (2026-09-10)*: the footer
  is the group identity's `textSignature`/`htmlSignature`, read with
  `Identity/get` on the group account and applied exactly as the composer
  applies a signature; an admin who is a member edits it like any signature,
  and members read it as they read the label catalog. The same probe saw the
  live shape: the group identity's signatures are empty today, and the
  group's `gilbert/` app folder holds `chat/`, `chat-state/` and
  `labels.json` — **no `settings.json`**, so nothing new has to be invented
  for the footer. It also saw the working material: `labels.json` already
  carries a first label, the chat folder holds a message and a per-member
  read-state file, and Files are full of real operational matter — which is
  why the destination of extracted attachments is recorded as an open item
  instead of being assumed.

- *14 — the agent principal, live (2026-09-10)*: `gilbert@` exists on the
  real instance and is granted on a real group. Its app password was created
  **from the admin session under impersonation** (`x:AppPassword/set` on the
  target's account) because Stalwart's own administration cannot set one —
  the exact path resolution 1 records, exercised in production rather than
  in test. The agent then authenticates with that app password **directly,
  with no impersonation at boot** (v1 scope), its session shows the group
  account, its `myRights` on the group's mailboxes include `maySubmit`, and
  it both reads and creates nodes in the group's own `gilbert/` app folder —
  so rules, jobs, audit and decisions have a writable home. A submission
  from that session, with the group's own identity, reached its destination:
  the submission came back `undoStatus: final` with
  `smtpReply: "250 2.1.5 Queued"`, and the message filed itself in the
  group's Sent. The send path is therefore verified for the principal the
  design actually uses, not only for a member; delivery to an inbox (as
  opposed to acceptance by the receiving MTA) is not something this side can
  prove. The bootstrap secret lives in the deployment environment — this
  record keeps the mechanism, never the credential.

- *15 — where extracted files land (owner decision 2026-09-10)*: in the
  **group's own Files, in the visible tree** — the folder the automation names
  (`mail.extract`'s own `folder`), or the folder the model chose when the tier
  lets it decide, and the `Needs attention` folder when nothing determined one.
  Never the hidden `gilbert` app folder, where a member would not find it, and
  never loose in the Files root, where a file nobody could place would be a
  shrug rather than a signal. The automation's own parameter stays the common
  case; the model's choice and the fallback are what keep a rule from having to
  predict every shape of incoming mail.

- *16 — the rule document is validated by its published schema (owner decision
  2026-09-10)*: the automations are authored **in the admin form, never as raw
  JSON**, and the document the form produces is validated against the JSON
  Schema the server publishes, with `@cfworker/json-schema` (MIT, no runtime
  code generation, so the same validator runs in the browser bundle under the
  CSP and on the server). The schema is derived from the same constants the
  runtime reads; the checks a document cannot state — that a rule's actions are
  inside its capability allowlist, and that a `G-` label a rule names exists in
  that group's catalog — stay in code, and both reach the author as one list.

- *17 — the group's standing instruction (owner decision 2026-09-10)*: a group
  keeps one document — the shape of an `AGENTS.md` — that its agent carries into
  the system slot of **every** model call, before the automation's own
  instruction and before the data it is looking at. It lives in the group's own
  app folder (`agent/instruction.json`), and an **administrator of the group**
  writes it, in the admin surface, beside the rules: a text the model is told to
  follow is configuration, and members read the rules rather than write them.
  It can steer and cannot grant — what an automation may do is its capability
  allowlist, checked on every answer, so the instruction cannot widen a rule,
  and the prompt says so in the sentence under the field and in the block itself.
  The owner's answer to the question this review raised, chosen over the
  member-authored variant precisely because authorship should not be the limit:
  the limit is the allowlist and the consent floor.

- *18 — the reliability decisions of the first branch review (owner decision
  2026-09-10, all as recommended)*. These are the failure paths a crash, two
  workers, or a model choosing a name can reach, and every one of them is
  settled here:

  - **The claim's compare-and-set token is read before the claim document**
    (`lease.ts`). Read the other way round, a claim written by another worker
    between the two reads is invisible to the comparison — the token already
    reflects it — and both workers walk away believing they hold the unit.
  - **Claims carry an epoch**, incremented on takeover and never on renewal, and
    a run asks `claimStillMine` before anything leaves the process: sending,
    posting, filing. A worker whose lease lapsed stops instead of writing
    results the worker that replaced it will write again. The check belongs to
    a run that was handed a claim: the fence is skipped where none travels
    with the job, and the pending sweep that takes up a dead worker's work
    (`runPending`) and the two schedule paths start their runs without one —
    the paths where a lapsed lease is likeliest. **Owed:** every path that runs
    a job to an effect hands it the claim its worker holds, so the fence
    refuses rather than being absent where it matters most.
  - **A release is conditional** on the state it was read against. The owner
    check alone could remove a *live* claim: between the read and the removal
    the lease can lapse, a successor takes the unit, and the removal deletes the
    successor's claim.
  - **An unreadable heartbeat is not a free lease.** It throws, because
    "unknown" and "expired" are different answers — and the throw is not yet
    contained: `leaseExpired` is called from the worker's pass outside any
    handler, and the loop above it swallows what it meets instead of reporting
    it. One unreadable claim document therefore ends the round for every
    account behind it, without a line in the log. **Owed:** the pass reports
    what it caught, per account, and goes on to the next one.
  - **The audit is never written over.** Missing is an empty month; there-but-
    unreadable is loud, and a person decides. An append must not be able to
    replace a month of the trail with one entry.
  - **Intent before effect.** The trail records what is about to run before it
    runs, so an effect can never exist without a line that accounts for it.
    One path departs from it: `settleSentDraft` runs the actions left beside
    the send before it records their line, so a crash between the two leaves an
    effect the trail does not account for. **Owed:** that path records the
    intent first, as the others do.
  - **An approval is consumed once.** `appliedAt` is written in the same
    conditional write that moves a decision out of `pending`, before the
    effects, so two answers arriving together cannot send the same mail twice.
  - **One job's failure is that job's**: the pending sweep continues past a job
    whose failure handling itself failed.
  - **The draft that left Drafts is looked at before the chat is read**, so a
    member who sent the draft and then wrote "sì" is settled by what they did.
  - **An extracted file never replaces one a person filed**: the run writes
    `2-name`, `3-name` beside it and reports the name it used.
  - **The hidden app folder is refused as a destination by name** — both names
    it can go by — and it is identified by a **marker** rather than by its name,
    so a folder a member created and called `gilbert` is theirs and is never
    adopted, and a model that names it writes nothing into it.
  - **A filter is validated on names and on types**, in one list with the other
    cross-field rules: a key beside `operator` is refused rather than silently
    ignored, and a value the matcher could never match (`minSize: "1000"`) is
    refused rather than accepted as an automation that looks armed and does
    nothing. The form offers every key the matcher implements, and the three
    operators. That list (`filterProblems`) is the authoring door: a run meets
    the rule again with the narrower check that asks only whether the matcher
    knows the keys, and a rule that reached storage by another road — a
    document written by hand, an older form — is matched with whatever it
    says. **Owed:** a run asks the same list the form asks, so an automation
    that would be refused when it is written is refused when it runs.
  - **A degenerate cadence is refused**, and the schedule's delay is floored, so
    a past instant cannot re-fire in a tight loop.
  - **The chat context is bounded by the bound a human set.** The window takes
    the bound first (`before.slice(-ceiling)`), so on any thread longer than the
    bound the reply chain has nothing left to occupy and contributes nothing:
    the message being answered is the one ancestor that survives, named by id
    and put back with the window giving way instead. Resolution 11's "the last
    50 messages (with their reply chain)" therefore reads as the bound the
    whole context stays inside — never past it — because "the agent widens its
    own context for nobody" is the invariant, and a long thread is exactly where
    it would have been broken. A transcript that does not hold the named
    message is an error rather than a different conversation answered quietly.
    **Owed:** the chain is read inside the bound as Resolution 11 reads it —
    the ancestors first, the window taking what is left — so that a long thread
    is not the case where the chain is always empty.
  - **The member's surface never impersonates.** A name that is not in the
    member's own session is not a group this person may act as, and the answer
    is reached without asking the mail server for anything — Stalwart's refusal
    stops being the only thing standing between a signed-in user and another
    group's documents.
  - **An irreversible action always asks a person**, whatever the rule's mode
    and whatever `allowExternal` says. Today sending is the only external action
    and also the only irreversible one, so the two coincide; the flags stay
    separate so they cannot drift into an irreversible effect nobody was asked
    about.

- *19 — the live probe of conditional writes: owed, and recorded as owed (owner
  decision 2026-09-10)*. Everything the fleet's coordination rests on assumes
  that Stalwart 0.16 honours `ifInState` on `FileNode/set`: that the mismatch
  arrives as `stateMismatch`, that it is not masked as `invalidArguments`, that
  the FileNode state token advances on the writes that matter, and whether a
  blob upload (which writes no node) advances it at all. The mock simulates all
  of it; no live instance has been asked. **The probe is owed before the fleet
  depends on lease and job coordination in production**, and the code carries
  the same note where the assumption lives (`server/src/mock/index.ts`, beside
  the simulated check). Until it is run, the tests prove the client's logic
  against the simulation, not the server's behaviour.

- *20 — the reliability decisions of the second branch review (owner decision
  2026-09-10)*. The second review of the branch found the failure paths that
  remain once a worker, a retry and a reader each behave badly at once: a run
  whose process is gone, a retry that would repeat an effect, a claim written
  back from nothing, an audit entry that never lands, a document that is there
  but unreadable, a filter that is not one, a credential that outlives the
  surface that promises otherwise, and one answer shape declared twice. Each
  is settled here:

  - **A job left `running` is not left to nobody.** `runPending` takes up a
    `running` job whose lease has expired, so the work a dead worker was
    holding is finished by the next pass — and, with the deduplication key
    suppressing every new job on the same trigger, a job nothing picks up
    again is that trigger's work never happening at all. A run whose lease
    expires and that no worker comes back for ends with the audit outcome
    **`timeout`**, not `failed`: it is an outcome of its own, because nothing
    reported a failure — the process that would have reported it is the one
    that is gone.
  - **Effects are recorded, and a retry resumes instead of repeating.** A
    run's plan is written onto the job **before** the first effect, and a
    retry reuses it rather than asking the model again: re-planning would run
    a plan nobody approved, and the record of what already landed would stop
    meaning anything. The job carries `applied[]`, the actions that landed in
    order, and the next pass starts after them. A job whose plan reaches
    outside the group's own state — it sends, or it writes where people look —
    is **not retried at all**, because repeating it is either a second message
    or an effect nobody can take back; it is dead-lettered. Between one attempt
    and the next sits an explicit backoff (`nextAttemptAt`), because three
    attempts taken back to back are one attempt against a provider that is
    down. What "reaches outside" means is the `irreversible` flag on the
    action's spec, and only `mail.send` carries it: an extraction that fails on
    its second attachment is retried, and the attachment it already filed is
    filed again beside itself. **Owed:** every action that writes where people
    look — `mail.extract`, `file.write` — carries the effect it has, so a retry
    of it is dead-lettered rather than repeated.
  - **A released claim stays released.** `saveClaimStates` never recreates a
    claim that is no longer there: the anchor is written against the document
    it read, so a state saved after the unit was given up cannot put the unit
    back into service. `claimArea` says **why** it refused — held under a live
    lease, lost the compare-and-set — instead of returning one `null` for
    every reason, because a caller that cannot tell "somebody else holds it"
    from "I lost a race" can report neither.
  - **An audit entry that does not land is retried, then carried.** The append
    retries its conditional write with backoff and jitter, and an entry that
    still does not pass is queued rather than lost — the queue is drained by
    the account's next append, so a group that writes nothing again carries it
    until it does. **Owed:** the pass drains it, as the queue's own note
    promises, so a group gone quiet does not carry an entry indefinitely. Two
    limits are accepted and declared rather than hidden: the
    granularity stays **monthly** — one document per month, so the blob every
    append reloads grows with the month and the window in which two writers
    contend grows with it — and the carry-over queue is **in memory**, so a
    restart of the process loses it.
  - **A document that is there but unreadable is not a document that is
    absent.** The audit refuses to read one as an empty month: missing is an
    empty month, there-but-unreadable is loud and a person decides. It is the
    answer the write already gives.
  - **An empty `operator` group is not a filter.** A group with no conditions
    is refused: `AND` over nothing is true, `OR` over nothing is false and
    `NOT` over nothing matches every message in the account, so a rule written
    that way is armed and does something nobody wrote. The refusal is the
    authoring door's; the run-time check does not ask it yet (see the filter
    bullet above).
  - **Rotating the agent's app password leaves the previous credentials valid,
    and says how many.** The rotation keeps what is already in use working on
    purpose — a revocation would stop the agent's work the moment it was made —
    and the API reports how many it left valid (`alsoValid`), so the surface
    states the window instead of promising a revocation it does not perform.
    The count is computed from a re-read of the account's state, and a failed
    read answers `0`: a precise number where the truth is "unknown", and the
    surface falls silent because it has nothing above zero to say. **Owed:**
    the answer tells the two apart, and the surface states the window it could
    not count.
  - **The agent API's response shapes have one definition.**
    `server/src/agent/views.ts` declares them, and both the routes that build
    the answers and the client that reads them import it. Declared twice, a
    field added on one side and forgotten on the other compiles on both tiers
    and arrives as `undefined` on one.

- *21 — the third branch review: the paths the record had only promised
  (proposed 2026-09-10, awaiting the owner's acceptance)*. The third review of
  the branch asked the questions this record leaves open: three of them are
  answered today by the code's default rather than by a decision, and one only
  by a general sentence about auto-approval. Unlike the resolutions above,
  these are proposals: the owner has not accepted them, and the tree does not
  carry them yet.

  - **The version pin binds a run resumed from an approval.** A job stopped in
    `awaiting_approval` is in flight: a person is holding it, and the rule it
    was created from can be edited while they hold it. §4's invariant — a job
    never runs a version nobody approved — is read to reach that run as well,
    so an approval answered on a job whose pinned version has moved on is the
    same mismatch as any other, dead-lettered with a `failed`.
  - **Withdrawing a group's grant is administration, and it is not a stop
    button.** The agent reads its reach from its own session and from the
    group's documents, so an operator who withdraws the grant removes the
    session, and with it the ability to start or finish work there — but
    nothing enumerates, cancels or drains what was already in flight: a
    decision waiting on a person, a job holding a lease, a draft the agent left
    in the group's Drafts marked `G-awaiting`. The decision is that the
    withdrawal is the operator's and is taken once the work it would strand is
    settled, with what was left unfinished visible in the audit and on the
    group's surface instead of disappearing with the grant. **Owed:** a
    withdrawn grant is reported together with the work it leaves behind, and
    the agent stops claiming that account rather than failing against it on
    every pass.
  - **No order exists between automations that match the same message.** Two
    rules that fire on one arrival are two jobs on two triggers: work is
    claimed by account and area, and which of them runs first is not decided,
    not written down, and not to be relied on. Each automation is therefore
    written to hold whatever order it gets — a rule that moves a message and a
    rule that reads it are independent by construction — and the audit names
    the rule and its version per run, so the order is reconstructible
    afterwards even though it was never chosen. **Owed:** a declared order is a
    v1 gap rather than a guarantee, and the surface should say so where rules
    are written.
  - **The content a rule reads can carry an instruction, and the allowlist is
    the gate.** Mail, files and everything else the agent reads are data:
    nothing in them is followed as instruction, and the capability allowlist
    with the review policy is what actually bounds an action. The consent floor
    holds unrelaxed for anything that leaves the group. For an action that
    stays inside it and runs on a T2 confidence threshold, that confidence is
    the model's own signal about content the same model read, so a hostile
    message can move it; that is an accepted risk, named here rather than left
    to the general sentence about auto-approval. The mitigation it would take —
    a person for any action whose trigger arrived from outside the group — is
    not adopted in v1.

**Operating decisions (owner decisions 2026-09-10):**

- *Failure is loud.* A provider that is unreachable, a refused or expired
  key, or a malformed model answer never skips work silently: the job
  records the failure in the audit, the run lands in `G-needattention`, and
  the group chat is told which automation could not finish.
- *Notifications are chat-only in v1*: the group chat is where a pending
  approval, a failure and a finished run surface. Mail notification is a
  later extension of the same audit, never a second channel to keep in
  sync.
- *Audit retention is declared*: one audit document per month per group,
  kept 12 months, so growth in Stalwart is bounded by policy and not by disk.
  **Owed:** the export offered before the oldest month is pruned does not
  exist yet — the trail is readable as the group's own Files in the meantime —
  and the retention is a policy rather than a deletion only once it does.
- *Probes run against the owner's test instance on credentials the owner
  supplies*; results are recorded as resolutions 12 to 14, and the
  operator-credential alternative carries two more (Open questions, probes
  c and d).

## Decision

### 1. An agent is a principal with its own address

Every agent is a mailbox in Stalwart's directory with its own address (e.g.
`gilbert@…`), created and granted by the operator in Stalwart's own
administration — the same surface that creates accounts.
The address is the agent's identity and its scope unit. The agent's ACL
grants decide what it may read and act on (a person's mailbox, a group's
mailbox, shared Files). Mail addressed *to* the agent is ordinary mail: it
lands in the agent's own mailbox and wakes it like any other state change —
that is how "tell the agent to do something by mailing it" works. The
agent's own app password is the one bootstrap secret the worker holds, and
it belongs to the installation, not to a person (v1 scope).

### 2. Workers are headless, stateless, disposable processes

> v1: the worker is a separate process beside gilbertserver, and the areas
> it serves are the deployment's knob (v1 scope); this section describes the
> same machinery at fleet scale.

A worker is a dedicated entrypoint in this repository (Node, same JMAP
client library family as the web client but headless) that authenticates to
Stalwart as exactly one agent principal and runs that agent's rules. It
keeps no local state and needs no volume; any number of workers may run
from the same image, and each worker of an area is interchangeable. The
"fleet" is agents × workers: more agents, more principals; more throughput
or availability, more workers on an area. v1 fixes the first factor at one
and exposes the second as workers per area (v1 scope).

### 3. Event push is the wake-up; reconciliation is the work

The worker holds its principal's JMAP EventSource (state-change push, type
filter). An event — "account X, type Y changed" — is a *signal to
reconcile*, never a payload to trust: the worker re-reads the changed type
narrowly via JMAP (from the last state it recorded), runs the agent's rules
against durable state, and writes results back via JMAP. Handlers are
idempotent by construction because they recompute from state: duplicates and
reconnects (at-least-once delivery) are harmless, and nothing that leaves no
durable trace can be acted on. This is the same contract the web client
already lives by, minus the browser.

### 4. Rules and durable state are Stalwart documents

- **Rules** ("what this agent does": move group messages, extract files,
  the open set to come) are validated documents in the agent principal's
  Files, not code or environment — for v1, per-group rules live in each
  group's own account instead (v1 scope). The worker is a generic interpreter plus a
  library of capability-gated actions; adding an agent behaviour means adding
  an action the interpreter can run, and shipping a rule is writing a
  document.
- **Work state** lives in the principal's Files — for v1, per group, in the
  group's own account (v1 scope): job/outbox documents with a lifecycle
  `pending → running → awaiting_approval → done/failed`; leases as
  owner + heartbeat on the documents being worked, re-claimed when stale (the
  expected-owner patch is the CAS substitute); per-job retries with backoff;
  dead-letter after N attempts. A job records the rule `id` and `version` it
  was created from, and a run whose pinned version is no longer the rule's
  current one does not start: it is dead-lettered with a `failed`, because a
  job never runs a version nobody approved (§7) — the executor refuses the
  mismatch and says so in the trail. Editing a rule therefore costs the work
  in flight on it, a corrected typo included, and nothing replays that work,
  because the job carries the version *number* and not the body of the rule.
  That is the trade: a job lost loudly, against an effect run under a version
  nobody approved. A job stopped in `awaiting_approval` waits on a person and
  is resumable after any worker restart: its state is the document. The pin
  binds every run that has effects, and a run resumed from an approval is one:
  waiting on a person does not freeze the rule the job was created from, so an
  approval answered on a job whose rule has moved on is that same mismatch and
  not a fourth outcome. **Owed:** the check sits on the approval path
  (`resolveApproval`, `settleSentDraft`) as well as on the pending and running
  one, which is the only place it is today.
- **Audit trail**: every run appends one entry to an audit-log document
  (input state, rule id and version, actions taken, outcome), so what an
  agent did — and under which rule version — is answerable from Stalwart
  alone. In v1 the log is per group, in the group's own account, one
  document per month, with a declared retention (v1 scope); the export owed
  before the first prune is recorded with the retention itself, and until it
  exists the trail is read as the group's own Files.
- Nothing durable lives on the worker or in the environment; the environment
  carries only the bootstrap secrets toward Stalwart.

### 5. Time-based triggers ride the same machinery

The worker also wakes on a schedule, without cron and without trusting any
particular container to live: a scheduler document (`next-runs`, in the
principal's Files — per group in v1, beside the rules it schedules, v1
scope) holds the agent's due times as UTC instants; the worker holding the
nearest lease arms a timer for it and updates the document when it fires or
when the work changes the schedule. Durable next-run times plus a lease are
what let a replacement worker pick the schedule up from Stalwart after any
crash, which is why the times live in the document rather than in a cron
entry. Two gaps stand between the document and that promise: an armed timer
is not re-armed once it has fired, so an entry runs once in the life of the
process and waits for the next boot; and the catch-up that reads the due
entries back out of the document (`fireDueSchedule`) is reached only by a
reconciliation of type `schedule`, which no pass asks for. **Owed:** a fired
entry arms its next occurrence, and the due entries are read on every pass,
so a schedule survives a crash and an ordinary week alike.

### 6. Fleet coordination is lease-based and coordinator-free

Each worker claims the scopes it will serve (the principal's stream, and
per-account work units) by writing owner + heartbeat into the appropriate
Stalwart document; a claim whose heartbeat is stale is re-claimed by any
worker. The one worker that wins a principal's stream claim keeps that
principal's EventSource open; the others stay idle for that principal, so
idle cost is bounded and there is no split-brain: two workers never both
hold the same claim. No coordinator, no shared volume, no database — the
documents are the coordination.

### 7. Patterns from the field, and what is deliberately not adopted

A survey of established, actively maintained orchestration repositories
(2026-09-06; sources in References) splits the field into durable execution
engines (Temporal; Conductor — ex-Netflix, Apache-2.0; Inngest — SSPL;
Hatchet — MIT), agent frameworks (LangGraph — MIT; Microsoft Agent
Framework, successor of the maintenance-mode AutoGen; CrewAI; OpenAI Agents
SDK) and end-to-end platforms (n8n — fair-code). All of them run on
infrastructure this repo's law forbids — their own queue, database and
volume — so Gilbert adopts patterns, never dependencies or engines.

What the survey locks in:

- **Lease + heartbeat on work documents is the queue-visibility primitive**
  of the field (Temporal task queues, SQS-style visibility timeouts):
  Decision §6 is on the established path, not an invention.
- **Per-job retries with backoff, timeouts, compensation and a dead letter**
  after N attempts (Conductor's per-task model), as in §4.
- **Human-in-the-loop as an interrupt**: a job stops in `awaiting_approval`;
  the group is asked in its own chat (resolution 10) and the worker resumes
  only on an approved state change — the analogue of LangGraph's
  interrupts.
- **Rules are versioned, and a job names the version it was created from**
  (Conductor's versioned definitions, the same concern read the other way).
  A pinned version that is no longer the rule's current one is refused rather
  than run — the job is dead-lettered with a `failed` — because the job
  carries the version *number* and not the rule, and an effect under a version
  nobody approved is worse than a job lost loudly. The refusal is read on the
  pending and running paths, and a job waiting on a person is not a third
  case: it is read again when the run resumes (§4, resolution 21). **Owed:**
  the same check on the approval path, so the sentence holds wherever a run
  starts from. There is no replay-compatibility problem because this design
  never replays.
- **Audit is an append-only per-run event log** (LangSmith/Conductor-style
  observability), stored as a Stalwart document — §4.
- **Deterministic routing first, a model only where needed** (Inngest
  agent-kit's phrasing): rule documents decide the common path; an LLM, when
  it arrives, is a capability-gated *action*, never the interpreter. For v1
  the owner reverses this for the agent's decision layer (v1 scope,
  resolutions).
- **Delegation by handoff**: an orchestrating agent may compose specialist
  agents (CrewAI's manager, OpenAI's handoffs, Microsoft's agents-as-tools)
  — which, with one address per agent (Decision §1), is native: an agent
  mails the specialist.
- **A per-account concurrency cap**, so one burst on a group mailbox cannot
  thundering-herd the fleet (Hatchet's fairness concern); the claim unit is
  `account × area` (v1 scope).
- **Dead letters surface where the work is** — the group's chat and audit,
  and the admin surface's queue: v1's notification channel is the chat
  (operating decisions), so a dead letter is not a second inbox to watch.

Deliberately not adopted: deterministic replay (Temporal) — reconciliation
from durable state is the simpler idempotency contract (§3); a workflow DSL
or visual canvas (Conductor, n8n) — rules are documents in v1; external
runtime engines — a dependency that would import a queue/database and
licence constraints (SSPL, fair-code) into a JMAP-only product.

**Re-surveyed 2026-09-09 (sources in References).** The 2026 field draws a
hard line: *checkpointing is not durable execution*. Agent frameworks —
LangGraph, CrewAI, Google ADK (GA 2026), Microsoft Agent Framework (1.0 GA
April 2026, the merged successor of AutoGen and Semantic Kernel), Strands,
Dapr Agents (GA March 2026, NVIDIA-built, the runtime owning the workflow
lifecycle) — persist state but do not detect failure, restart or
deduplicate on their own; durable runtimes (Temporal, Restate, Inngest,
DBOS, Dapr Workflows) do. That line validates this record's side of the
contract — reconciliation from durable state, leases for takeover — and
names the piece it leaves to deployment: detecting a dead worker and
restarting it (Open questions). The Postgres-based entrants (DBOS; Kitaru
and Absurd) run durable execution and "compute that can disappear while
waiting" on an ordinary row store, confirming that a document store is a
valid engine substrate — here, Stalwart Files with lease documents as the
queue, scheduler and coordination layer. Standards are settling around the
two seams this record keeps open: A2A (agent-to-agent) moved to the Agentic
AI Foundation in August 2026 alongside MCP (model-to-tool); Gilbert's future
external-fleet boundary should speak A2A, and a future LLM action should be
exposed over MCP — neither in v1. Finally, mailbox-as-interface is a live
product pattern: AgentMail ("Gmail for agents", 2026) gives agents their
own inboxes, instructions by ordinary mail and thread-grouped conversation,
independently confirming Decision §1; thread-as-conversation-unit is a
candidate rule semantic (Open questions).

## Consequences

- The agent's own app password is the one bootstrap secret the worker holds,
  and it belongs to the installation rather than to a person (v1 scope); on
  top of ADR 0007's administration model (permission marker; Impersonate for
  per-user writes), the only impersonation in the design points the other
  way — an admin acting on the agent's account.
- One agent means one reach: `gilbert@`'s grants cover every group it is
  granted, so a compromise of the agent exposes all of them at once, not one
  group at a time. Accepted for v1 — the same order of risk the threshold
  auto-approval already accepts — with per-area or per-group agent
  principals as the future mitigation, not a v1 setting.
- Work claims are per `account × area`, so two workers never touch the same
  area of one account at once; the per-account cap of §7 bounds how much of
  a single group the fleet works on. With the default single worker, work
  per account is serialized in arrival order.
- An agent's scope is exactly its grants: it sees and acts on what the
  operator granted, nothing else; a new account is served by granting the
  agent in Stalwart's own administration, the same way admin membership is
  granted in ADR 0007. Grant management stays there (Management API
  territory, not JMAP — deliberately out of scope); the admin surface reads
  the grants and reports them, it never writes them.
- Every event costs a reconcile: rules must be written as narrow queries
  (per type, from the recorded state), and the push filter must stay tight,
  or the worker spends its life re-reading mailboxes nothing changed in.
- Time triggers require at least one worker per scheduled agent to be up;
  the scheduler document is the source of truth, so a dead container costs
  only the lease interval, and a replacement takes over from Stalwart.
- Reconcile-only semantics means reactions are possible only to changes that
  leave durable state; anything ephemeral (a connection event, a transient
  condition) is out of scope by construction.
- The mock must simulate both state-change push and clock triggers, so agent
  behaviour is testable in the existing CI gate (web and server tests run
  under `TZ=UTC` as today).
- A job stopped in `awaiting_approval` may wait indefinitely on a person;
  it must survive any worker restart (its state is the document) and must
  never be re-claimed as stale while it is legitimately paused.
- Rule documents carry an `id` and `version`; the audit log records which
  version each run used, and editing a rule ends the runs pinned to the older
  version, which are dead-lettered (§4, §7) — including a job stopped in
  `awaiting_approval`, whose pin is read when the run resumes. A rule edit is
  therefore also a decision about the work already in flight on that rule.
- Agent work can be slow by design: a reconcile may call an external model
  or wait on a person, so leases and heartbeat intervals must tolerate
  pauses far longer than the request/response web tier's.
- The worker's lifecycle is the agent's: a deploy or a crash pauses agent
  work for the downtime window, and recovery is automatic — session
  re-derived at boot, stale leases re-claimed, catch-up and reconciliation
  from the recorded state. Nothing hangs on a dead process because the
  state is the documents — and a web deploy is no longer an agent outage.

## Alternatives considered

- **A queue/database of the workers' own (Redis, Postgres, a volume
  outbox)**: rejected — architecture law: everything durable lives in
  Stalwart. The job documents and leases above are the queue.
- **One shared service account serving every agent**: rejected — a shared
  principal cannot be granted per agent, cannot audit per agent, and has no
  per-agent address to be mailed to. Per-agent mailboxes are the scope and
  identity unit.
- **Workers embedded in the web server container**: rejected — it mixes the
  disposable, request-scoped web tier with long-lived claim-holding
  processes and scales them together. v1 keeps the rejection: the worker is
  its own process (v1 scope).
- **Cron inside the container**: rejected — disposable containers offer no
  durability or overlap guarantees; the scheduler document does.
- **Polling as the primary trigger**: rejected; kept only as the recovery
  fallback after a lost or missed push.
- **Webhooks out of Stalwart**: not available — Stalwart's own event surface
  is JMAP push, and that is what this design consumes.

## Open questions (recorded; the v1-scope section and the resolutions above record what is decided)

- Pending probes for the operator-credential alternative (v1 scope): (c)
  that an operator authenticated by **app password** — not by the account
  password the 2026-09-09 probe used — may impersonate a target, and (d)
  that `x:AppPassword/get` keeps returning the secret to an impersonating
  admin. Neither is on the default boot path — the agent's own app password
  is — so they matter only if an installation chooses that alternative.
- The extraction destination is decided (resolution 15): the group's own
  visible Files, in the folder the automation named or the model chose, and the
  needs-attention folder when nothing determined one.
- A group's own standing instruction is decided (resolution 17): one document
  per group, written by an administrator of that group, handed to the model
  first on every call.

## References

- README.md — "AI agents that act inside mail and file storage, for a
  person or a group — Gilbert's own agents now, external agent fleets later"
- ADR 0001 — group grants, everything-durable-in-Stalwart, session-account
  mechanism, admin-group secret pattern (superseded by ADR 0007; cited as
  the historical record, not as the current administration model)
- `server/src/app.ts` — `/api/events` push relay (existing event surface)
- `server/src/push.ts` — the inbound push rail (RFC 8620 PushSubscription)
  the executor's wake-ups ride
- `web/src/jmap/push.ts` — state-change push semantics as the web client
  lives them
- Stalwart Sieve — the delivery-time boundary, confirmed out of the workers'
  scope
- Surveyed repositories (patterns, never infrastructure), 2026-09-06:
  https://github.com/temporalio/temporal — durable workflow service (event
  history + deterministic replay; the rejected replay model)
  https://github.com/conductor-oss/conductor — declarative durable
  workflows; per-task retries/timeouts/compensation; versioned definitions,
  no replay
  https://github.com/inngest/inngest — durable step functions replacing
  queues, state and scheduling
  https://github.com/hatchet-dev/hatchet — orchestration engine for
  background tasks, AI agents and durable workflows
  https://github.com/langchain-ai/langgraph — durable execution,
  human-in-the-loop interrupts, memory
  https://github.com/crewAIInc/crewAI — crews/flows; sequential and
  hierarchical (manager) processes
  https://github.com/openai/openai-agents-python — agents, handoffs,
  guardrails, tracing
  https://github.com/microsoft/agent-framework — production agent
  framework; successor of microsoft/autogen (maintenance mode); 1.0 GA
  April 2026
  https://github.com/n8n-io/n8n — workflow automation platform (fair-code;
  queue/database-backed — the rejected shape for Gilbert)
  Re-survey 2026-09-09:
  https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake — checkpointing is not durable execution
  https://www.diagrid.io/infrastructure/10-best-temporal-alternatives-2026 — durable-execution alternatives compared
  https://www.zenml.io/blog/where-durable-execution-is-headed — Postgres checkpoint recovery; Kitaru and Absurd
  https://vercel.com/i/ai-agent-frameworks — choosing agent frameworks in 2026
  https://www.axios.com/2026/08/17/a2a-agentic-ai-foundation-open-ai-standards — A2A moves to the Agentic AI Foundation (August 2026)
  https://www.ycombinator.com/launches/NvQ-agentmail-the-api-first-email-provider-for-ai-agents — AgentMail: agents with their own inboxes
  https://docs.agentmail.to — AgentMail docs (agent onboarding, threads)
  ADR 0007 — Stalwart admin is the Gilbert admin (the current administration
  model; supersedes ADR 0001's grant)
