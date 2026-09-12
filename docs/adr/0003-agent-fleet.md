# ADR 0003 — Agent fleet: agents that act on Stalwart events and schedules

Status: Proposed (2026-09-11; rewritten 2026-09-12). The automation model this
record decides is superseded by ADR 0010, which is Proposed; the fleet this
record decides stands.

> **Scope (owner decision 2026-09-06):** Gilbert's own agents — each with its
> own address in Stalwart (e.g. `gilbert@…`) — acting on Stalwart events and
> on time schedules. First use cases: moving group messages, extracting files
> from incoming mail, and an open rule set to grow from there. Sieve owns
> delivery-time actions inside Stalwart; agents act afterwards, on delivered,
> durable state.

## Context

This record is about **gilbertagents**, one of the four blocks `README.md`
names.

Gilbert's direction is a lifecycle butler whose agents act inside mail and
file storage for a person or a group. Nothing runs outside the web request
path: the only live connection is each signed-in browser's push stream,
proxied by the Node server, and nothing in the product reacts to a mailbox
changing unless a user is looking at it.

Facts from the current machinery:

- Stalwart exposes no general application webhook bus. The client-visible
  event surface is JMAP state-change push
  (`urn:ietf:params:jmap:push:state`) over the account's EventSource: it says
  *which account* and *which type* changed, never *what* changed.
- The server already relays that stream to browsers (`/api/events` in
  `server/src/app.ts`, type filter, ping), and the web client treats each
  event as a refresh trigger per type (`web/src/jmap/push.ts`). Agents are
  headless: no proxy, no browser — a direct JMAP session to Stalwart, using
  the same EventSource protocol.
- A principal's JMAP session includes every account it is granted over, so one
  agent principal receives one multiplexed push stream for all the accounts it
  may see, keyed by `accountId`. That list is reach, not a role: admin is a
  permission marker on the account's own capability list (ADR 0001), not a
  group grant.
- Sieve scripts run at delivery time inside Stalwart itself. They are the
  delivery-time mechanism and stay that way; they are not a general executor
  for JMAP-level, application actions (move across shared mailboxes, file
  extraction, richer rules).
- JMAP has no compare-and-set. Concurrency primitives must be built from owned
  documents and conditional patches (expected-owner update), exactly as the
  account-owned policy documents are.
- Architecture law: everything durable lives in Stalwart — no own database, no
  writable volume; the container is disposable. New identifiers are named
  `gilbert`.

## Scope in force

One self-hosted installation runs **one agent**. What is multiple is its
**agents**: the Master works in every group it is granted, and a deployment
declares how many agents run. Further principals (`gilbert1@`, …) and external
agent fleets are future work on the same machinery, not a configuration knob.

- **One agent, `gilbert@`**, created operator-side in Stalwart's own
  administration — the surface that creates accounts. It works across the
groups it is granted, never by becoming someone: the agent
  principal is not granted `Impersonate`, and Stalwart refuses an impersonated
  group mailbox anyway (live-verified, 403), so the permission would buy only
  the ability to act as human users, on the identity a model drives. The
  admin-facing direction stays: a signed-in admin impersonates the *agent* to
  manage it.
- **An agent is its own process** — the same codebase with a second entrypoint,
  not a replica of gilbertserver and never a supervisor. It derives its session
  as `gilbert@` the way the web tier does and claims the accounts it serves by
  lease (§6), so it needs no coordinator: the documents are the coordination.
  v1 runs one agent; more throughput or availability is another agent,
  declared at deployment.

  **The server starts one beside itself when the deployment names an agent.**
  One command — what the image already runs — is an installation that both
  serves and works; with no agent named the server starts none, which is the
  state the admin surface reports as `agent_not_configured`. The boot retry, the
  identity watch and the stop live in one function (`startAgentFleet`) that both
  entrypoints call, and `node server/dist/agent/agent.js` stays the whole of the
  separate process: `GILBERT_AGENT_INPROCESS=0` is how a deployment keeps the
  fleet there, in a container of its own with its own health endpoint and its
  own restart policy. The fleet's life is then the server's — its shutdown stops
  it, releasing the claims and the stream, so nothing is left holding an account
  under a live lease and the work a restart interrupts is taken up by the
  successor that claims the account when the lease lapses. Nothing about a claim
  changes: a lease arbitrates two agents on one account whether they are two
  processes or one, so a scaled web tier scales claimants and the lease keeps
  that correct — one holder per account, the rest idle.
- **One bootstrap secret, from the deployment's environment**: the agent's
  address and its account's own password — the account's, not an app password,
  because the Master signs in as itself. No impersonation at boot, no operator
  account, no derivation chain, nothing to mint or rotate in the product. The
  secret is the agent's, so its reach is exactly the Master's grants and an
  operator leaving cannot strand the agent. Nothing needs a writable
  filesystem, so `IMMUTABLE=1` holds. Full statement: *The Master
  identity*, below.
- **Management is the admin surface over Stalwart's own documents.** The
  signed-in admin reads the fleet and edits what the installation decides — the
  standing instruction, the automations —
  through ordinary JMAP on Stalwart documents, with no Management API and no
  hand-edited files. Credentials are not among them: the pair is the
  deployment's, and membership is Stalwart's.
- **The agent's account holds its configuration; each group's account holds its
  work.** The Master's settings are documents in the Master's own account's
  `gilbert/` app folder (§4): its registration record and the **model
  provider** — one entry naming a provider, model, base URL and API key, the
  one model every automation of the installation runs on (ADR 0010). Provider
  keys are write-only in the
  admin UI (stored, never read back, like app passwords) and are read by the
  executor through the Master's own session. The Master's account belongs to the
  installation and is never shared with users. Everything members must be able
  to see — the association, the rules, the jobs, the decisions and the audit —
  lives in the **group's** account instead, because that is the account they
  can read.
- **Membership is presence.** The agent is in a group exactly when the operator
  granted it — there is no second, in-product activation switch — and the
  surface reads the grant from the Master's own session rather than declaring
  it. Runtime scope is per changed account: the event's `accountId` selects
  which group's rules apply, because the agent has no single global brief.
