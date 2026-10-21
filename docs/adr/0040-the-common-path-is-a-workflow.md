# ADR 0040 — The common path is a workflow, and a plan is the exception

Status: Proposed

Implementation: Not built. Every run is planned by the model today
(`server/src/agent/loop.ts`, `chooseStep`), with a plan of steps, dependencies,
a budget of steps, calls and milliseconds.

## Context

The run is a document with a plan, dependencies and a budget — a shape built for
open-ended work. What the agent actually does is narrow: read what arrived, do the
one job the rule names, report. A live installation measured what the general
shape costs: plans of 34 entries, fourteen steps all refused, 308 and 329 seconds
for two runs where one call would have done, and a pass of 329 seconds that made
the other group wait.

The published experience is a distinction, not a preference: **workflows** — LLM
calls and tools orchestrated through code paths the product defines — are the tool
for work whose shape is known; **agents**, where the model directs itself, are for
work whose steps cannot be predicted. Complexity is added when it demonstrably
improves the outcome, not before.

The shape is known here. `mail.triage` is: read the message, decide inside the
tool, apply, report. That is three beats, and the product can own them.

## Decision

**A run's shape is the role's workflow, and the model decides inside a beat.**

The correspondence and documents role runs three beats, and each is a step of the
run document:

1. **Read** — the tool the change names reads what arrived: the message with its
   documents, or the document; the run records what it read as its evidence.
2. **Act** — the model chooses **one** act from the role's catalogue, given what
   the read found. A door that cannot be taken (a rule without the class) is not in
   the catalogue.
3. **Report** — the run says in the conversation what it did, or what it could not,
   and ends. A report is never optional.

The agenda and workflow role runs the same three beats over a dated commitment.

The run ends when its report is written, whatever budget is left: a workflow run
does not look for more work.
- A **plan** — several steps, dependencies, a branch that depends on how an earlier
  step ended — stays available and is used only when the rule declares it needs
  one. It is then exactly the document ADR 0030 describes, unchanged.
- The **budget** stays a ceiling, but it is the ceiling of the beat: a workflow run
  that has read and acted reports and ends, whatever is left; it does not spend
  the remainder looking for more work.
- A run that cannot finish inside its beat **says what it could not do** in its
  ending, in the conversation, rather than ending out of budget having said
  nothing useful.

## Consequences

- The class of failure "a 34-entry plan spent on refusals" cannot happen: there is
  no plan to spend, unless a rule asked for one.
- A run's duration becomes predictable, so a pass does not starve the other
  groups for five minutes.
- The run document keeps its plan field: a workflow run carries its three beats as
  steps, so the record and the surface read the same way they do for a planned run.
- A job that genuinely needs exploration (a research question) is the case the plan
  exists for, and a rule that wants it says so — the exception is chosen, never
  guessed by the model.

## The pass owns the clock, and the log is a session

Two mechanisms taken from the way long-running agents are built, and both come
from a failure this installation measured — a 329-second pass that made the other
group wait:

- **A run gets a slice of a pass, not the budget.** The pass gives each run a
  bounded piece of wall time (the same order as the pass cadence) and, when it is
  spent, writes the run where it stands and returns; the next pass resumes it from
  the document. A run that needs many calls takes many passes, and no other group
  waits for it. The budget of ADR 0030 stays the run's own ceiling, unrelated to
  the pass's clock.
- **The step question carries a slice of the run's log, chosen by the harness.** The
  run document is the session: every step, outcome, refusal and read is on it. The
  harness hands the turn a **bounded slice** — the last steps, the steps the plan
  waits on, and the ones whose outcome the next choice depends on — instead of the
  whole plan. A run whose plan grows does not grow its prompt, and the harness
  decides what is relevant rather than the model re-reading everything.
