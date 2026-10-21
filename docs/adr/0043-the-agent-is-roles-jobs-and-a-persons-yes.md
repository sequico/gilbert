# ADR 0043 — The agent is roles, jobs, and a person's yes

Status: Proposed

Implementation: Not built. The loop today hands one catalogue of forty-five
endpoint tools to one free-form planner (`server/src/agent/loop.ts`,
`model.ts`); this record replaces that shape. The run document, the claim, the
cursors, the single wait, the endings, the authority classes and the memory stay
as they are.

## What this replaces, and what it keeps

**Replaced:** ADR 0027 in full (one catalogue, the model as its own planner, the
whole-answer refusal) and the five records written beside it on 2026-10-21
(0038–0042), which are withdrawn as separate decisions and carried here.

**Kept, unchanged:** ADR 0028 (authority classes), 0029 (a question parks the run;
a person answers), 0030 (the run is a document and the record is the product),
0031 (a group's rules and their surface matrix), 0032 (one process holds the
claim), 0033 (the memory), 0034 (a batched drop), 0037 (the reading cursor).

ADR 0030's plan-as-the-normal-shape is amended in place: the common path is the
workflow below, and a plan is what a rule asks for.

## Context

A live installation measured what one catalogue and one planner cost: **260
refused steps across 94 of 171 runs (55%)**, **67 of 132 runs that ended `done`
had refused a step** before claiming success, **20 runs ended out of budget**, one
run spent **308 seconds** on fourteen refused steps, one pass of **329 seconds**
made another group wait, and **no run ever parked on a person**. The refusals are
tool misuse: nine invented mail tool names, a mailbox id where a message id
belongs, `chat.say` called with `conversation` and `message`, `files.list` seven
times in one plan.

The practice elsewhere says the same as the measurement: more tools do not make a
better agent, the common error is wrapping an API one endpoint at a time, the model
should see a distillation rather than raw payloads, a known shape belongs in a
workflow rather than in a free plan, and what leaves should wait for a person.

## Decision

### The work is two roles, one interface, one shared library

- **Correspondence and documents** — mail with files: read the message, file what
  it brought, label it, answer it. One job, because a message and its paperwork are
  one piece of work.
- **Agenda and workflow** — the calendar with the workorders: commitments with
  dates and owners.
- **Knowledge is transversal** — readable and writable by both roles, never a role
  of its own.
- **The conversation is the interface**, not a role: saying, asking and reporting
  belong to every run.
- **The role is read from the rule** (ADR 0031's surface matrix), never inferred by
  the model: mail or files → correspondence; calendar or workorder → agenda. A rule
  naming both is **refused when saved**, with the sentence that says why.

A run is handed the catalogue of its role plus the transversal tools, and nothing
else.

### Tools have the shape of the job, not of the endpoint

- **Correspondence and documents:** `mail.triage` (read, decide, label, move, file
  the documents under the booking's folder, report), `mail.reply` (a draft),
  `mail.search`, `mail.read`, `files.search`, `files.read`, `files.write`,
  `files.remove`.
- **Agenda and workflow:** `calendar.find`, `calendar.read`, `calendar.schedule`,
  `calendar.cancel`, `workorder.list`, `workorder.read`, `workorder.settle`.
- **Transversal:** `knowledge.search/read/write`, `memory.remember/list`,
  `chat.say/ask/find/read`, `tool.describe`.

A sequence the job implies lives **inside** the tool that names the job: filing a
booking's documents is part of reading that mail, not a second tool to chain.

**Every argument says which kind of thing it is** — `message_id`, `mailbox_id`,
`node_id`, `event_id`, `run_id` — in its name and in its catalogue line, and a
refusal carries the catalogue's real names and a valid example. A bound the
provider ignores is stated in words beside the schema.

**A tool returns a distillation, never the payload.** The message, the attachments
and the folder listing stay in the account; the model is told what happened and
what id to use next.

**Progressive disclosure:** the turn sees the role's tools as signatures (name,
arguments, kind, bound) and asks `tool.describe` for the full definition of one it
means to call.

**No code execution, by decision.** The benefit it buys elsewhere is bought here by
the job-shaped tool, without an execution environment — and the installation is a
container with no writable filesystem (ADR 0027).

### The common path is a workflow; a plan is the exception

A run of either role runs three beats, each a step of the document:

1. **Read** — the tool the change names reads what arrived; what it read becomes the
   run's `evidence`.
2. **Act** — the model chooses **one** act from the role's catalogue given what the
   read found.
3. **Report** — the run says in the conversation what it did or what it could not,
   and ends.

The run ends when the report is written, whatever budget remains. A plan with
dependencies and branches stays available and is used only when the rule declares
it needs one.

**The pass owns the clock.** A run gets a bounded slice of a pass and returns when
it is spent; the next pass resumes it from the document. No group waits for another
group's run.

**The log is a session.** The run document is the append-only record; the harness
hands each turn a **bounded slice** of it — the recent steps, the ones the plan
waits on, and the ones the next choice depends on — instead of the whole plan.

### What leaves waits for a person, and the ending is judged

- `mail.reply` and every outward message **create a draft** and return its id; no
  tool submits. The run records the draft as its outcome and evidence, and its
  ending says it is waiting.
- `startedBy.sends` is the rule's declaration that a draft is wanted, not a licence
  the model reads.
- Before a `done` is believed, a second cheap call is given the ask
  (`startedBy.about`), the plan with each step's state and the `evidence`, and
  answers whether the work covers the ask or names what is missing. A "missing"
  answer sends the run back once with the gap named; the second `done` stands and
  the judge's sentence is written on the ending. A `done` with no evidence is
  refused without spending a call.

### The agent is measured on tasks it has already failed

An evaluation set taken from the run corpus — the message, the promise, the outcome
a person would accept — judged by two measures: **the outcome was accepted** and
**what it cost** (calls, refusals, milliseconds). It is run when a tool, a role or
the prompt changes, on the mock, and is not the release gate. Every live failure
adds a task.

### Secrets are not readable by the agent

The provider's key and every credential live outside the documents the agent can
read; a boot reads them from its environment, and no run may read, write or report
one. The installation document stops carrying a key.

## Consequences

- The largest measured failure class — a tool name the catalogue does not hold —
  shrinks to a role's own vocabulary; the second largest (argument names and
  bounds) is answered by names that say what they are and by errors that teach.
- A run's duration becomes predictable and a pass stops starving the other groups.
- A false `done` can no longer leave the installation unheard: the product drafts,
  the judge checks, the person sends.
- The catalogue is small enough to read on every turn without paying for the whole
  company's API surface, and a role can grow a tool without growing the others.
- The record keeps its shape: a workflow run carries its three beats as steps, so
  every surface that reads a run reads the same fields.
- The cost of the redesign is a rewrite of the tool catalogue and of the loop's
  planning step; the durability layer (document, claim, cursor, memory, wait) is
  untouched, which is why the rewrite is affordable.