- **Admin surfaces.** The Gilbert admin (ADR 0001) gains an Agents section:
  show the agent the deployment declares and the groups that have
granted it (and say so plainly when a group has not), author and version
  per-group rule documents — the form asks the author what the instruction is
  and which capabilities it may use (ADR 0010) — keep the group's standing
  instruction and its notebook of facts, define the labels it files with,
  configure the provider it calls, and read agent status
  and audit across groups.
  Membership is not written there: a group without the grant shows the
  consequence — no agent in its chat, no automations offered — instead of a
  control that cannot work. Every write happens **as the installation's
  agent**: the agent documents are the agent's own — it is the principal that
  executes them — and a group's own files are written through that same door,
  the deployment's own credential when it holds one or impersonation from the
  administrator's session otherwise. An admin acting on the *agent's* account,
  never on a group mailbox, because Stalwart refuses to mint a session for an
  impersonated group mailbox. The requirement on these surfaces is therefore
  the **agent's** grant and not the administrator's own membership: an admin
  who is a member but whose agent is not granted could otherwise author a rule
  the agent can never run, and one who is not a member could author nothing at
  all in a group they administer. Nothing is configured by hand.
- **Members see, never change.** Next to the group chat (ADR 0005) an AI
  indicator opens the group's agent surface: which agent serves the
  group, the instruction it carries, what it does and what it has done (the
  group's audit documents). Members read the group's own documents by
  construction and never edit them from the product — the folder is writable by
  a member by construction, so this is a UI convention and an accepted trust
  inside the group, not a server ACL. The two member actions are approving or
  rejecting a proposed action and addressing the Master, both through the group
  chat.

## Decision

### 1. The Master is a principal with its own address

Every agent is a mailbox in Stalwart's directory with its own address (e.g.
`gilbert@…`), created and granted by the operator in Stalwart's own
administration — the same surface that creates accounts. The address is the
agent's identity and its scope unit. The agent's ACL grants decide what it may
read and act on (a person's mailbox, a group's mailbox, shared Files). Mail
addressed *to* the agent is ordinary mail: it lands in the Master's own mailbox
and wakes it like any other state change — that is how "tell the agent to do
something by mailing it" works. The agent's own password is the one bootstrap
secret the agent holds, and it belongs to the installation, not to a person
(*The Master's identity*).

### 2. Agents are headless, stateless, disposable processes

An agent is a dedicated entrypoint in this repository (Node, same JMAP client
library family as the web client but headless) that authenticates to Stalwart
as exactly one agent principal and runs that agent's rules. It keeps no local
state and needs no volume; any number of agents may run from the same image,
and any agent is interchangeable. The "fleet" is agents × agents: more
agents, more principals; more throughput or availability, more agents. Scope
in force fixes the first factor at one and exposes the second as an agent count.

### 3. Event push is the wake-up; reconciliation is the work

The agent holds its principal's JMAP EventSource (state-change push, type
filter). An event — "account X, type Y changed" — is a *signal to reconcile*,
never a payload to trust: the agent re-reads the changed type narrowly via
JMAP (from the last state it recorded), runs the Master's rules against durable
state, and writes results back via JMAP. Handlers are idempotent by
construction because they recompute from state: duplicates and reconnects
(at-least-once delivery) are harmless, and nothing that leaves no durable
trace can be acted on. This is the same contract the web client already lives
by, minus the browser.

### 4. Rules and durable state are Stalwart documents

- **Rules** ("what this agent does": move group messages, extract files, the
  open set to come) are validated documents in the Master's Files,
  not code or environment; per-group rules live in each group's own account
  (Scope in force). The agent is a generic interpreter plus a library of
  capability-gated actions; adding an agent behaviour means adding an action
  the interpreter can run, and shipping a rule is writing a document.
- **Work state** lives in the principal's Files — per group, in the group's own
  account (Scope in force): job/outbox documents with a lifecycle `pending →
  running → awaiting_approval → done/failed`; leases as owner + heartbeat on
  the documents being worked, re-claimed when stale (the expected-owner patch
  is the CAS substitute); per-job retries with backoff; dead-letter after N
  attempts. A job records the rule `id` and `version` it was created from, and
  a run whose pinned version is no longer the rule's current one does not
  start: it is dead-lettered with a `failed`, because a job never runs a
  version nobody approved (§7). Editing a rule therefore costs the work in
  flight on it, a corrected typo included, and nothing replays that work,
  because the job carries the version *number* and not the body of the rule.
  That is the trade: a job lost loudly, against an effect run under a version
  nobody approved. A job stopped in `awaiting_approval` waits on a person and
  is resumable after any agent restart: its state is the document.
  The pin binds every run that has effects, and a run resumed from an approval
  is one: waiting on a person does not freeze the rule the job was created
  from, so an approval answered on a job whose rule has moved on is that same
  mismatch and not a fourth outcome. The check stands on both paths: inside
  the run, on the pending and running one, and on the approval path
  (`resolveApproval`, `settleSentDraft`) before a single action of an approved
  plan is run.
- **Audit trail**: every run appends one entry to an audit-log document (input
  state, rule id and version, actions taken, outcome), so what an agent did —
  and under which rule version — is answerable from Stalwart alone. The log is
  per group, in the group's own account, one document per month, with a
  declared retention (Scope in force); the trail is read from the group's own
  hidden `gilbert` app folder rather than from the Files a member browses, and
  the copy the retention promises is taken from the admin surface before the
  oldest month is pruned.
- Nothing durable lives on the agent or in the environment; the environment
  carries only the bootstrap secrets toward Stalwart.

### 5. Time-based triggers ride the same machinery

