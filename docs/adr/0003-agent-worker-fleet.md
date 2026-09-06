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
> A survey of established agent-fleet orchestration repositories (2026-09-06)
> informs Decision §7: Gilbert adopts the field's *patterns*, never its
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
  ADR 0001's policy documents are.
- Architecture law: everything durable lives in Stalwart — no own database,
  no writable volume; the container is disposable. New identifiers are named
  `gilbert`.

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
  Files, not code or environment. The worker is a generic interpreter plus a
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
  it arrives, is a capability-gated *action*, never the interpreter.
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

## Consequences

- One bootstrap secret per agent principal (its app password, in the
  environment), on top of the admin group secret of ADR 0001.
- An agent's scope is exactly its grants: it sees and acts on what the
  operator granted, nothing else; a new account is served by granting the
  agent, the same way admin membership is granted in ADR 0001. Grant
  management stays in Stalwart's directory (Management API territory, not
  JMAP — deliberately out of scope, as in ADR 0001).
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
  processes and scales them together.
- **Cron inside the container**: rejected — disposable containers offer no
  durability or overlap guarantees; the scheduler document does.
- **Polling as the primary trigger**: rejected; kept only as the recovery
  fallback after a lost or missed push.
- **Webhooks out of Stalwart**: not available — Stalwart's own event surface
  is JMAP push, and that is what this design consumes.

## Open questions (recorded, not blocking v1)

- How rules are authored and installed: v1 by editing the agent's Files
  documents directly (operator/admin), or a management surface later —
  probably an admin feature under ADR 0001.
- Whether ADR 0001's per-user policy should later gate agents per user
  (e.g. "this agent is enforced off for this account"); the profile
  machinery would carry it, but nothing is decided.
- Where "external agent fleets later" (ROADMAP) draws its boundary: an
  external fleet is not a Gilbert principal and would need a defined,
  authenticated API surface — future ADR, not this one.
- Multi-Stalwart installs: same open question as ADR 0001 — whether agent
  principals and their documents are per server or per install.
- Whether v1 agents need generative steps at all (an LLM call as an action);
  the survey's answer is to guardrail it as a capability-gated action, but
  no agent feature in the confirmed scope requires one yet.

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
  framework; successor of microsoft/autogen (maintenance mode)
  https://github.com/n8n-io/n8n — workflow automation platform (fair-code;
  queue/database-backed — the rejected shape for Gilbert)
