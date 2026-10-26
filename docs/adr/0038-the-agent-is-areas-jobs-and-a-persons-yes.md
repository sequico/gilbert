# ADR 0038 — The agent is areas, jobs, and a person's yes

Status: Proposed

Implementation: Partly built. **Built:** areas and their selection
(`server/src/agent/areas.ts`), the eight jobs and their narrowing
(`agent/tools/jobs.ts`, and the interface rules the file states held by
`agent/tools/aci.test.ts`), one instruction per group
(`agent/instruction.ts`, panel `GroupInstruction.tsx`), the change as trigger with
the run keyed by it and the one-off clear (`changes.ts`, `loop.ts`, `legacy.ts`),
the `done` read against its plan (nothing finished → `refused`), the repair of an
invalid call (`model.ts`, `loop.ts`), the credential filter (`redact.ts`), the eval
runner (`eval.ts`), native function calling as the only action protocol with the
decision turn in the provider's structured output (`model.ts`), the provider probe
and the declared output ceiling at publish (`installationAdmin.ts`), the daily token
ceiling with the pass document's counter (`shared/installation.ts`,
`shared/agent.ts`, `loop.ts`), a permanent provider failure stopping the pass, and
the eval: eleven tasks in the repository (`agent/eval/tasks/`), one file each
with its message, data and reference, graded with partial credit, a failed task
tried once more, `pass@1` and cost printed beside the refusals a run recovered
from, one task parking a run on a person's answer and continuing it there, and
the provider put to the product's own probe before anything is measured (`eval.ts`), and the turn's
context: the plan's last steps in full and earlier ones a line each, with the
threshold measured and no summary call (`prompt.ts`, `prompt.test.ts`), and the
trend: a week of runs and failed steps read from the run documents in
Administration, and each pass and run it ends emitted as OTLP/HTTP logs in the
OpenTelemetry GenAI shape when `limits.otlp` names a collector (`agent/otlp.ts`,
`loop.ts`), and **the memory as entities, relations and time** (`shared/memory.ts`,
`agent/memory.ts`, `agent/tools/memory.ts`): one document per entity and per fact
under the installation's `memory/`, the entity identified by its normalized name
with aliases only as explicit facts, a fact carrying the interval it is true for
and the vector it was written with, a contradicting fact closing the one it
replaces, a duplicate never written, retrieval by exact subject then similarity
then recency with relations one hop, the pass applying the TTL, the "since when"
read by entity and interval, the embeddings capability probed with the provider's
others, the run recording `retrieval` beside `recalled`, and precision and recall
measured on a corpus in the repository (`agent/eval/memory.ts`); a sheet of an
earlier version is read as an entity and an `is` fact without being rewritten.
**Not built:** everything in *Owed*, and the change of this record's ceilings: the
run-level step, call and time ceilings are still endings (`loop.ts`'s
`RUN_MS_MAX`, `RUN_CALLS_MAX`, `RUN_STEPS_MAX`, `limits.maxRunSteps`); the turn is
still the plan's tail rendered as a **sliding window** (`prompt.ts` clips an older
outcome to its beginning and re-carries whole the last three distinct answers), not
the appended transcript above, with no compaction and no reader. The work that carries
the record as it now stands is `docs/plans/agents-reloaded-again.md`.

## What this replaces, and what it keeps

**Replaced:** ADR 0027 (one catalogue, the model as its own planner, the
whole-answer refusal) and the five short records beside it, withdrawn into this
one; ADR 0031 (many rules per group, each with a surface matrix). **Amended:**
ADR 0030's plan-as-the-normal-shape — the common path is the workflow below.
**Kept:** ADR 0028 (authority classes), 0029 **amended** (a question parks the
run in the conversation; a mail leaves only as a draft), 0030 (the
run is a document and the record is the product), 0032 (one process holds the
claim), 0033 (the memory), 0034 (a batched drop), 0037 (the cursor as
reconciliation).

## Context

A live installation measured what one catalogue and one planner cost: **260 refused
steps across 94 of 171 runs (55%)**, **67 of 132 runs that ended `done` had refused
a step**, **20 runs out of budget**, one run spent **308 seconds** on fourteen
refused steps, one pass of **329 seconds** made another group wait, and **no run
ever parked on a person**. The refusals are tool misuse: invented tool names, a
mailbox id where a message id belongs, `chat.say` called with the wrong arguments,
`files.list` seven times in one plan.

## Decision

