# Plan — the agent's interface, proved

Status: **proposed**, not started. The decisions are ADR 0038's (`agent/tools/jobs.ts`,
one instruction per group, the run as the record), 0030's (the run document) and
0041's (an outward message is a draft); this file holds only the order, the files
each unit touches, and what the unit must prove. Nothing here adds a dependency,
changes the run document, or designs a new capability.

## Why this plan exists

A live installation measured what an interface costs: **260 refused steps across 94
of 171 runs**, one run of 308 seconds spent on fourteen refused calls, and **no run
ever parked on a person** (ADR 0038, *Context*). The tree answered the first two —
eight jobs instead of forty-five, one schema branch per value, a refusal that names
the nearest real tool and what the catalogue holds, and the refused call recorded
as a failed step beside the valid ones that ran. What is still missing is not
mechanism but **proof**: the interface rules are not written once, the recovery a
refusal is supposed to cause is not measured, and the parking that was measured as
never happening has no eval task. This plan closes those three, in that order.

## 0 — The measure, before anything changes

- **Add** nothing. **Delete** nothing.
- **Prove** the starting point by running the eval on the current tree
  (`server/src/agent/eval.ts`, ten tasks) and recording in the commit message:
  `pass@1`, tokens, model calls, seconds, and the per-task `refused=` the report
  already prints. Those numbers are what the units below must beat; without them
  "the interface is better" is a claim with no score.

## 1 — The interface rules are written once, and a test holds the tree to them

The rules that made the eight jobs work are today scattered across comments in
`tools/jobs.ts`, `model.ts` (the doubled catalogue, the repair) and `loop.ts` (the
refusal as a step). They are the thing that keeps a ninth job from becoming the
forty-fifth, so they get one home and one check.

- **Add** a short section to `agent/tools/jobs.ts`'s header (the catalogue's own
  file, beside the eight) stating the rules the tree already follows: a job's name
  is one lowercase word and contains no dot (the provider's `^[a-zA-Z0-9_-]+$`);
  one verb, one meaning; a call is chosen by one discriminator whose every value
  appears in the tool's own description; each value carries its own schema branch,
  so an argument of another route is refused before the step is paid for; a
  refusal names the valid values **and** the nearest real name; a tool answers a
  distillation, never the payload.
- **Add** `server/src/agent/tools/aci.test.ts`: one test per rule, over the eight
  jobs as they are built — the name pattern, the discriminator's values each
  present in the description and each with a schema branch, `narrow` never
  renames a job, and every refusal from `args.ts`'s readers and `routeOf` naming
  the accepted values.
- **Delete** nothing. **Prove** each test fails when its rule is broken: a job
  renamed `mail.find`, a value added to a route and not to the description, an
  argument hidden from one branch, a refusal that says only "bad arguments".

## 2 — The refusal that teaches is measured where it is paid for

The mechanism is built and pinned (`model.test.ts`, "a call the catalogue does not
hold is refused alone", and the "nearest real name" the refusal carries). What is
not measured is the only thing that matters about it: **whether the next call is
right**. A refusal that costs one step and is recovered is the design working; a
refusal that repeats is the old failure coming back.

- **Add** to `RunMeasure` in `eval/task.ts` a second count beside `refused`: the
  refusals **recovered** — a refused step followed, in the same run, by a call the
  catalogue kept — and print it in `eval.ts`'s per-task line. A task therefore
  reads `refused=2 recovered=2`, and a run where the two differ is the regression
  this plan exists to catch.
- **Add** an invariant test in `eval/task.test.ts` over two run documents — one
  that recovered and one that repeated the same invented name — so the counter
  cannot be quietly changed to count something else.
- **Delete** nothing. **Prove** the two documents score differently; a task with
  no refusal reports `recovered=0` rather than nothing.

## 3 — A run parks on a person, and continues on the answer

`say` with `action: ask` parks the run `blocked`, `runAwaiting` continues it on the
person's answer, and `loop.test.ts` pins it. That is the mechanism. What was
measured on the live installation is that **it never happened**, and no eval task
asks for it — so the one behaviour the design calls normal is the one with no
measure.

- **Add** `server/src/agent/eval/tasks/parked-until-answered.ts`: an instruction
  that says ask before doing anything irreversible; a message that requires a
  choice only a person can make; grade `1` when the run is `blocked` with a
  question in the conversation and the account is otherwise untouched, `0.5` when
  the question is asked but the run also acted, `0` when it acted instead of
  asking. A second phase posts the person's answer and grades the run continuing
  to its report.
- **Add** the phase to `eval/task.ts`'s harness (one optional `answer` hook, run
  after the first grade) — the smallest shape that lets a task have two halves.
- **Prove** the task fails on a tree where `ask` reports instead of parking, and on
  one where a `blocked` run releases itself with no answer.

## 4 — The documents follow the tree

- **Add** to `FEATURES.md`'s agent section the two facts a reader acts on: the
  interface rules of unit 1 (one sentence each, in the section that describes the
  eight jobs) and that a run may park on a person and continue on the answer.
- **Add** to ADR 0038's `Implementation` line `tools/aci.test.ts`, the recovered
  count and the parked task, once unit 3 lands.
- **Delete** nothing. **Prove** a grep for the eight job names in `FEATURES.md`
  finds them, and no document claims the eval has ten tasks once there are eleven.

## Order, and what closes this plan

0 → 1 → 2 → 3 → 4. Unit 1 is design written down and can land alone; unit 2 makes
the interface's cost visible per task; unit 3 is the only unit that needs new
harness shape; unit 4 is prose and lands last, because a document written beside
code still in flight describes work, not the tree.

The plan closes when the eval prints a recovered count, its eleven tasks include
one that parks and continues, and `npm run check:ci` is 0/0/0 on the tree that
carries them.

## What this plan deliberately does not do

- **No dependency.** The scorecard and the rule that decides any of them are in
  `ROADMAP.md`, marked to evaluate; nothing here adopts one.
- **No change to the run document, the claim or the budget.** The interface is
  what costs, and the interface is what this plan changes.
- **No ninth job.** A job nobody's eval and nobody's instruction needs is not
  written; unit 1 makes that rule checkable rather than a habit.
- **No second model and no streaming.** Both are separate decisions, listed in
  `ROADMAP.md` and ADR 0038's *Owed*.
