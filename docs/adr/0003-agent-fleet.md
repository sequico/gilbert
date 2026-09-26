# ADR 0003 — The agent fleet

Status: Accepted

Implementation: Built in the main: the fleet, the claim and the executor
(`server/src/agent/agent.ts`, `lease.ts`, `executor.ts`), the capability
allowlist, and the three admin surfaces. Decided here and not built: diagnosing
an agent that is hung rather than gone, and more than one agent inside one group
(both in `ROADMAP.md`).

This is **gilbertagents**, one of the four blocks `README.md` names: agents
that act on Stalwart events and on time schedules, inside mail and file
storage, for a person or a group. Sieve owns delivery-time actions inside
Stalwart; agents act afterwards, on delivered, durable state. Nothing runs
outside a JMAP session: the only live connection an agent holds is its own
principal's push stream, the same mechanism a signed-in browser uses.

## Identity and process

Every agent is a mailbox in Stalwart's directory with its own address (e.g.
`gilbert@…`), created and granted by the operator in Stalwart's own
administration — the same surface that creates accounts. The address is the
agent's identity and its scope unit: its ACL grants decide what it may read
and act on. Mail addressed *to* the agent is ordinary mail — it lands in its
own mailbox and wakes it like any other state change, which is how "tell the
agent something by mailing it" works.

The agent's address and password are the deployment's own — `GILBERT_AGENT_ADDRESS`
and `GILBERT_AGENT_PASSWORD` in the environment, read at boot through
`agentAddress()`. The password is the account's own: the agent signs in as
itself, never through an app password or an impersonation, so the product
never mints, stores or rotates a second credential. With the pair missing or
refused, the agent warns once, keeps answering its health endpoint, and
serves nothing; the admin surface reports the state it finds
(`agent_not_configured`, `agent_credentials_rejected`, `agent_unreachable`)
rather than the server failing to boot.

An agent is a dedicated entrypoint in this repository (Node, the same JMAP
client family as the web client, headless — no browser, no proxy). It keeps
no local state and needs no volume, so any number of agents may run from the
same image and any agent is interchangeable; the fleet is agents × the
principals it runs as. `GILBERT_AGENT_INPROCESS` decides where the fleet
lives: by default the server starts one beside itself in the same process,
and `=0` keeps it in a container of its own with its own health endpoint and
restart policy. Either way, `startAgentFleet()` is the one function both
entrypoints call, and the fleet's life is the server's — its shutdown
releases every claim and stream it held, so a restart's work is picked up by
whichever agent claims the account next.

Membership is presence: the agent is in a group exactly when the operator
granted it in Stalwart, with no second, in-product activation switch. Both
the agent and the admin surface read that grant from the agent's own
session, re-read once per poll interval (a minute by default) — a group
whose grant is withdrawn stops being served from the next poll on, and the
withdrawal is written once into the Master's own account
(`agent/withdrawals.json`) for the admin surface to read. Nothing on the way
out touches the withdrawn account's own documents; the claim is simply left
for whoever serves that account next to take it over.

## Rules and durable state are Stalwart documents

The agent's own configuration — its registration record, the single model
provider (below) and the installation's own rules of prose (ADR 0019) — lives in
the Master's own `gilbert` app folder. Everything
a group's members must be able to see — the automations, the policy, the jobs,
the decisions, the audit — lives in the **group's own account** instead, because
that is the account they can read. Every write into a group's documents happens **as the
agent**: it is the principal that executes them, using the deployment's own
credential or impersonation from an administrator's session. The grant these
surfaces need is therefore the agent's on the group, not the administrator's
own membership.

- **Rules** are validated JSON documents, not code or environment. The agent
  is a generic interpreter over a library of capability-gated actions; adding
  a behaviour means adding an action to the library, and shipping a rule
  means writing a document.
- **Work state** is a job document with a lifecycle `pending → running →
  awaiting_approval → done/failed`, carrying the rule's `id` and `version` it
  was created from. A job whose pinned version is no longer the rule's
  current one does not start — it is dead-lettered, because a job never runs
  a version nobody approved. A job stopped in `awaiting_approval` is
  resumable after any restart, since its state is the document.
- **Audit** is one entry per run — input state, rule id and version, actions
  taken, outcome — appended to a per-group, per-month document in the
  group's own hidden `gilbert` app folder, retained for twelve months.
