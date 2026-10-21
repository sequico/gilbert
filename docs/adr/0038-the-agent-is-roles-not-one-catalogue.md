# ADR 0038 — The agent is roles, not one catalogue

Status: Proposed

Implementation: Not built. The loop still hands one catalogue of forty-five tools
to one free-form planner (`server/src/agent/loop.ts`, `model.ts`); what this
record replaces is that shape, and the run document, the claim, the cursors, the
single wait and the endings stay as they are.

## Context

The installation's agent is one process with one catalogue and one planner. A live
installation measured what that costs: **260 refused steps across 94 of 171 runs
(55%)**, **67 of 132 runs that ended `done` had refused a step** before claiming
success, **20 runs ended out of budget**, and **no run ever parked on a person**.
The refusals are dominated by tool misuse — nine invented mail tool names, a
mailbox id where a message id belongs, argument names no tool takes — and by
repeated calls (`files.list` seven times in one plan).

The published experience on agent tooling says the same thing from the other side:
more tools do not make better agents, the common failure is wrapping an API one
endpoint at a time, and sixty per cent of the work is the interface between the
model and the actions. The agent's work is not "call JMAP": it is **correspondence
with documents**, **agenda and workorders**, **answering in the conversation** —
and each of those is a different job with a different vocabulary.

The conversation is not one of those jobs. It is how the people of a group reach
the agent, and the knowledge base is not a job either: it is what every job may
consult and add to.

## Decision

**A run belongs to one role, and a role holds its own catalogue.**

- **Correspondence and documents** — mail and files together, because a message
  and the paperwork it carries are one piece of work: read the mail, file what it
  brings, answer it, label it.
- **Agenda and workflow** — the calendar and the workorders, because both are
  commitments with dates and owners.
- **Knowledge is transversal** — the KB is readable and writable by every role, and
  never a role of its own: the question "what do we know about this?" arises inside
  another job.
- **The conversation is the interface, not a role** — replying, asking a person and
  reporting are available to every role, and are the only way a run speaks.

The role of a run is **declared by the rule that opened it**, from the surface the
change arrived on and the surfaces the rule wrote: the rule already carries that
matrix (ADR 0031), so the role is read, never inferred by the model. A change on a
surface no role covers opens no run and gets the notice it is owed.

`chooseStep` hands the model **the catalogue of the run's role** — that role's
tools, the transversal reading tools and the conversation tools — and nothing
else. The forty-five become a handful per role.

## Consequences

- A run cannot name a tool of another role, so the largest measured class of
  refusals (a name the catalogue does not hold) shrinks to the role's own
  vocabulary; the catalogue line the turn reads (ADR 0027) lists only what it may
  call.
- The rule document becomes the router: a rule that watches mail and writes files
  is the correspondence role, and the group chooses its roles by the surfaces it
  gives its rules. A rule spanning two roles is refused at save time rather than
  discovered at run time.
- One model call sees a smaller prompt, so a quiet pass costs less and a busy
  installation pays less per step.
- The Knowledge base and the conversation keep one definition each, imported by
  every role: a role cannot grow a private copy of "say this in the chat".
- The run document does not change: `startedBy.rule` already names the rule, and
  the rule names the role.