### Areas, and the catalogue a run is given

Each area — mail, calendar, contacts, files, knowledge, workorders, chat, memory —
is a **module**: one definition of its actions, no import of another area's, and
what crosses between them is **an identifier inside the account**. An area is not
an agent; the run is the one place where two areas meet.

- **Reading and the shared library are always present**: `read`, `find`, `say` and
  `remember`; the instruction filters only the four area writes (`place`, `draft`,
  `event`, `settle`), and the guard reads the job's `kind`/`action` when one job
  reaches more than one area (`place` writes mail or files, `remember` memory or
  knowledge): a tool-level filter cannot say which half of a job is allowed.
- **The schema follows the areas.** A job shows only the `kind`/`action` the run's
  areas allow; the guard that reads them is the second door, not the first.
- **An instruction declares the areas its group works**, with no ceiling: the
  conversation and memory are always on, and the catalogue a run sees is the
  selection, not the declaration. A group naming five areas accepts a larger
  turn.
- *Correspondence* and *agenda* are the two common selections (mail + files,
  calendar + workorders), not a taxonomy.

### The catalogue is eight jobs

Forty-five endpoint tools become eight; every capability is a field of a job or
**consciously dropped**:

| job | what it is | absorbs |
|---|---|---|
| `read` | one known object, by id | `mail.read`, `mail.readAttachment`, `files.read`, `calendar.read`, `knowledge.read`, `chat.read`, `workorder.read`, `run.read` |
| `find` | ask the account what is there | `mail.find`, `mail.folders`, `files.list`, `calendar.list`, `calendar.find`, `chat.find`, `contacts.find`, `knowledge.list`, `knowledge.search`, `workorder.list` |
| `place` | put something where it belongs | `mail.file`, `mail.trash`, `mail.untrash`, `mail.keyword`, `mail.label`, `files.save`, `files.write`, `files.overwrite`, `files.move`, `files.rename`, `files.delete`, `files.folder`, `mail.folder`, `mail.renameFolder`, `mail.deleteFolder` |
| `draft` | write an outward message, never send it | `mail.draft`, `mail.editDraft` |
| `event` | create, change or cancel an event or a series | `calendar.create`, `calendar.update`, `calendar.delete` |
| `say` | speak in the conversation, or ask | `chat.say`, `chat.ask` |
| `remember` | keep a fact, or propose a knowledge page | `memory.remember`, `knowledge.propose` |
| `settle` | close or move a workorder | `workorder.settle` |
**Dropped: `mail.send` and `mail.ask`.** An outward message is a draft a person
sends, as the boundary below states; `mail.ask` sent a question and parked the
run, which the draft
rule makes impossible — a question is asked in the conversation (`say`), and a
mail leaves only when a person sends it. Contacts carry no write; `find` is their
whole surface.

`place` carries an **`action`** (`file`, `trash`, `untrash`, `keyword`, `label`,
`save`, `write`, `overwrite`, `moveFile`, `renameFile`, `deleteFile`, `folder`,
`mailFolder`, `renameFolder`, `deleteFolder`) and `draft` a `kind` (`reply`,
`edit`); the authority class is read from that value, not from the tool, because
one job spans reversible and destructive acts.

- **A sequence the job implies lives inside the tool** that names the job: filing a
  booking's documents is part of reading that mail, not a second tool to chain.
- **Every call says what kind of thing it is about** — the job's `kind`/`action`
  — and its arguments say what they hold (`id`, the id `find` answered; `path`, a
  document's; `folder`, a folder's name, role or id), so a mailbox id cannot
  stand where a message id belongs. A refusal quotes the real names and a valid
  example.
- **A tool returns a distillation, never the payload** — what happened, and the id
  to use next.
- **No code execution**, by decision: the job-shaped tool buys what it would buy
  elsewhere, in a container with no writable filesystem.

### One agent per run

An orchestration that routes between agents exists to handle an unknown shape. Here
the shape is known: the change names one object, the instruction names the areas. A
run is **one agent** — one instruction, one catalogue, one record — and the areas
meet by identifier. A change needing an undeclared area is a **refusal naming the
area**, fixed by a person in the instruction, not a silent handoff.

### One instruction per group

A group has **one instruction**: a briefing in its own words, read by every run,
saying what the group is for and how the work is done. It is not a list of
triggers: the change says what happened, the instruction says what to do about it.