- Nothing durable lives on the agent or in the environment beyond the
  bootstrap secret.

## Time-based triggers

A scheduler document (`agent/schedule.json`, beside the rules it schedules)
holds due times as UTC instants. The agent holding a group's claim arms a
timer from that document and updates it when a run fires or the schedule
changes, so a replacement agent picks the schedule up from Stalwart after any
crash rather than from a cron entry. A due run is started under the same claim
every other run passes; an entry no live claim covers is carried over exactly
as it stands rather than re-planned, and a run whose rule is off or gone is
recorded as a missed run.

## Coordination: claims and fencing

Each agent claims the scopes it serves — a principal's push stream, and
per-account work — by writing owner and epoch into the claim document, and it
writes that document **when it takes the claim and when it releases it, never
on a clock**. There is no heartbeat in the account and no lease that lapses on
time: liveness is a fact about the process that hosts the agent and is held in
memory, and a claim another agent took is taken over when the claim it reads is
older than the process reading it — never merely because time passed
(`server/src/agent/lease.ts`).

That rule is a consequence of what a document is: every durable write in
Stalwart is a blob an account's upload quota pays for and nothing reclaims
(JMAP offers no blob removal), so a write on a clock — a heartbeat, a renewed
lease, a stamp nobody reads — spends a group's finite budget on saying that a
process is alive. A deployment's server and its agents share a fate, which is
what makes the in-memory answer sufficient: when the process goes, its claims
are the ones nobody is holding, and the next process adopts them.

Claims carry an epoch, incremented on takeover and never on a pass over a claim
that is already one's own, and a run checks `claimStillMine` immediately before
any action that leaves the process — sending, posting, filing, drafting,
reshaping a document into a new file, or writing the group's memory. That
fenced set is one explicit list,
`FENCED_ACTIONS` (`mail.send`, `chat.post`, `mail.draft`, `file.write`,
`notebook.write`, `mail.extract`, `document.split`, `document.merge`,
`document.extract`), read
by both the fence and the retry decision, so an action cannot be fenced in one
and repeatable in the other. An agent that finds its claim taken from it stops
rather than writing results the successor will write again.

Nothing supervises the agents, and nothing inside one manages processes: the
documents are the only coordinator. A job left `running` past its lease is
picked up by the next pass of any agent — a run whose lease expires with
nobody coming back for it ends with the audit outcome `timeout`, distinct
from `failed`, because nothing reported a failure; the process that would
have is the one that is gone. A plan that holds an action which leaves the
process — the same `FENCED_ACTIONS` set the fence reads, `leavesTheProcess` —
is dead-lettered rather than retried, with backoff between attempts
elsewhere. An approval is consumed once, in the same conditional
write that closes the job, before any effect runs — and a draft that left
Drafts is checked before the chat is read, so a member who sent the draft
and then answered in words is settled by what they actually did.

## An automation is an instruction a model carries out

An automation has one shape: a **trigger**, a prose **instruction** and a
**capability allowlist** — and the group it belongs to carries the review
policy, one per group (ADR 0006). There is no separate compiled form and
no fixed action plan — every run hands the instruction to the model, which
answers with actions drawn from the capability catalogue, and the answer is
validated against the automation's own allowlist before anything executes
(`planFor` → `decideActions`, in `executor.ts` and `llm.ts`). An automation
without an instruction or without a capability is refused at authoring time
rather than stored to match and do nothing, and a group may hold only one
enabled automation per trigger, because nothing in the document distinguishes
two of them (`rulesProblem`).

The model proposes; the allowlist disposes. What the model decides is which
granted action to take, never whether an ungranted one may run, and every
run is audited with the rule and version it used. Attention is tracked with
the four reserved `G-` label keywords the catalog defines (`G-needattention`,
`G-processed`, `G-awaiting`, `G-rejected`) — agent-owned, read-only to humans
by product convention, applied per message rather than per thread, since a
reply in an already-processed thread is a fresh, unlabelled event.

### The model call

