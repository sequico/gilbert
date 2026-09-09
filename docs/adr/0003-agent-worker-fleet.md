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
- A principal's JMAP session includes every account it is granted over —
  the mechanism ADR 0001 relies on to detect the admin group. One agent
  principal therefore receives one multiplexed push stream for all the
  accounts it may see, keyed by `accountId`.
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

## v1 scope (owner decisions 2026-09-09)

The general model below (Decisions §1–§7) describes the full design. The
owner has since scoped v1 to a single self-hosted installation; this
section amends or defers parts of that model for v1, and the rest of this
record keeps its full shape as the evolution path.

- **One structure agent per installation, `gilbert@`, by default.** v1 ships
  one agent principal serving every group, created operator-side in
  Stalwart's own administration (the same surface that creates accounts)
  and associated to the installation from the Gilbert admin. Specialist
  agents and "external agent fleets later" (ROADMAP) are future work on the
  same machinery.
- **The executor runs inside gilbertserver (the Node/Hono server in
  `server/`) in v1.** This deliberately revisits the "workers embedded in
  the web server container" rejection (Alternatives) for v1: the
  disposable tier is acceptable because every durable byte stays in
  Stalwart, the agent session is re-opened from the bootstrap secret at
  every boot, and mid-flight work is recovered from job documents after a
  restart. The executor is a background task isolated from the request path
  (async, non-blocking; leases tolerate pauses far longer than the web
  tier's). Separate worker replicas and lease-based fleet coordination (§2,
  §6) return when availability or throughput outgrows one process (Open
  questions).
- **One bootstrap secret per agent principal, in the environment.** The
  agent's app password lives in the deployment environment
  (`GILBERT_AGENT_*`), set once at deploy, compatible with `IMMUTABLE=1`:
  nothing needs a writable filesystem because the session is re-established
  from the environment at every boot and sessions stay in memory. On
  writable deployments the agent session may instead be sealed like a user
  session (SESSION_FILE), removing even the environment secret.
- **Management is automatic from the admin surface, via impersonation.**
  The signed-in admin selects the agent account; gilbertserver creates and
  rotates the agent's app passwords through JMAP `x:AppPassword/set` under
  impersonation (live-probe item — Open questions) and manages everything
  else through ordinary JMAP on Stalwart documents. No Management API, no
  hand-edited files, no fields to paste secrets into. The app-password
  secret is returned once at creation and never re-readable; rotation in an
  immutable deployment means regenerating from the admin surface and
  updating the environment at the next deploy.
- **Per-group activation, rules and audit live in each group's own account**
  (its `gilbert/` app folder), following the group-ownership law and the
  ADR 0006 pattern (chat, `labels.json`): members see that the agent is
  active in their group and what its automations do by construction,
  because group Files are already readable by members. The agent's own
  account (`gilbert@`) holds its registration record. Runtime scope is per
  changed account: the event's `accountId` selects which group's rules
  apply — the agent has no single global brief.
- **Admin surfaces.** The Gilbert admin (ADR 0007) gains an "Agents"
  section: associate agent principals to the installation (select
  `gilbert@`), activate or deactivate the agent per group, author and
  version per-group rule documents, rotate app passwords, and see executor
  status and audit across groups. Every write happens through the signed-in
  admin's session — impersonation where acting on the agent's account,
  ordinary JMAP on group documents otherwise; nothing is configured by
  hand.
- **Members see, never change.** In a group's own view, next to the group
  chat (ADR 0006), an AI indicator opens the group's agent surface: which
  agents are active for the group, what instructions (rule documents) they
  carry, what they do and what they have done (the group's audit
  documents). Members read the group's own documents by construction and
  never edit them: authoring and every change stay in the admin UI.

**Resolutions of the recorded questions (owner decisions 2026-09-09):**

- *1 — app-password creation under impersonation* stays open: to be proven
  on a real 0.16 instance, or pinned by mock-parity tests, before the
  automatic create/rotate flow is trusted.
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
  decides and executes). Capabilities cover the whole JMAP surface the
  agent is granted — mail, files, tasks, calendars and contacts, read and
  write — each an audited action behind the ACL scope. High-impact actions
  (sending mail) go through `awaiting_approval` unless the automation opts
  out. The concrete schema and editor are pinned when the first use case
  is implemented.
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
- *8 — returning to replicas* (the owner delegated the call): when one
  in-process executor no longer meets availability or throughput, replicas
  return as separate processes of the same codebase, declared at deployment
  level (restart policy plus a health endpoint), self-coordinated by leases
  (§2, §6) — no in-product supervisor. A supervisor is revisited only if
  operations asks for a single control point.
- *9 — the group attention convention*: agent work in a group's mail is a
  visible state machine over folders and labels with the reserved `G-`
  prefix. Anything the agent cannot process with confidence, or that needs
  a person, lands in the `G-needattention` folder with the
  `G-needattention` label; processed work is marked `G-processed`, and the
  convention extends (`G-awaiting`, `G-rejected`, …) as use cases need.
  The folders and labels are created and managed with the group machinery
  already in place (group label catalog, ADR 0006; group folders), by the
  admin or by the agent through the same capability when granted; members
  read the state in the group's own mailbox by construction.

## Decision

### 1. An agent is a principal with its own address

Every agent is a mailbox in Stalwart's directory with its own address (e.g.
`gilbert@…`), created and granted by the operator in Stalwart's own
administration — the same surface that creates accounts and the admin group.
The address is the agent's identity and its scope unit. The agent's ACL
grants decide what it may read and act on (a person's mailbox, a group's
mailbox, shared Files). Mail addressed *to* the agent is ordinary mail: it
lands in the agent's own mailbox and wakes it like any other state change —
that is how "tell the agent to do something by mailing it" works. Each agent
principal has an app password as the one bootstrap secret the worker holds.

