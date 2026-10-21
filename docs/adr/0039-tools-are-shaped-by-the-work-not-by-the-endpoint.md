# ADR 0039 — Tools are shaped by the work, not by the endpoint

Status: Proposed

Implementation: Not built. The catalogue today is a one-to-one wrapper of the
mail server's endpoints (`server/src/agent/tools/mail.ts`, `files.ts`,
`calendar.ts`, `contacts.ts`, `chat.ts`, `memory.ts`, `knowledge.ts`,
`workorders.ts`, `runs.ts`), and every argument is a bare JSON value.

## Context

Forty-five tools exist, and the measured failures are argument failures: **48
times** a tool refused because `"id"` was not text, **42 times** because a `fact`
was over its bound, nine times because a mail tool was invented, and the rest are
argument names no tool takes (`conversation`, `message`, `messageId`, `to`,
`chat`). One plan spent seven identical `files.list` calls, because listing a
folder, filing what was found and reporting it are three steps the model had to
compose itself at every turn.

The interface an agent reads is half of what it can do. Wrapping an API one
endpoint at a time is the named anti-pattern: the model is asked to be a
programmer of the API instead of an actor with a job. A tool named after the work
— "file the attachments of this booking" — carries the sequence inside it, so the
model chooses **what** to do and not **how to chain it**.

## Decision

**A role's tools are named after its jobs, and each carries the sequence the job
needs.**

- **Correspondence and documents** (from 45 to eight): `mail.triage` — read the
  message the change names, decide, and apply what the decision says: label it,
  move it, file the documents it brought under the booking's folder, report.
  `mail.reply` (a draft, never a send — ADR 0041), `mail.search`, `mail.read`,
  `files.search`, `files.read`, `files.write` (create or replace a document at a
  path, making the folders it needs), `files.remove`.
- **Agenda and workflow**: `calendar.find`, `calendar.read`, `calendar.schedule`
  (create or update an event with its reminders), `calendar.cancel`,
  `workorder.list`, `workorder.read`, `workorder.settle`.
- **Transversal, in every role**: `knowledge.search`, `knowledge.read`,
  `knowledge.write`, `memory.remember`, `memory.list`, `chat.say`, `chat.ask`,
  `chat.find`, `chat.read`, and `tool.describe` for progressive disclosure (below).

A sequence the job implies lives **inside** the tool that names the job. Filing the
documents of a booking is part of `mail.triage` because it is part of reading that
mail; it is not a second tool the model has to chain after the first.

A sequence the job implies lives **inside** the tool that names the job. Filing the
documents of a booking is part of `mail.triage` because it is part of reading that
mail; it is not a second tool the model has to chain after the first.

Every argument states **which kind of thing it is**, in its name and in its line of
the catalogue: `message_id` is a message, `mailbox_id` a folder, `node_id` a
document, `event_id` an event, `run_id` a run. A tool that takes two of them names
both, so "a mailbox id where a message id belongs" is not expressible.

An argument that takes a bounded value states the bound **in words** beside the
schema, and a refusal carries **the catalogue's own names and an example of a
valid call** — the error is the repair, not a verdict.

## Consequences

- The number of choices per turn drops from forty-five to a handful, which is what
  the measured refusal rate is made of.
- A job that needed three steps now costs one call: the redundant listings the
  model produced by hand disappear because the tool does the chaining.
- The tools that write are fewer and larger, so the authority guard (ADR 0028)
  reads a class per **job** rather than per endpoint: filing a booking's documents
  is one authorisable act.
- A finer operation the model genuinely needs (trashing one message without
  triaging) is a missing tool, discovered by the evaluation set of ADR 0042, not a
  step to be assembled from parts.
- The catalogue line stays the one rendering (ADR 0027): the tool's `args`, its
  names and its bounds.

## What a tool returns, and what the model is shown

Copied from the practice that made agents survive many tools, and it is the second
half of the decision above:

- **A tool returns a distillation, never the payload.** `mail.triage` answers
  "filed 3 documents under the booking, labelled it, the sender is X" and keeps the
  message, its attachments and the folder listing in the account, where the next
  tool can reach them by id. A tool that returns two hundred nodes and lets the
  model read them is the same cost the model was paying to chain calls by hand.
- **Progressive disclosure.** The turn sees the role's tools as **signatures** (the
  name, its arguments, their kinds and bounds) and asks for a tool's **full
  definition** only when it intends to call it: `tool.describe(name)` answers that
  one line in full. A role of eight tools does not need this; the day a role grows,
  the mechanism is already there instead of the catalogue being cut again.
- **No code execution, by decision.** Running generated code is the other way to
  keep intermediate results out of the context, and it buys its own sandbox,
  resource limits and monitoring. The same benefit is obtained here by putting the
  sequence inside the tool that names the job, which costs no execution
  environment — and the installation's law is a container with no writable
  filesystem (ADR 0027).