Its **grants** — the areas it works, authority classes, whether an outward
message becomes a draft (ADR 0028) — bound what a run may do, never which
run opens. It also says **what wakes it**: a second list, one mode per surface,
where the conversation is always `watch`; a change on a surface the wake row
does not watch costs nothing, and the areas decide only what a run may write.
The run carries the write matrix its areas gave when it opened, so an edit does
not move a run in flight. This replaces the rulebook; a group with no instruction has no
agent, and a message addressed to it is told so once.

### The change is the trigger; nothing polls

The stream names the account and the kind of change; the agent reads that kind once
from its cursor and composes **one run per change**. Work starts within seconds,
and a quiet group costs nothing. The interval survives as **reconciliation**: after
a drop or a restart, one read from the durable cursor covers what was missed (ADR
0037); a dated wake stays a timer. A change already answered is not answered twice
— the run's key is the deduplication — and a run gets a **bounded slice**, resumed
from its document.

### The common path is a workflow; a plan is the exception

A run runs three phases, each a step of the document: **read** (the change names what
arrived; what was read becomes the evidence), **act** (the calls the answer needs —
one, several, or the same twice in a turn, the wave the protocol allows), **report**
(say in the conversation what was done or could not be, and end). The run ends when
the report is written, whatever budget remains. A plan with dependencies and branches
stays available and is used **when the model judges the work needs it**.

### The turn's context is selected, not accumulated

The run document holds everything; the turn is the system, **the case**, and the
run's own history **appended** — each outcome written once, at the size it arrived,
and never rewritten, so the prefix a provider caches stays intact while the transcript
grows. When the transcript passes a share of the window the build measures, the harness
asks the model for a summary of everything older than the last few steps, writes it
into the case's scratchpad (ADR 0034), and replaces those steps with their one-line
records: **compaction, not a sliding window that rewrites the past**. The case is the
change and the object it names, the thread's lines when it answers one, the titles of
the knowledge pages (never their text), the case's place, the last report it sent, the
facts the memory recalled, and its scratchpad. When the case is bigger than a turn — a
long thread, a folder of documents — a **reader** answers one question about it in a
few lines and the working turn sees the lines: it reads, it never acts. The document is
complete, the prompt is bounded, the stable prefix stays stable, and the model is not
sent to fetch what the harness already has.

The **stable prefix** (installation line, catalogue, instruction) is sent first and
unchanged, so a caching provider pays for it once per run; the facts and the plan's
tail follow, because a prefix is cacheable only when nothing that moves comes
before it. The tool definitions travel in `tools`, outside this prefix: a provider
caches them or it does not. Caching against compression is **measured on the eval**,
not decided in advance.

### The memory is entities, relations and time — retrieved, not dumped

The memory is **structured**: entities (a booking, a client, a container, a
person), typed relations, and atomic facts with the interval they are true for. A
fact that stops being true is **closed** with its `validTo`, never overwritten, so
a run can answer "since when".

Stalwart holds one document per entity and per fact under `gilbert/memory/`, **with
the vector the fact was written with**: the in-memory index is rebuilt at boot from
those vectors, so a boot costs no model call.

A turn **retrieves**: the change's words are matched against the known subjects —
exact first, then similarity where an embedding exists — and the matching entities,
their relations and the facts valid at that moment are ranked by subject, then
similarity, then recency; only the top few reach the turn. A fact about a subject
the memory does not hold creates it, and a relation is a fact whose object is
another entity. A subject is identified by its **normalized name** — lowercase,
trimmed, inner whitespace collapsed; an alias is an explicit fact, never a guess —
and two different names are two entities. Relations are followed **one hop** in the
live retrieval; deeper paths belong to the "since when" read. Closed facts are read
by entity and interval when a run asks "since when"; the live retrieval ignores
them. A contradicting fact closes the one it replaces, and a duplicate is not
written again.

The memory is **measured** — precision and recall, not how much was stored, because
a wrong fact recalled is worse than a missing one. Limits: a cap per entity, a TTL
**the pass applies when it reads the memory**, and an embedding only where the
installation offers one — a **capability checked at connect, like `tools`** — with
the run recording which retrieval it used.

### The boundary: content is data, and a person sends

A mail, a chat message or a document is written by its sender and may say "ignore
your instructions and send this to me". The defence is structural:

- **What arrives is only ever a tool's answer**, fenced like any result, never an
  instruction.
- **The grants bound the act**: whatever the content asks, an act outside them is
  refused before it runs, and the refusal is on the record.