Every call requests `response_format: json_object` (so the answer parses)
and a maximum output token bound, and sends `temperature: 0` — which a
reasoning model in thinking mode simply ignores, so it buys nothing on its
own. What makes a run repeatable is the JSON shape, the allowlist that
refuses anything ungranted, and the trail recording exactly what setting a
run used, never the temperature. Thinking is a per-agent parameter
(`GILBERT_AGENT_THINKING`), set beside its poll interval and lease, so one
agent can reason and another can run cheaply; a takeover can change which
applies to a group, and every run records the setting it used beside the
tokens it spent, so a change in behaviour is always readable against the
agent that produced it. Reading a draft for coherence (below) is not a run
and carries no agent's setting — it always runs with thinking off.

**One model serves the installation.** Configuration is a single entry —
provider, model, base URL and API key — read by the executor through the
Master's own account; the key is write-only, stored and never read back,
like an app password. An installation with no provider configured has no
automations at all, and the admin surface says so wherever it already names
what is missing.

### Review policy and human approval

Every group carries one review policy — `always` (every run pauses),
`threshold` (auto-execute at or above a confidence, else pause) or `never` —
and every run returns a confidence between 0 and 1. It is the group's own
document rather than a field on each automation (ADR 0006): how cautious a
group wants its agent to be is true of the group's work rather than of one
automation, and a policy repeated per automation is a policy that drifts apart.
"At or above a confidence" is one constant (`AGENT_REVIEW_THRESHOLD`) rather
than a number every author invents. Below it the
job pauses in `awaiting_approval` with a decision document; approval is
conversational, posted and answered in the group's own chat rather than with
buttons, and a pending outbound message is a draft in the group's Drafts,
marked `G-awaiting`. Any member may approve, not only an administrator. For
irreversible or external actions — sending is today both — the review policy
never relaxes the floor: only an unambiguous yes/no, never a model-guessed
approval, and the model may ask one closed clarifying question when a reply
is ambiguous, but only for reversible, in-group actions.

### Memory, prompt order and cost

A group keeps one **notebook** document — facts its agent should hold on
every call: how mail is filed, what clients are called, which language the
group works in, exceptions its administrator wrote down. It lives in the
group's own account, so it survives a container, a deploy and a replacement
agent, and a person can read and correct it.

The prompt is built in one fixed order and stays that way, and `proseHead` in
`llm.ts` is the one function that produces the prose half of it: the system
preamble (data-not-instructions), the capability catalogue, the installation's
own rules (ADR 0019), the group's notebook, the group's standing instruction,
the automation's own instruction, and last the volatile content — the message,
its thread, the chat slice. Nothing volatile goes before that tail, because the
stable head is what a provider's context cache can serve nearly free; the
volatile tail is what a run actually pays for. The same builder serves a
**reading** helper (a web tier call, not a job — no claim, no lease), which can
check a draft instruction for coherence against the context the agent would
actually be given, and reports gaps in words rather than editing the prose
itself.

Every call's token cost — input that hit a cache, input that missed, the
answer — is recorded in the group's own monthly document, split by the agent
that spent it, alongside whether the run reasoned. An administrator's own
authoring calls (running the coherence reading) are metered separately, into
the Master's own account, so a group's usage document has exactly one
writer. Costs are counted in tokens, never converted to money — a price list
belongs to a vendor and changes without notice.

### Chains and manual runs

One automation's effect can wake another — a file landing wakes a file rule,
a chat message wakes a chat rule — through the group's own documents, and
each job's trigger records the job that woke it. A chain runs five hops by
default (configurable per installation); the run past the bound is refused
loudly rather than dropped silently — the group's chat is told which
automation could not run and why, and the audit records the refusal under
its own outcome, `refused`, distinct from `missed` (nothing could fire a due
run) and `timeout` (a holder stopped reporting). The count restarts at hop
one whenever nothing in the retained audit window explains an earlier
effect.