The agent also wakes on a schedule, without cron and without trusting any
particular container to live: a scheduler document (`next-runs`, in the
principal's Files — per group, beside the rules it schedules, Scope in force)
holds the Master's due times as UTC instants; the agent that holds the
account's claim arms a timer for it and updates the document when it fires or when the
work changes the schedule. Durable next-run times plus a lease are what let a
replacement agent pick the schedule up from Stalwart after any crash, which
is why the times live in the document rather than in a cron entry. A fired
timer is spent, so the next arming is planned from the document the fire has
already moved on, and the due entries are read back out of that same document
by every pass — the catch-up, and the reason a schedule edited while an agent
waited is armed as it now is. A due run is started with the claim on its own
account — the same fence every other run passes — and the entry belongs to the
agent that holds that account: an entry no live claim covers is carried over
exactly as it stands, still due, rather than re-planned here and consumed by a
run nobody starts (`carryingForeign`, scheduler.ts). The
runs that vanish are the ones whose rule is off or gone, and each of those is
recorded as a missed run.

### 6. Fleet coordination is lease-based and coordinator-free

Each agent claims the scopes it will serve (the principal's stream, and
per-account work units) by writing owner + heartbeat into the appropriate
Stalwart document; a claim whose heartbeat is stale is re-claimed by any
agent. The one agent that wins a principal's stream claim keeps that
principal's EventSource open; the others stay idle for that principal, so idle
cost is bounded and there is no split-brain: two agents never both hold the
same claim. No coordinator, no shared volume, no database — the documents are
the coordination.

**Nothing supervises the agents, and nothing inside an agent manages
processes.** The fleet is coordinated by the documents and by nothing else: no
supervisor process, no in-process process manager, no pool of child processes that
another process restarts on a heartbeat that is not moving. A supervisor would be a
second coordinator standing beside the claims, and the one thing it can do that
a lease cannot — restart what looks stuck — is the double execution a claim
exists to prevent: the lease already hands a dead holder's account to a
successor, together with the work it left mid-run, and it does it without
knowing which machine either of them is on.

Where an agent appears to hang, what is missing is not recovery but
**diagnosis**, and it is bought with visibility rather than with processes: what
an agent holds (this section, and the heartbeat record that names the groups),
the unit and the job it is in the middle of and since when, and the per-call
timeouts the model and JMAP clients already carry (`AbortSignal.timeout`) made
readable where a person looks instead of a line in a log.

Concurrency, when it comes, is a bounded fan-out over **units that hold their
own claim** — a lease per reconcile type and per job — never a process manager:
child processes inside one process would contend for the same account claim and buy
nothing, and the work is I/O, which one process already overlaps. The order and
the unverified premise it rests on are recorded in `ROADMAP.md`.

### 7. Patterns from the field, and what is deliberately not adopted

A survey of established, actively maintained orchestration repositories
(2026-09-06; sources in References) splits the field into durable execution
engines (Temporal; Conductor; Inngest; Hatchet), agent frameworks (LangGraph;
Microsoft Agent Framework; CrewAI; OpenAI Agents SDK) and end-to-end platforms
(n8n). All of them run on infrastructure this repo's law forbids — their own
queue, database and volume — so Gilbert adopts patterns, never dependencies or
engines.

What the field locks in:

- **Lease + heartbeat on work documents is the queue-visibility primitive**
  (Temporal task queues, SQS-style visibility timeouts): §6 is on the
  established path, not an invention.
- **Per-job retries with backoff, timeouts, compensation and a dead letter**
  after N attempts (Conductor's per-task model), as in §4.
- **Human-in-the-loop as an interrupt**: a job stops in `awaiting_approval`,
  the group is asked in its own chat and the agent resumes only on an approved
  state change — the analogue of LangGraph's interrupts.
- **Rules are versioned, and a job names the version it was created from**
  (Conductor's versioned definitions, the same concern read the other way). A
  pinned version that is no longer current is refused rather than run, because
  the job carries the version *number* and not the rule, and an effect under a
  version nobody approved is worse than a job lost loudly. The refusal is read
  wherever a run can start: on the pending and running paths inside the run,
  and on the approval path (§4). There is no replay-compatibility problem
  because this design never replays.
- **Audit is an append-only per-run event log** (LangSmith/Conductor-style
  observability), stored as a Stalwart document — §4.
- **Deterministic routing first, and a model for the decision** (Inngest
  agent-kit's phrasing): the trigger, the filter and the capability allowlist
  decide whether a run happens and what it may do, and the actions it takes are
  the model's answer inside that grant. The invariants hold on every answer
  (*The automation model*, §4).
- **Delegation by handoff**: an orchestrating agent composes specialist agents
  (CrewAI's manager, OpenAI's handoffs, Microsoft's agents-as-tools) — which,
  with one address per agent (§1), is native: an agent mails the specialist.
- **A per-account concurrency cap**, so one burst on a group mailbox cannot
  thundering-herd the fleet; the claim unit is the account.
- **Dead letters surface where the work is** — the group's chat and audit, and
  the admin surface's queue. Notifications are chat-only, so a dead letter is
  not a second inbox to watch.

Deliberately not adopted: deterministic replay (Temporal) — reconciliation
from durable state is the simpler idempotency contract (§3); a workflow DSL or
visual canvas (Conductor, n8n) — rules are documents; external runtime engines
— a dependency that would import a queue/database and licence constraints
(SSPL, fair-code) into a JMAP-only product.

The 2026 field draws a hard line: *checkpointing is not durable execution*.
Agent frameworks (LangGraph, CrewAI, Google ADK, Microsoft Agent Framework,
Strands, Dapr Agents) persist state but do not detect failure, restart or
deduplicate on their own; durable runtimes (Temporal, Restate, Inngest, DBOS,
Dapr Workflows) do. That line validates this record's side of the contract —
reconciliation from durable state, leases for takeover — and names the piece it
leaves to deployment: detecting a dead agent and restarting it (Open
questions). The Postgres-based entrants (DBOS; Kitaru and Absurd) run durable
execution on an ordinary row store, confirming that a document store is a valid
engine substrate — here, Stalwart Files with lease documents as the queue,
scheduler and coordination layer. Standards are settling around the two seams
this record keeps open: A2A (agent-to-agent) moved to the Agentic AI Foundation
in August 2026 alongside MCP (model-to-tool); Gilbert's future external-fleet
boundary should speak A2A, and a future LLM action should be exposed over MCP —
neither is in scope. Finally, mailbox-as-interface is a live product pattern:
AgentMail (2026) gives agents their own inboxes, instructions by ordinary mail
and thread-grouped conversation, confirming §1; thread-as-conversation-unit is
a candidate rule semantic (Open questions).
## The Master's identity

The agent's address and password are the deployment's, not the product's. The
pair lives in the environment of whoever runs the containers or the built
server — `GILBERT_AGENT_ADDRESS` and `GILBERT_AGENT_PASSWORD` — and both
processes read it through the one function that defines it (`agentAddress()`).
The password is the account's own: the Master signs in as itself, not through an
app password and not through an impersonation. The product therefore never
mints, stores or rotates a credential — rotating it is an operator act in
Stalwart that lands on the deployment, and the variables are read at boot, so
the new pair takes effect at the next start.

Nothing about the pair is registered, minted or rotated in the product, and
nothing in the admin surface names it. Neither process refuses to start for it:
with the pair missing, or with credentials Stalwart refuses, the agent warns
once, keeps answering its health endpoint and serves nothing, and the state is
read in the admin surface rather than from a process that died. The server
starts regardless, and the
admin surface reports the state it finds — `agent_not_configured`,
`agent_credentials_rejected`, `agent_unreachable` — beside the two variables to
set, so an installation without agents is a warning an administrator can read
and act on, never a boot failure.

Membership is not recorded either: the Master is in a group exactly when the
operator granted it — the Master added to the group in the mail server's own
administration — and both the admin surface and the agent read that from the
agent's own session, which is re-read once per poll interval (a minute by
default). Nothing per group is written anywhere: a grant is picked up by the
next session refresh, and a group whose grant is gone is withdrawn from on the
pass that no longer lists it, without a restart and without a record of ours to
keep in step.

Two consequences follow. A group that loses the grant stops being served: the
agent stops renewing the claim and the lease lapses — no agent deletes
another's claim. And the change reaches the agent at its next session refresh;
the web tier reads it live.

## The automation model

- **An automation, not a rule language.** An automation is authored in the
  admin form — "When [event] / If [optional filters] / Then [actions]" — and
  stored as a JSON document validated against a standard JSON Schema, built on
  standard primitives only: the JMAP filter grammar (RFC 8621) for matching and
  named, capability-gated actions for effects. Sieve keeps the delivery-time
  boundary; there is no new rule language. The schema is derived from the same
  constants the runtime reads, and the checks a document cannot state — that a
  rule's actions are inside its capability allowlist, and that a `G-` label it
  names exists in that group's catalog — stay in code and reach the author as
  one list. A rule carries a prose **instruction**, a capability allowlist, a
  trigger and a review policy (ADR 0010), and the schema's checks are the same
  for every rule: a rule without an instruction, or without a capability, is
  refused rather than stored to match and do nothing (`ruleProblem`). The
  document and its schema are the form the runtime validates, and there is no
  separate compiled form: the instruction is what the run is held to.
- **Every run asks the model, inside the rule's own grant.** A run hands the
  rule's instruction to the model, which answers with actions from the
  catalogue, and the answer is validated against the rule's capability
  allowlist before any action runs (`planFor` → `decideActions`, `executor.ts`
  and `llm.ts`) — so a model answer never names an action the rule was not
  granted. One provider serves the installation, and it lives in the agent's
  own account (Scope in force; ADR 0010).
- **The model's role.** The model is the decider of the run and the executor
  performs its answer. The safety invariants hold: the model acts only through
  the capability-gated actions, inside the Master's ACL scope, with every run
  audited. Rules decide triggers, permissions and context, not every step.
- **Granularity and context.** An automation acts on the single message; the
  context it needs is assembled on demand — the thread (grouped by In-Reply-To)
  and the group's mail folders — fetched narrowly when a rule needs them, never
  bulk-loaded.
- **Attention is labels, not folders.** The reserved `G-` prefix tracks
  processing state on a message — `G-needattention` when the agent cannot
  proceed confidently or a person must look, `G-processed` once handled, and
  the set extends (`G-awaiting`, `G-rejected`, …) as use cases need. Labelling
  never moves the message; moving is a separate, content-driven action, into
  the folder the model chose. Labels come from the group's catalog
  (ADR 0005), and an admin **who is a member of that group** authors it through
  their own session while the agent — a granted member, never an administrator
  — only applies and removes. State is per message, not per thread: a reply in
  an already-processed thread is a fresh event, unlabelled and re-evaluated on
  its own, because the thread is context and not state. `G-*` labels are
  agent-owned and read-only to humans — a product convention, not a server ACL:
  a JMAP keyword is free-form, and only the client's surfaces render them on
  the individual message, never aggregated onto the thread row, and keep them
  out of the manual picker.
- **Review policy and human approval.** Every automation carries a review
  policy — `always` (every run pauses), `threshold` (auto-execute at or above a
  confidence, else pause; the default a new automation starts at, its number
  set per automation) or `never` — and the external-send consent floor is never
  relaxed by it. Every run returns a confidence (0–1); above the threshold the
  action runs unattended, below it the job pauses in `awaiting_approval` with a
  decision document. Approval is conversational: the proposal is posted in the
  group chat and answered in words — no Approve/Reject buttons — and a pending
  outbound mail is a draft in the group's Drafts, marked `G-awaiting` and kept
  unread, which the chat references; only the approved draft is sent, and a
  draft sent directly from Drafts is itself the approval. Any member of the
  group may approve, not only an admin. The decision document, patched with an
  expected-owner update, closes the job whichever way the answer arrived, so
  there is one arbiter and no race — and a draft that left Drafts wins over a
  conversational reply, because a person sent it and its content as sent is what
  was approved. For reversible in-group actions the model may interpret a reply and
  ask a closed clarifying question when the answer is ambiguous; for
  irreversible or external actions the reply must resolve to an unambiguous
  yes/no and only explicit consent proceeds — never a model-guessed approval.
  Confidence is a model signal, not a guarantee: threshold auto-approval is an
  owner-accepted risk.

- **Chat is the human interface.** Members and the agent talk in the group
  chat. Two ways to address it: an `@gilbert` mention, or a direct reply to a
  message the agent authored (a reply counts only when its direct parent is the
  agent's message; a mention covers everything else). That is the executor's
  deterministic pre-filter, applied before any model call: a chat message that
  neither mentions the agent nor directly replies to one of its messages is
  ignored. A mention is a general request with the group and its chat as
  context; attaching a specific message or thread reference is deferred. The
  agent appears as a participant at its own address exactly when it is granted
  on the group — membership is presence, and with several agents each is
  mentioned by its own address — and the client renders its messages and offers
  it in the `@` picker, whose second source is the group's own agent
  association, so a freshly granted agent that has never posted can still be
  mentioned. Its default context is bounded — the last 50 messages of the
  conversation with their reply chain — and widens only when a human asks, step
  by step (whole conversation, then a folder) under a hard ceiling (300
  messages / one folder slice); the agent never expands on its own, it asks for
  more. Instructions come from the conversation; referenced mail, files and
  other content are data, never instructions — the capability allowlist and the
  review policy remain the final gate. The audit records who asked, so a
  proactive automation and a human request are told apart afterwards.
- **Where extracted files land.** In the **group's own Files, in the visible
  tree** — the folder the automation names, or the folder the model chose, and
  `Needs attention` when nothing determined one.
  Never the hidden `gilbert` app folder, where a member would not find it, and
  never loose in the Files root, where a file nobody could place would be a
  shrug rather than a signal. The same destination rule governs every action
  that writes where people look: `file.write` writes into the group's visible
  tree, in the folder the action names, and it never replaces a file it finds
  there — the name it actually used is what the run reports. The limit that
  buys is worth naming: a rule that wants one note kept up to date accumulates
  numbered copies (`2-name`, `3-name`), because telling "the file this rule
  wrote last time" from "a file a member put there" would need a provenance
  marker the tree does not carry. Updating a file in place is future work.

- **The group's standing instruction.** A group keeps one document — the shape
  of an `AGENTS.md` — that its agent carries into the system slot of **every**
  model call, before the automation's own instruction and before the data it
  looks at. It lives in the group's own app folder (`agent/instruction.json`),
  and an administrator of the group writes it in the admin surface beside the
  rules: a text the model is told to follow is configuration, and members read
  the rules rather than write them. What the agent is told, and what it does,
  is readable by every member of that group — the automations and this
  instruction open from the AI panel beside the group chat, and nothing there is
  editable but by an administrator — because a member who cannot see either
  cannot judge what the agent does in their name. It can steer and cannot grant:
  what an automation may do is its capability allowlist, checked on every
  answer, so the instruction cannot widen a rule, and the prompt says so under
  the field and in the block itself.
- **A group sends as itself.** When an automation sends on a group's behalf the
  executor reads the group's own identities from JMAP `Identity` on the group
  account (`settings.json` is the app's settings document, not the identity),
  uses the group's default identity and applies its `textSignature`/
  `htmlSignature` exactly as the UI composer does — the From is the group, and
  the sent message lands in the group's Sent mailbox so members see what went
  out. There is no separate footer setting: the footer *is* that signature.

## Failure paths

A crash, two agents, an unreadable document, a model choosing a name, a retry
that would repeat an effect: each is settled here, because the invariants above
are only worth what their failure paths are.

- **The claim's compare-and-set token is read before the claim document**
  (`lease.ts`). Read the other way round, a claim written by another agent
  between the two reads is invisible to the comparison and both agents walk
  away believing they hold the unit.
- **Claims carry an epoch**, incremented on takeover and never on renewal, and a
  run asks `claimStillMine` before anything leaves the process — sending,
  posting, filing, drafting. The fenced set is one explicit list,
  `FENCED_ACTIONS` in `documents.ts` (`mail.send`, `chat.post`, `mail.draft`,
  `file.write`, `mail.extract`), read by the fence and by the retry decision
  alike, so an action cannot be fenced in one and repeatable in the other. A
  agent whose lease lapsed stops instead of writing results
  the agent that replaced it will write again. An agent that holds no claim on
  an account starts nothing there: the pending sweep logs it and goes on, and a due
  timer waits for the agent that holds it.
- **A release is conditional** on the state it was read against; the owner check
  alone could remove a successor's live claim written between the read and the
  removal. `saveClaimStates` never recreates a released claim, and `claimAccount`
  says *why* it refused — held under a live lease, lost the compare-and-set —
  rather than one `null` for every reason.
- **An unreadable heartbeat is not a free lease.** It throws, because "unknown"
  and "expired" are different answers; the pass contains the throw, naming the
  account it could not read and moving to the next one, and the polling loop
  hands whatever a tick threw to the Master's log.
- **A job left `running` is not left to nobody.** `runPending` takes up a
  `running` job whose lease has expired, so a dead agent's work is finished by
  the next pass — with the deduplication key suppressing every new job on the
  same trigger, a job nothing picks up is that trigger's work never happening.
  A run whose lease expires and that no agent comes back for ends with the
  audit outcome **`timeout`**, not `failed`: nothing reported a failure — the
  process that would have is the one that is gone.
- **Intent before effect.** A run's plan is written onto the job before the
  first effect, so an effect can never exist without a line accounting for it,
  the settlement of a sent draft included; a retry reuses the plan rather than
  asking the model again. The job carries `applied[]`, the actions that landed
  in order, and the next pass starts after them.
- **An action that reaches outside is never retried.** The `unrepeatable` flag
  on the action's spec marks anything that leaves what a person will find —
  sending, and also `mail.extract` and `file.write` — and such a job is
  dead-lettered rather than repeated beside the copy it already filed. Between
  attempts sits an explicit backoff (`nextAttemptAt`), because three attempts
  back to back are one attempt against a provider that is down.
- **An approval is consumed once.** `appliedAt` is written in the same
  conditional write that moves a decision out of `pending`, before the effects,
  so two answers arriving together cannot send the same mail twice. The draft
  that left Drafts is looked at before the chat is read, so a member who sent
  the draft and then wrote "sì" is settled by what they did.
- **An audit entry that does not land is retried, then carried.** The append
  retries its conditional write with backoff and jitter, and an entry that still
  does not pass is queued; the queue is drained by the account's next append and
  by every pass. Two limits are declared rather than hidden: the granularity
  stays monthly (the blob every append reloads grows with the month, and so does
  the window in which two writers contend), and the carry-over queue is in
  memory, so a restart loses it. The audit is never written over: missing is an
  empty month, there-but-unreadable is loud and a person decides.

- **A filter is validated on names and on types**, in one list with the other
  cross-field rules: a key beside `operator` is refused rather than silently
  ignored, a value the matcher could never match (`minSize: "1000"`) is refused
  rather than accepted as an automation that looks armed and does nothing, and
  an `operator` group with no conditions is refused because `AND` over nothing
  is true and `NOT` over nothing matches everything. A degenerate cadence is
  refused and the scheduler's delay is floored, so a past instant cannot
  re-fire in a tight loop. The same list is the authoring door and the run's: a
  rule that reached storage by another road — a document written by hand, an
  older form — is refused in the words the author would have read.
- **The chat context stays inside the bound a human set.** The window takes the
  bound first, so on a thread longer than the bound the reply chain contributes
  nothing and the message being answered is the one ancestor that survives,
  named by id and put back with the window giving way. "The agent widens its own
  context for nobody" is the invariant, and a long thread is where it would have
  been broken; a transcript that does not hold the named message is an error
  rather than a different conversation answered quietly.
- **The member's surface never impersonates.** A name that is not in the
  member's own session is not a group this person may act as, and the answer is
  reached without asking the mail server anything — Stalwart's refusal stops
  being the only thing between a signed-in user and another group's documents.
  The administration's door is the other one: a group's agent documents are
  reached as the installation's agent, so the grant the admin surfaces read is
  the agent's and not the administrator's.
- **An irreversible action always asks a person**, whatever the rule's mode and
  whatever `allowExternal` says. Sending is today the only external action and
  also the only irreversible one, so the two coincide; the flags stay separate
  so they cannot drift into an irreversible effect nobody was asked about.
- **Withdrawing a group's grant is administration, not a stop button.** The
  agent reads its reach from its own session and the group's documents, so an
  operator who withdraws the grant removes the session and the ability to start
  or finish work there — but nothing enumerates, cancels or drains what was
  already in flight: a decision waiting on a person, a job holding a lease, a
  draft left in the group's Drafts marked `G-awaiting`. The withdrawal is taken
  on Stalwart's clock and not Gilbert's — the surface reads grants and reports
  them, it never writes them — so nothing here delays a revocation. The agent
  re-reads its session at most once per poll interval (a minute by default, a
  third of a lease), and an account it was serving that the session no longer
  lists *is* the withdrawal. It stops from that pass on and writes it down once
  — what the group was called, which account the agent held, and when it noticed
  — into the Master's **own** account (`agent/withdrawals.json`), the one place
  it can still write and the one the status route reads. Nothing on the way out
  writes or deletes anything in the withdrawn account: the claim is left for its
  lease to lapse, because deleting another account's documents would be taking a
  trust it was never given.
- **No order is guaranteed between automations that match the same message.**
  A reader and a writer do not collide: JMAP addresses a message by an
  immutable id, so a read is unaffected by a move that happened a moment
  earlier. Two rules that *write* to the same message are the case that bites —
  the second write wins silently, and nothing tells anyone the two disagree. The
  order is not merely undecided but not guaranteed, not even inside one account:
  `runEmail` walks the matching rules in document order and awaits each, but a
  run that waits on a person or is retried is picked up from `listJobs()` in the
  order the server gives, so it can resume while a later rule of the same
  account is already running. Each automation is written to hold whatever order it gets,
  and the audit names the rule and its version per run, so the order is
  reconstructible afterwards. A declared order and a collision report are
  declared gaps, and the surface says so where rules are written
  (`RuleEditor.tsx`).
- **The content a rule reads can carry an instruction, and the allowlist is the
  gate.** Mail, files and everything else the agent reads are data; nothing in
  them is followed as instruction, and the capability allowlist with the review
  policy bounds an action. For an action that stays inside the group and runs on
  a confidence threshold, that confidence is the model's own signal about
  content the same model read, so a hostile message can move it; the mitigation
  — a person for any action whose trigger arrived from outside the group — is
  not adopted, and the cheaper one between them is a declared gap rather than an
  oversight, because nothing in the chain carries where a trigger came from.
- **Failure is loud.** A provider that is unreachable, a refused or expired key,
  or a malformed model answer never skips work silently: the job records the
  failure in the audit, the run lands in `G-needattention`, and the group chat is
  told which automation could not finish. Notifications are chat-only; mail
  notification is a later extension of the same audit, never a second channel to
  keep in sync.
- **An admin surface says which grant it needs.** The approvals queue walks the
  agent's own session — exactly the groups a decision can be waiting in, since
  the agent is the principal that asks — so the queue is complete by
  construction and carries no enumeration caveat. The refusal a group the agent
  does not hold meets names the section that asked: `deniedGroupAccess` carries
  the need, the code and the parameters travel as a pair (`{ error, need }`) and
  never as a sentence, which is composed where it is read, from the catalogue in
  force, so a language whose catalogue does not carry it reads the English — the
  declared fallback. `AgentAdminError` carries an `AgentErrorReason`, the fleet's
  status answer carries a code plus the upstream text as `detail`, and
  `web/src/lib/agentErrors.ts` holds the compiler to every code of the union. No
  English goes on the wire, and a body whose code this build does not know is
  read as the prose it carries.
- **The audit trail is retention-bounded by policy.** One document per month per
  group, kept 12 months; the months live in the group's own hidden `gilbert` app
  folder, read by a member through the group's agent panel and by an
  administrator through the Agents section; the copy the retention promises is
  taken there — the group's row hands over every retained month as JSON
  (`GET /api/admin/groups/:name/agent/audit`) — so a month is pruned after its
  copy can be taken, never before.

## Verified against Stalwart

- **Send path, live (2026-09-10, 0.16.21).** A group account carries its own
  JMAP `Identity` for its own address; a member's `myRights` on the group's
  mailboxes include `maySubmit`; and a submission from the group account with
  that identity — a draft in the group's Drafts, then `EmailSubmission/set`
  with `onSuccessUpdateEmail` into Sent — went out (`undoStatus: pending`) and
  filed itself in the group's Sent. On 0.16 `Identity` does not return
  `maySubmit` at all: the signal is the mailbox `myRights`, so neither the
  client types nor the mock invent that field. A sendAs identity for the group
  address also exists on a member's own account, and is not used, because it
  would file the sent copy in the member's Sent instead of the group's.
- **Master principal, live (2026-09-10).** `gilbert@` exists on a real instance
  and is granted on a real group. Its session shows the group account, its
  `myRights` on the group's mailboxes include `maySubmit`, and it both reads and
  creates nodes in the group's own `gilbert/` app folder — so rules, jobs,
  audit and decisions have a writable home. A submission from that session with
  the group's own identity came back `undoStatus: final` with
  `smtpReply: "250 2.1.5 Queued"` and filed itself in the group's Sent: the
  send path is verified for the principal the design uses, not only for a
  member. Delivery to an inbox is not something this side can prove.
- **The shape of a real group (2026-09-10).** The group identity's signatures
  are empty, and the group's `gilbert/` app folder holds `chat/`, `chat-state/`
  and `labels.json` — no `settings.json`, so the footer needs nothing new, and
  `labels.json` already carries a first label.
- **Impersonation writes.** Composite impersonation authentication
  (`{target}%{master}`, master credentials) opens a session as the target, and
  `x:AppPassword/set` create and destroy on the target's account are permitted
  under it: Stalwart's refusal rules cover *authenticating* with app passwords,
  not registry writes by an impersonating admin. Stalwart refuses an
  impersonated *group* mailbox (403), which is why a group's documents are
  reached as the agent that holds them and never by impersonating the group.
- **Conditional writes, live (2026-09-11, `scripts/probe-conditional-writes.mjs`).**
  A stale `ifInState` is refused, the refusal arrives as **`stateMismatch`**
  (RFC 8620 §5.3) and never as `invalidArguments`; the FileNode state token
  advances on a successful write and does **not** advance on a blob upload —
  which is what makes the order `writeAppFileAt` uses (read the state, upload,
  set conditionally) safe. The mock's simulation matches every one of those
  answers, and the note beside it in `server/src/mock/index.ts` records them
  with the date.
- The instance did not report its own version over JMAP; the other live probes
  in this record were taken against 0.16.21.

## Consequences

- The agent's own password is the one bootstrap secret the agent holds, and it
  belongs to the installation rather than to a person; on top of ADR 0001's
  administration model (permission marker; `Impersonate` for per-user writes),
  impersonation in the design points one way — an admin acting on the agent's
  account — and the group's own documents are written through that same door,
  so no surface ever needs to act as a group mailbox.
- **The author of a change is the administrator's, and it rides on our own
  field.** A group's documents are written as the agent, so what Stalwart's own
  record shows is the agent — except where the door is impersonation, whose
  composite `{agent}%{admin}` carries the administrator's identity in the
  credential itself. A deployment that holds the agent's password writes as the
  agent alone: the author then lives only in the document's `updatedBy`, and in
  a job's `trigger.by` for a run a person asked for. The stronger posture — no
  shared password in the web tier — is therefore the one whose authorship is
  Gilbert's to keep true, and it keeps it in the documents.
- **The right that opens the door is wider than the door.** Where the
  deployment holds no password for the agent, impersonation is the only way to
  reach it — and Stalwart's `impersonate` grants acting as *any* principal, not
  only as the agent. These surfaces use it toward one target, and never toward
  a group mailbox (403); what the operator hands an administrator is wider than
  what the routes ask of it.
- One agent means one reach: the Master's grants cover every group it is granted,
  so a compromise of the agent exposes all of them at once, not one group at a
  time. Accepted — the same order of risk threshold auto-approval already
  accepts — with per-group agent principals as the future mitigation, not a
  setting.
- Work claims are the account, so two agents never touch the same account at
  once; the per-account concurrency cap of §7 bounds how much of a single group
  the fleet works on. With the default single agent, work per account is
  serialized in arrival order.
- An agent's scope is exactly its grants: it sees and acts on what the operator
  granted, nothing else. A new group is served by granting the agent in
  Stalwart's own administration, the same way admin membership is granted;
  grant management stays there — Management API territory, not JMAP,
  deliberately out of scope — and the admin surface reads the grants and
  reports them, it never writes them.
- Every event costs a reconcile: rules must be written as narrow queries (per
  type, from the recorded state) and the push filter must stay tight, or the
  agent spends its life re-reading mailboxes nothing changed in.
- Time triggers require at least one agent per scheduled agent to be up; the
  scheduler document is the source of truth, so a dead container costs only the
  lease interval and a replacement takes over from Stalwart.
- Reconcile-only semantics means reactions are possible only to changes that
  leave durable state; anything ephemeral — a connection event, a transient
  condition — is out of scope by construction.
- The mock must simulate both state-change push and clock triggers, so agent
  behaviour is testable in the existing CI gate (web and server tests run under
  `TZ=UTC`).
- A job stopped in `awaiting_approval` may wait indefinitely on a person; it
  must survive any agent restart (its state is the document) and must never be
  re-claimed as stale while it is legitimately paused.
- Rule documents carry an `id` and `version`; the audit records which version
  each run used, and editing a rule ends the runs pinned to the older version,
  which are dead-lettered — including a job stopped in `awaiting_approval`,
  whose pin is read when the run resumes. A rule edit is therefore also a
  decision about the work already in flight on that rule.
- Agent work can be slow by design: a reconcile may call an external model or
  wait on a person, so leases and heartbeat intervals must tolerate pauses far
  longer than the request/response web tier's.
- The agent's lifecycle is the agent's: a deploy or a crash pauses agent work
  for the downtime window, and recovery is automatic — session re-derived at
  boot, stale leases re-claimed, catch-up and reconciliation from the recorded
  state. Nothing hangs on a dead process because the state is the documents,
  and a web deploy is not an agent outage.

## Alternatives considered

- **A queue or database of the agents' own** (Redis, Postgres, a volume
  outbox): rejected — architecture law: everything durable lives in Stalwart.
  The job documents and leases are the queue.
- **One shared service account serving every agent**: rejected — a shared
  principal cannot be granted per agent, cannot audit per agent, and has no
  per-agent address to be mailed to. Per-agent mailboxes are the scope and
  identity unit.
- **Agents embedded in the web server container**: rejected — it mixes the
  disposable, request-scoped web tier with long-lived claim-holding processes
  and scales them together. The agent is its own process, and what the server
  starts by default is one of those, not a piece of the web tier.
- **A launcher that starts both processes**: rejected as the default — it keeps
  two things to think about, needs a supervisor in the image, and buys isolation
  only for the deployments that already know they want it, which is what
  `GILBERT_AGENT_INPROCESS=0` gives them without a second program to maintain.
- **An agent started unconditionally, credentials or not**: rejected — most
  installations name no agent, and a process that exists to warn about its own
  missing configuration is noise. The pair is what makes a fleet meaningful, and
  it is what the start is conditioned on.
- **The fleet in a thread or a child process inside the web container**: rejected
  — that is the launcher with the supervisor removed: the restart policy would
  still see only the server, and the fleet would be invisible to the operator's
  own tooling.
- **Cron inside the container**: rejected — disposable containers offer no
  durability or overlap guarantees; the scheduler document does.
- **Polling as the primary trigger**: rejected; kept only as the recovery
  fallback after a lost or missed push.
- **Webhooks out of Stalwart**: not available — Stalwart's own event surface is
  JMAP push, and that is what this design consumes.

## Open questions

- Pending probes for the operator-credential alternative of the admin write
  path: (c) that an operator authenticated by **app password** — not by the
  account password — may impersonate a target, and (d) that `x:AppPassword/get`
  keeps returning the secret to an impersonating admin. Neither is on the
  default path — the Master's own credentials and the master-credential
  impersonation are — so they matter only if an installation chooses that
  alternative.
- **Detecting and restarting a dead agent is the deployment's job.** Durable
  state, leases and the scheduler document make takeover automatic once a
  replacement is running; nothing in the product notices that one is gone.
  A restart policy plus the health endpoint (`GILBERT_AGENT_HEALTH_PORT`) is
  where that is answered today.
- **Thread-as-conversation-unit** is a candidate semantic: an automation could
  act on the thread rather than the message, with state on the thread. Not
  adopted — state is per message — but it is the shape most group-memory
  features would want.
- **A declared order between automations, and a collision report** when two
  runs in one pass wrote to the same message: declared gaps, surfaced where
  rules are written, not guarantees.

## References

- README.md — the four blocks, the agents' section
- ADR 0001 — the administration surface (permission marker, impersonation for
  per-user writes, hidden app folders, the boot channel)
- ADR 0004 — live policy propagation (the settings-policy document)
- ADR 0005 — group chat and the group label catalog
- ADR 0010 — an automation is an instruction a model carries out (Proposed): it
  supersedes this record's automation model — the shape of a rule and the
  provider it calls — and states the notebook, the prompt's order, the meter,
  the chains, the document tools and the run a person asks for
- `server/src/app.ts` — `/api/events` push relay, the admin agent routes
- `server/src/agentAdmin.ts` — the Master's own session, grants, group views,
  rules, providers, instruction, audit export
- `server/src/agent/lease.ts` — claims, epochs, conditioned writes
- `server/src/push.ts` — the inbound push rail (RFC 8620 PushSubscription) the
  wake-ups ride
- `web/src/jmap/push.ts` — state-change push semantics as the web client lives
  them
- `web/src/lib/agentErrors.ts` — the one catalogue every agent error code
  resolves through
- Stalwart Sieve — the delivery-time boundary, confirmed out of the agents'
  scope (ADR 0008)

- `server/src/agent/views.ts` — the one definition of the agent API's response
  shapes, imported by both the routes and the client
- `web/src/views/admin/agent/RuleEditor.tsx` — where rules are written, and where
  the declared gaps (order, collision report) are surfaced
- `scripts/probe-conditional-writes.mjs` — the live probe of `ifInState` on
  `FileNode/set`, and the record of its answers
- Surveyed repositories (patterns, never infrastructure), 2026-09-06:
  - https://github.com/temporalio/temporal — durable workflow service (event
    history + deterministic replay; the rejected replay model)
  - https://github.com/conductor-oss/conductor — declarative durable workflows;
    per-task retries/timeouts/compensation; versioned definitions, no replay
  - https://github.com/inngest/inngest — durable step functions replacing
    queues, state and scheduling
  - https://github.com/hatchet-dev/hatchet — orchestration engine for background
    tasks, AI agents and durable workflows
  - https://github.com/langchain-ai/langgraph — durable execution,
    human-in-the-loop interrupts, memory
  - https://github.com/crewAIInc/crewAI — crews/flows; sequential and
    hierarchical (manager) processes
  - https://github.com/openai/openai-agents-python — agents, handoffs,
    guardrails, tracing
  - https://github.com/microsoft/agent-framework — production agent framework;
    successor of microsoft/autogen (maintenance mode); 1.0 GA April 2026
  - https://github.com/n8n-io/n8n — workflow automation platform (fair-code;
    queue/database-backed — the rejected shape for Gilbert)
- Re-survey 2026-09-09:
  - https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake
    — checkpointing is not durable execution
  - https://www.diagrid.io/infrastructure/10-best-temporal-alternatives-2026 —
    durable-execution alternatives compared
  - https://www.zenml.io/blog/where-durable-execution-is-headed — Postgres
    checkpoint recovery; Kitaru and Absurd
  - https://vercel.com/i/ai-agent-frameworks — choosing agent frameworks in 2026
  - https://www.axios.com/2026/08/17/a2a-agentic-ai-foundation-open-ai-standards
    — A2A moves to the Agentic AI Foundation (August 2026)
  - https://www.ycombinator.com/launches/NvQ-agentmail-the-api-first-email-provider-for-ai-agents
    — AgentMail: agents with their own inboxes
  - https://docs.agentmail.to — AgentMail docs (agent onboarding, threads)