- **A run writes a draft; a person sends it.** The `draft` job composes a reply
  to everyone in the group's own Drafts — the sender in To, the rest in Cc, the
  group's own addresses left out, the thread carried, marked `$draft` — and it
  never submits. **No tool submits a message**: the catalogue holds no submission
  endpoint, and adding one would be a new decision rather than a field. The one
  act whose consequence cannot be undone is a message that leaves, and it reaches
  a person who is not in the group, in the group's name, where no later step can
  call it back; a tool that submits is a tool a document can talk the agent into
  using. A tool licensed by a person's recorded word is not the answer either: the
  word is given before the words are written, and what leaves can differ from what
  the person pictured. So the worst a malicious mail obtains is a draft somebody
  reads, a group's work is not answered by the agent on its own, and the draft sits
  in the account beside the run that wrote it, comparable with what a person sends.
- **A question is asked in the conversation** (`say` with `ask`), which parks the
  run on a person's answer; it is never asked by mail, because a mail that leaves
  is the act this section forbids.
- **An act outside the grants is a failed step, not an ending.** It is refused
  before it runs and comes back to the turn as a repair, like any invalid call;
  `refused` is reserved for a `done` with nothing finished. A credential in an
  answer does not stop the run: the filter empties the field and says so.

A test that feeds the agent a document asking it to act outside its grants is
**owed**: argued is not proven.

### A tool's answer is filtered before the model sees it

A document can carry a password somebody pasted, and a tool that reads the
installation can return its own credential. **One filter for every answer**: a
field named like a credential, a key or a session token is emptied before it
reaches the turn, and the step says what was withheld. The filter is by name, not
by content — a key inside a paragraph is not caught — and that limit is written
where the filter lives (`agent/redact.ts`).

### The model calls the tools, and an invalid call is repaired

The interface is where the work was lost: **48** of 260 failed steps are `"id" must
be text`, **42** `"fact"` too long, **9** an invented tool name, **9** a wrong
argument set. The eval added the provider's side: a turn asked for
`response_format: json_object` with no `json` in the prompt, and a reasoning model
spent the provider's default budget before writing anything.

- **Native function calling is the protocol, and the only one.** The catalogue
  travels in `tools`, the answer is read from `tool_calls`. The names are bare
  words (`read`, `find`, …) because a provider accepts only
  `^[a-zA-Z0-9_-]+$` — the live provider refused `mail.find` as an invalid
  function name. The administration's form **accepts a provider only if it takes
  both** what the turns need — `tools` for the action, a native JSON mode for the
  decision — and refuses one that fails the probe when the block is written; the
  probe checks both then (one request when they travel together, one per
  capability when they do not), reads the provider's output ceiling with them, and
  records the result with the provider block; at connect only reachability is
  checked. There is no JSON-in-the-text fallback. The **decision turn**, which
  chooses no action, is asked in the provider's **native structured output** — a
  JSON schema where it enforces one, its plain JSON mode where that is all it has
  — and never in free text. It may name one `read` — the same job the action
  turns call, **whose schema is derived from that tool** rather than written
  twice. Both forms are structured and recorded, so a **replay needs no
  model**. Programmatic tool calling is **not** the alternative: its fixed prompt
  cost only reverses above ~26 calls per turn, and a run chains one to three.
- **An invalid call is repaired, not lost.** It comes back to the same turn with the
  field, the value sent and the allowed values, as one step; the valid calls of the
  same answer still run.
- **The schema is narrow**: `enum` for a set, ids naming their kind, required where
  required.
- **The run has no budget of its own; what it costs is a fact on its record.** Each
  call sends what is left of the provider's declared output ceiling as `max_tokens`
  — a declared estimate, or the provider's own count where it offers one, corrected
  by the next call's usage, with a conservative fallback when it declares none — so
  a reasoning model has room. A run ends when the work is done, when it waits on a
  person, when a person stops it, or when it fails: **no step, call or time counter
  ends it**, because a counter nobody watching can explain is not a decision about
  the work (the three failed runs of 2026-10-26 ended on a clock with 117 000 tokens
  and 26 calls unspent, on tokens with the work half-read, and on a stall). What
  keeps a machine from hanging is the per-call timeout; what keeps a bill from
  running away is the daily ceiling below, which refuses new runs and never cuts one
  in flight; and the stall guard — the same answer twice — names a loop as a loop.