A person can also ask for a run directly — **Run now** on the Automations
tab resolves the group, the automation and a message (the one named, or the
newest in the group's own inbox), and writes an ordinary job under the
trigger value `manual`, executed on the automation's own terms (allowlist,
the group's review policy, version pin, audit). An automation carries no
filter, so the message is not matched against anything but the automation its
author asked for. A refusal — there is no such automation in the group any
more, it is not armed, it is not about mail (a chat automation is asked for
in the group's chat and a timed one runs on its own clock), or there is no
message to run it on — is answered to whoever asked and never enters the
group's audit, since nothing ran.

### Document tools

The capability catalogue includes deterministic document work, run by the
executor rather than asked of the model, on a blob already in the group's own
Files and entirely in memory: page work on a PDF (split, merge, extract) and
reading — a PDF's own text layer, a `.docx`, a workbook (`.xls`, `.xlsx`), a
text file (`.csv`, `.txt` and the other plain-text types), or an image
(`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`). A page with no text layer is
rasterised to an image in the same process and handed to the model, which
reads it directly — vision, not OCR, so there is no separate extraction
engine and no artifact behind the reading. A file that is already an image
carries no text layer by construction, so it takes the same path with
nothing to rasterise: its own bytes, sniffed against the four formats' magic
numbers rather than trusted from its name, ride the call as that one page.

`document.read` answers text and nothing else, and says what it did not read
rather than passing a part off as the whole. A PDF's pages with no text layer
are named; a workbook is read sheet by sheet, one sheet counting as one page,
so the sheets past the run's page bound are left out and the gap is readable
in `looked` against `pages`; a text file or a workbook that runs past the
character ceiling (`DOCUMENT_TEXT_MAX`, 200 000) is handed over as the
beginning of itself with `truncated` true, because a file's whole content
being text is exactly the case the byte ceiling does not bound. A spreadsheet
is read as the text its cells store — a number as a number, a date as the
date it says, a formula's cached value — since nothing in this family
evaluates one. A `.csv` is text and is read as it stands: no delimiter is
parsed and no column is named, because a reader that guessed at a dialect
would invent structure the file may not have.

The family reads documents; it never writes one. No `.docx` writer and no
spreadsheet writer: reading what a client sent is worth a library, writing one
is a job for a person's word processor. Every library here is pure JavaScript
or WASM with no native build step, matching the container's `IMMUTABLE=1`,
disposable constraint, and the workbook reader brings no dependencies of its
own.

### When an agent cannot work

Two distinct states are derived from the audit trail rather than kept as a
second document: *nobody is serving this group* (no agent holds its claim)
and *the model is refusing* (the most recent run failed to reach or parse an
answer). Both surface in the two places a person looks — the indicator
beside the group's chat, and the administration — naming the cause in the
reader's own language, with the provider's own message carried alongside as
a diagnostic.

## Content is data, never instruction

Mail, files and chat the agent reads are data; nothing inside them is
followed as an instruction. The capability allowlist and the review policy
are the only gate on what a run may do, whatever the content says. An
irreversible or external action always asks a person, whatever the group's
policy says.

## No cross-rule ordering guarantee

Two rules that both write to the same message are not arbitrated: the
second write wins silently. Order is not guaranteed even within one
account — a run that waits on a person can resume while a later rule on the
same account is already running — so every automation is written to hold
whatever order it gets, and the audit names the rule and version per run so
the order is reconstructible afterwards.

## The admin surface

The agents admin area is three sections.

- **Master** — the installation, configured once: the agent's identity
  (address, operational state, the environment variables it comes from), the
  single provider/model configuration, the rules that hold in every group (ADR
  0019), and the plain list of groups the
  agent's own session reports. Membership is shown here, never written.
- **Group Agents** — the agent *in one group*, behind one group picker and
  read as one subject before any section is opened: its header names the agent
  serving the group and how much of it is armed, and its four sections are
  **Behaviour** (the **Standing instruction** every call carries and the
  **Review** policy — who its runs stop for, and whether they may reach outside
  the group without a person), **Automations** (the editor, one rule per
  trigger, showing a scheduled automation's next due time), **Memory** (the
  notebook) and **Activity** (a window on that group's own monthly audit,
  newest first, with the full month exportable as JSON, and **Agents** — who is
  serving that group, read from the process that hosts the agent, and which
  grants it has lost). A control here also defines the group's label catalog.
  The automations document is a section of the agent's behaviour rather than a
  peer of its configuration documents: it holds up to four independent rules,
  each pinned by `ruleId`/`ruleVersion` on the jobs and audit that reference it
  and each readable by the group's own members. This build is the only writer of
  the agent's documents, so a document that is there in any other shape — an
  older format, a hand edit — is not left behind: on read it is replaced with the
  document's current empty form, or removed when it has no empty form (a claim,
  a stream claim, a job, a decision, the configuration), so the next write
  recreates it in the current shape. The replacement is conditional on the state
  the bad document was read at, and a replacement that cannot land raises
  `AgentDocumentError`, answered as `agent_document_not_current` rather than as
  an unreachable mail server.
- **Approvals** — cross-group oversight, read-only by construction: a
  **Pending** tab shows every group's paused decisions at once, and an
  **Audit** tab merges every granted group's trail, filterable by group and
  outcome. There is no approve or reject control on this surface —
  an operator answers a paused run as a member, in the group's own chat,
  which is where the conversation, the draft and the arbiter live.

The member door is the other half of this. `/api/agent/group/:name` answers
what every member reads — the automations, the standing instruction, the
group's policy, the runs still open and the recent audit — with the member's
own session on the group's account, never an administrator's. The notebook
stays in the administration: it is configuration the model is given, and a
member reads what the agent is told and what it did rather than rewriting it.
One fact it answers is not a document of the group at all: its **roster**,
read as the Master through Stalwart's registry (`x:Account/query` filtered by
`memberGroupIds`, then `x:Account/get` on the ids that named). A member's own
credential cannot open
that door — `sysAccountGet` and `sysAccountQuery` are not in the built-in user
role, and the Group role does not carry them either — and the Master is the
one principal of an installation with a reason to ask. The read is cached per
group for a minute, and a refusal is the `null` the asking surface falls back
from rather than an error it reports; ADR 0005 is where the chat spends it. A
status read says whether the Master may ask at all — `roster`: `ok`,
`forbidden`, `unreadable`, `unknown` — because the answer is an operator's
grant and the page that carries it is the one that operator reads.

