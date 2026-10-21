# ADR 0042 — The agent is measured on tasks it has already failed

Status: Proposed

Implementation: Partly built, as evidence rather than as a mechanism. The
installation's 171 run documents and the journal are the first corpus (the
refusal classes, the false `done`, the out-of-budget runs quoted in ADR 0038–0041
were counted from them); no evaluation set exists, no metric is produced by a
check, and the gate runs none of this.

## Context

Every round of this agent has been judged by reading a live installation after the
fact: 260 refused steps, 67 false successes, seven identical calls in one plan. The
facts are good; the loop is not. A change is made, deployed, and the next
investigation measures it — which costs days and finds the same classes again.

The published practice is the opposite order: a set of tasks taken from real use,
each with a verifiable outcome, run against the tools before the tools are trusted;
and the metrics that matter are how often a task succeeds, how many calls it took
and how many failed on arguments.

## Decision

**The agent carries an evaluation set, and a change to its tools or its roles is
judged by it.**

- **The tasks are real.** Each is a change taken from the run corpus — the message,
  the promise made about it, and the outcome a person would accept ("this booking's
  documents are filed under its folder, and the group is told so") — with the
  fixture that reproduces it (ADR 0032's mock).
- **Two measures per task.** *Succeeded* (the outcome a person would accept) and
  *cost* (tool calls, refused calls, milliseconds). A task that succeeds by trying
  nine tools is a failure of the catalogue, not a success.
- **The verdict is a number, not an opinion.** A change to a role, a tool or the
  prompt reports the two measures against the same set, before and after.
- **It is not the release gate.** The gate judges the tree; this judges the agent,
  and it runs when the agent changes, on the mock, with no provider bill beyond the
  tasks themselves.
- The set grows by one task for every failure a live installation reports, so the
  same class is never measured as new twice.

## Consequences

- "It does not work" becomes a number with a name: which task, how many calls, which
  refusal.
- A catalogue that looks smaller but fails more tasks is caught before it ships.
- The corpus of 171 runs is the starting material, and the tasks in it are the ones
  the installation actually gets — not invented scenarios.
- A tool that no task uses is a candidate for deletion (ADR 0039), and a task that
  keeps failing names the tool or the role that is missing.
