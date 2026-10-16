# ADR 0034 — A run is a document, and the record is the product

Status: Accepted

Implementation: Not built. The run document and the re-arm of its waits are to be
written with the agent; the records a run writes next to a person's already exist
— a workorder step's `state`/`by`/`at`/`note` (`server/src/shared/workorder.ts`)
and a KB page's revisions (ADR 0024).

## Context

Gilbert's name ends in Enterprise Resource **Traceability**: the record is what a
company is buying. Its intent lives in the KB and the workorders and people write
it; what an agent does has to be as durable, as readable and as attributable as
what a person does, or the record is true of only half the work. The process, in
the meantime, is disposable by law: the container may vanish between two steps of
a run.

## Decision

**A run is a document in the group's account**, and it is the whole of the
agent's durable state.

- It carries which rule or which instruction started it, the plan (the steps the
  model chose, or the rule declared), the outcome of each one, what it is waiting
  for and until when, every authorisation with the message it arrived in, and the
  evidence behind every claim.
- **A wait is a date in the run**, not a timer in a process. On boot the agent
  re-arms the waits it finds, so a restart in the middle of a run loses nothing
  and a container that dies is not an incident.
- **A run ends in one of three ways** — the work is done, it is blocked on a
  person, or its budget (ADR 0031) is spent — and its ending is written down, so a
  run that stops says why.
- **A person can read a run** and undo by hand what can be undone: it names what
  it touched, and the objects themselves are Stalwart's.
- **What the agent settles goes into the record that carries the work**: a
  workorder step changes state with the agent as its signer and the evidence in
  its note; a KB change is a proposal awaiting approval (ADR 0024).
- **An unreadable run is a defect**, and the agent says so rather than guessing at
  what it meant.

## Consequences

- There is no separate audit ledger and no per-action journal: the run is the
  ledger and the workorder is the record of the work. An accounting of its own
  has nothing to count that these do not.
- Reading a company's history is reading its own documents — which is also what
  makes the agent's proposals (ADR 0032, ADR 0024) rest on something real: it
  learns a practice from the work that is already written down.
- A run is a stored document, so its shape is versioned and a change to it is a
  change to what installations have already written.
- The trace is the product's answer to "what did it do, why, and who allowed it" —
  which is what makes an override, a reopen or a refused step auditable rather
  than merely asserted.