## Consequences

- One agent means one blast radius: a compromise of the Master's credential
  exposes every group it is granted on at once, accepted at the same order  of risk threshold auto-approval already accepts.
- The agent's own account password is the one secret the fleet holds;
  nothing mints, stores or rotates a second one.
- A deploy or a crash pauses agent work for the downtime window only —
  recovery is automatic from durable state: session re-derived at boot,
  claims taken over by the process that comes up, schedules and jobs picked
  up from their documents.
- Work claims are the account, so two agents never touch the same account
  at once; with the default single agent, work on one account is serialized
  in arrival order.
- Determinism is traded deliberately and bought back three ways: the JSON
  answer shape, the allowlist, and the setting recorded in the trail — never
  the temperature. What is not deterministic is which granted action a run
  picks.
- The roster is one more thing the Master's credential may do, and only when
  the operator grants it: with `sysAccountGet` and `sysAccountQuery` on the
  Master's own account — a per-account permission, narrower than any
  administrator role, and exactly the pair a Tenant Administrator carries —
  it reads who is in each group it holds. Without them nothing breaks and
  nothing changes: the roster is `null`, and every surface that wanted one
  keeps what it already had.

## References

- `server/src/agent/agent.ts` — `startAgentFleet`, the poll loop
- `server/src/agent/lease.ts` — claims, epochs, conditioned writes
- `server/src/agent/executor.ts` — the capability check, review outcome, the
  document tools
- `server/src/agent/llm.ts` — the model call: temperature, JSON format,
  token ceiling
- `server/src/agent/documents.ts` — `FENCED_ACTIONS`, action specs,
  `rulesProblem` (one enabled automation per trigger), `AgentGroupPolicyDoc`
  and `policyOf`, `AgentProseDoc` and `proseFor`
- `server/src/agent/documentFamily.ts` — the readers (PDF, `.docx`, workbook,
  text) and the page work
- `server/src/agent/scheduler.ts` — due times, catch-up
- `server/src/agent/chat.ts` — the mention/reply pre-filter
- `server/src/agentAdmin.ts` — the Master's own session, grants, group
  views, rules, providers, instruction, audit export, `runRuleNow`, and the
  group roster read
- `server/src/agent/views.ts` — the agent API's response shapes
- `web/src/views/admin/AdminAgents.tsx` — Master
- `web/src/views/admin/GroupAgents.tsx` — Group Agents
- `web/src/views/admin/agent/AgentApprovals.tsx`,
  `web/src/views/admin/AdminApprovals.tsx` — Approvals
- `web/src/views/admin/agent/RuleEditor.tsx` — the rule form
- ADR 0001 — the administration surface (impersonation, per-account
  documents)
- ADR 0005 — group chat and the group label catalog
