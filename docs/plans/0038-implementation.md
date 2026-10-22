# Plan — ADR 0038 in the tree

Status: **in progress**, branch `agents-reloaded`. The decisions are ADR 0038's;
this file holds only the order, the files each step touches, and what the step must
prove. F0–F7 are built.

## Where the tree stands

Built: areas and their selection, the eight jobs and their narrowing, one
instruction per group, the change as trigger with the run keyed by it, the one-off
clear, the `done` read against its plan, the repair of an invalid call, the
credential filter, the native protocol with the provider probe at publish, the two
token ceilings, and the eval: ten tasks in the repository (`agent/eval/tasks/`),
one file each with its message, data and reference, seven of them driving the
model, partial credit on a task with more than one side, a failed task retried
once, `pass@1` and cost printed, and the provider put to the product's own probe
before anything is measured.

**The eval reads 9/10 on the first attempt**, measured on the installation's own
provider on 2026-10-22 (`deepseek-flash`, plain JSON mode): one task answers only
on the retry (`unstable`), and the measure costs 133 685 tokens, 33 model calls
and 46 s. What made the earlier three-task eval pass still holds:
the eight dot-free job names (the provider refused `mail.find`: a function name
matches `^[a-zA-Z0-9_-]+$` only), one schema branch per value, room for a
reasoning model's answer, one lookup in the decision turn, and the report ending
the run. The measure found two frictions a person meets, and both are closed: the
decision turn sometimes answers a **mail** change in prose, which is not a
decision — the run now opens with no facts and reads the change itself, instead of
the change being re-read for ever; and the model reaches for the folder **id**
`find` answered, which `place file` now accepts beside the name and the role. The
provider block lives outside the repository.

The loop and model suites speak the jobs' protocol: a call is a bare job name,
`say` with an `action` is the report that ends the run, and a dependency is a
second answer rather than a `needs` field.

**F7 landed as ADR 0038 states it** (`shared/memory.ts`, `agent/memory.ts`,
`agent/tools/memory.ts`): entities under `memory/` with a normalized name and
aliases only as explicit facts; facts with `validFrom`/`validTo`, a contradiction
closing the one it replaces and a duplicate not written; retrieval by exact
subject, then similarity, then recency, one hop for relations, with the vectors
the facts were written with carried in their documents and the index rebuilt at
boot without a model call; the TTL applied at the pass's read; the "since when"
read by entity and interval, reached through `read` with `kind: memory`; the
embeddings capability probed with the provider's others and `retrieval` recorded
on the run; a per-entity cap; precision and recall measured on a corpus in the
repository (`agent/eval/memory.ts`). A v3 sheet is read as an entity and an `is`
fact and is rewritten as this version by the next fact about it, so an existing
installation loses nothing. The `remember` job's fact takes `entityKind`,
`predicate` and `object` instead of `links`, and `standing` is gone with the
group-scoped set — a group's conventions are its instruction's.

**The threshold is measured** (`prompt.ts`, `prompt.test.ts`): a forty-step run
whose steps answered three kilobytes each is 120 110 characters of outcome, and
the turn is handed 23 064 of them — the last three steps whole, every earlier one
as a 240-character beginning — 19% of the whole plan, and twenty more steps add
one line each rather than three kilobytes each. No model call writes the summary;
the run document holds every outcome in full.

## The order

| step | touches | done when |
|---|---|---|
| **F1 — the contact** | `model.ts`, `loop.ts`, `changes.ts`, `shared/installation.ts`, `shared/agent.ts`, `installationAdmin.ts`, `routes/agent.ts` | the third task passes through `tools`; a provider is refused when its block is written unless it carries `tools` and a native JSON mode, with reachability at connect; the output ceiling is read with the capabilities and caps every `max_tokens`; transient failures back off, permanent ones stop the pass; a spent day reads nothing, the cursor advances only past what was worked, and one pass takes the batch `changes.ts` already bounds (`CHANGES_PER_PASS`) |
| **F2 — eight jobs** | `agent/tools/jobs.ts`, `tools.ts`, `areas.ts`, `define.ts`, fixtures | every one of the 45 endpoint tools has a home or is dropped; each job shows only the `kind`/`action` its run's areas allow; `read`, `find`, `say`, `remember` are always present; zero argument refusals |
| **F3 — repair** | `model.ts`, `loop.ts` | a plan with one bad and one good call leaves the good one on the record |
| **F4 — the measure** | `eval.ts`, `agent/eval/tasks/` | ten tasks **in the repository**, one file each with its message, data and reference; the runner passes the **same**
provider check as the product, not a relaxed one; at least six drive the model;
partial credit; retry of failures; `pass@1` and cost printed |
| **F5 — context** | prompt builder, step projection | the threshold is measured; the last steps in full and earlier ones one line each, no summary call; a long run costs less than with the whole plan |
| **F6 — trend** | run and pass documents, admin view | cost and refusals readable over a week, through OTLP when configured and the documents otherwise |
| **F7 — memory** | `memory.ts`, `shared/memory.ts`, memory tools | a superseded fact is closed and not recalled; an entity is created by its first fact; retrieval is exact then similarity where an embedding exists; the pass applies the TTL; precision and recall measured |

**F1 came first** because nothing is measurable until a turn produces an answer.
F2 depended on F1's request shape (the schema is the interface); F3 needed F1; F4
needs F1–F3 to have something to measure.

## The risk F1 settled

The installation's provider is Deepseek. It carries `tools` and the plain JSON mode
and refuses a JSON schema (`response_format.type: json_schema` answers 400), so a
provider is selectable on `tools` + a native JSON mode, and the decision turn uses
the schema where a provider enforces one and its JSON mode where that is all it has.
If the owner wants a schema strictly enforced, the deployment moves to a provider
that carries it; the probe already reports which mode it found.

## The owed, after F7

The judge is built (it fires only on a suspect plan), the injection test is in
`loop.test.ts`, the replay runs in `npm test` (`agent/replay.test.ts`) and the
documents are aligned. What remains: the judge's **calibration** on a human
sample, the **live embeddings** probe, and the pruning of closed facts
(ADR 0038, *Owed*).

## Open decisions, taken

- `limits.maxRunTokens`: **120 000**.
- `limits.maxDailyTokens`: **2 000 000**.
- Probe: the two capabilities are checked **when the provider block is written** (one
  request if they travel together, one per capability if not), and the output ceiling
  is read with them; at connect, reachability only.