### 2. Workers are headless, stateless, disposable replicas

> v1: the executor runs inside gilbertserver (v1 scope); this section is the
> evolution path for when replicas return.

A worker is a dedicated entrypoint in this repository (Node, same JMAP
client library family as the web client but headless) that authenticates to
Stalwart as exactly one agent principal and runs that agent's rules. It
keeps no local state and needs no volume; any number of replicas of the same
image may run, and each replica of an agent is interchangeable. The "fleet"
is agents × replicas: more agents, more principals; more throughput or
availability, more replicas of an agent.

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
- **Work state** lives in the principal's Files: job/outbox documents with a
  lifecycle `pending → running → awaiting_approval → done/failed`; leases as
  owner + heartbeat on the documents being worked, re-claimed when stale (the
  expected-owner patch is the CAS substitute); per-job retries with backoff;
  dead-letter after N attempts. A job records the rule `id` and `version` it
  was created from, so an in-flight job keeps executing against the rule
  version it started with after the rule document is updated (running
  executions keep their version — §7). A job stopped in `awaiting_approval`
  waits on a person and is resumable after any worker restart: its state is
  the document.
- **Audit trail**: every run appends one entry to an audit-log document in
  the agent's own account (input state, rule id and version, actions taken,
  outcome), so what an agent did — and under which rule version — is
  answerable from Stalwart alone.
- Nothing durable lives on the worker or in the environment; the environment
  carries only the bootstrap secrets toward Stalwart.

### 5. Time-based triggers ride the same machinery

The worker also wakes on a schedule, without cron and without trusting any
particular container to live: a scheduler document (`next-runs`, in the
principal's Files) holds the agent's due times; the replica holding the
nearest lease arms a timer for it and updates the document when it fires or
when the work changes the schedule. Durable next-run times plus a lease mean
a replacement replica picks the schedule up from Stalwart after any crash.

### 6. Fleet coordination is lease-based and coordinator-free

Each replica claims the scopes it will serve (the principal's stream, and
per-account work units) by writing owner + heartbeat into the appropriate
Stalwart document; a claim whose heartbeat is stale is re-claimed by any
replica. The one replica that wins a principal's stream claim keeps that
principal's EventSource open; the others stay idle for that principal, so
idle cost is bounded and there is no split-brain: two replicas never both
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
  the operator is asked through ordinary mail (or a Gilbert task) and the
  worker resumes only on an approved state change — the analogue of
  LangGraph's interrupts.
- **Rules are versioned and in-flight jobs are pinned to their start
  version** (Conductor: "running executions continue on the version they
  started with"). There is no replay-compatibility problem because this
  design never replays.
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
  thundering-herd the fleet (Hatchet's fairness concern).
- **Dead letters alert the admin group by mail** — Gilbert administers
  itself through its own medium.

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
names the piece it leaves to deployment: detecting a dead replica and
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

- One bootstrap secret per agent principal (its app password, in the
  environment), on top of ADR 0007's administration model (permission
  marker; Impersonate for per-user writes).
- An agent's scope is exactly its grants: it sees and acts on what the
  operator granted, nothing else; a new account is served by granting the
  agent, the same way admin membership is granted in ADR 0007. Grant
  management stays in Stalwart's directory (Management API territory, not
  JMAP — deliberately out of scope, as in ADR 0007).
- Every event costs a reconcile: rules must be written as narrow queries
  (per type, from the recorded state), and the push filter must stay tight,
  or the worker spends its life re-reading mailboxes nothing changed in.
- Time triggers require at least one replica per scheduled agent to be up;
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
- Rule documents carry an `id` and `version`; upgrading a rule leaves
  in-flight jobs on their starting version and the audit log records which
  version each run used.
- Agent work can be slow by design: a reconcile may call an external model
  or wait on a person, so leases and heartbeat intervals must tolerate
  pauses far longer than the request/response web tier's.
- v1's in-process executor makes gilbertserver's lifecycle the agent's
  lifecycle: a deploy or crash pauses agent work for the downtime window,
  and recovery is automatic — bootstrap re-auth at boot, stale-lease
  re-claim, push catch-up and reconciliation. Nothing hangs on a dead
  process because the state is the documents.

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
  processes and scales them together. v1 runs the executor in-process
  despite this general rejection (v1 scope).
- **Cron inside the container**: rejected — disposable containers offer no
  durability or overlap guarantees; the scheduler document does.
- **Polling as the primary trigger**: rejected; kept only as the recovery
  fallback after a lost or missed push.
- **Webhooks out of Stalwart**: not available — Stalwart's own event surface
  is JMAP push, and that is what this design consumes.

## Open questions (recorded; the v1-scope section and the resolutions above record what is decided)

- Whether real Stalwart 0.16 permits `x:AppPassword/set` under
  impersonation (the mock does; the refusal rules cover *authentication*
  with app passwords, not creation). Open until proven on a real instance
  or pinned by mock-parity tests.

## References

- ROADMAP.md — "AI agents that act inside mail and file storage, for a
  person or a group — Gilbert's own agents now, external agent fleets later"
- ADR 0001 — group grants, everything-durable-in-Stalwart, session-account
  mechanism, admin-group secret pattern
- `server/src/app.ts` — `/api/events` push relay (existing event surface)
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