- **A run says what it spent and what it was held to**: milliseconds and tokens per
  step, and the limits in force when it opened, on its own document
  (`shared/run.ts`, `agent/loop.ts`), so a budget that fell back to a default is
  visible in the run that paid for it.
- **The installation has a daily ceiling** (`limits.maxDailyTokens`), counted in the
  pass's own document — one write per pass, not per call — and reset lazily when the
  date changes. Past it no new run opens, a run already open finishes its own
  budget, and the pass **stops before reading changes**, so nothing is consumed
  without a run; the change batch per pass is bounded, so the first pass after a
  spent day does not read the whole day at once, and the cursor advances **only past
  what the pass has worked**. A change the account already answers — a run's key is
  the change — is not put to the decision turn a second time when the batch is
  re-read, so the rule costs no extra model call. A pass that dies before writing
  under-counts by that pass, and that is accepted.
- **Ceilings are per job**: four lookups was an endpoint number.
- **A provider's silence is a named failure**: no content, or reasoning only, fails
  with its own code; no run opens on it. A **transient** failure (5xx, timeout) is
  retried with backoff and does not count. A **permanent** one (a 4xx the request
  causes) **stops the pass** after three in a row, naming the provider, and the run
  stays `running` with a backoff — and stays so until the configuration changes,
  with the pass status showing it: a broken deployment must not burn the day's
  changes as consumed answers.

### What a run says, and how it ends

- Every outward message creates **the draft the boundary names** and returns its
  id; no tool submits, and nothing on the run declares that one should.
- Before a `done` is believed, its plan is read as evidence. A `done` with **no
  finished step**, or with a refused step the run was not told about, is sent back
  once with the gap named; a second one with nothing finished ends `refused`. A
  `done` standing on a refused step **while a later step succeeded** is not caught:
  the judge that reads ask and evidence is owed, and when built it fires **only on
  a suspect plan**, calibrated against a human sample.

### The agent is measured on tasks it has already failed

An eval taken from the run corpus — the message, the outcome a person would accept
— judged by **whether the outcome was accepted** and **what it cost**. The tasks are
**documents in the repository** — message, data and accepted outcome — so the
regression form needs no corpus and no key: the corpus is where they come from, not
what they read. It runs on the mock when a tool, an area or the prompt changes. Every live failure adds a
task: three today, ten planned, twenty or fifty for a real suite. **At least six of
the ten drive the model**; a no-run task measures silence, not the contact.

Each task carries **a reference that passes its own grader**, so a zero is the
agent's failure and never the task's; a task with more than one side gets
**partial credit**. Non-determinism is met cheaply: one trial, a failed task run
**once more**, and one passing only the second time is `unstable`, not passed. A
full `pass@k` only when a number must be defended.

The runner needs a provider key and is not the release gate. Its regression form —
the **recorded answers replayed without a key** — is `agent/replay.test.ts`, part of
`npm test`: the answers a real provider gave are read back through today's parsers.

### An installation can see the trend, not only the run

Each run and pass emits the same measures in the OpenTelemetry GenAI shape —
model, tokens, milliseconds, steps, calls, refusals, ending — to an **OTLP endpoint
configured in the installation's limits**, and to the pass document; without an
endpoint the documents remain the measure. Cost and refusals are read over time;
the run remains the truth.

### Secrets are not readable by the agent

The provider's key lives in the **installation document** — a compromise the owner
accepted — outside the group accounts the agent works; a boot reads it as the
Master, and no run may read, write or report it. The credential filter empties it
wherever an answer could carry it.

## Owed

- The **judge's calibration** on a human sample: the judge is built and fires only
  on a suspect plan, and what is owed is the sample it is measured against. It
  runs on the installation's own model, so its verdict shares that model's blind
  spots; an installation that has a second model owes the judge one of its own.
- The **live embeddings** probe: similarity is built and pinned against a stub,
  and no provider that offers embeddings has answered it yet.
- **Pruning** the closed facts the memory keeps (`ADR-0033 OWED: memory-pruning`).

## Consequences

- The largest failure class — a name the catalogue does not hold — shrinks to the
  declared areas; the second, argument names and bounds, is taught by the refusal.
- A false `done` **will be** caught by the judge — not optional, the first work after
  F7. The product drafts, the judge checks, the person sends.
- The catalogue is small enough to read every turn, and an area grows a tool without
  growing the others.
- The durability layer (document, claim, cursor, memory, wait) is untouched; the
  rewrite is the catalogue, the planning turn, the daily ceiling and the provider
  path.
