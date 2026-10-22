# Plan — ADR 0038 in the tree

Status: **in progress**, branch `agents-reloaded`. The decisions are ADR 0038's;
this file holds only the order, the files each step touches, and what the step must
prove. F0 is written; F1–F7 are not built.

## Where the tree stands

Built: areas and their selection, one instruction per group, the change as trigger
with the run keyed by it, the one-off clear, the `done` read against its plan, the
credential filter, the eval runner. The eval's first two tasks pass; the third was
**last measured failing** (6 passes, 20 calls, 0 steps) before the `Answer in JSON`
sentence now in `model.ts`, and has not been re-measured since. The provider block
lives outside the repository; the eval tasks live in it.

## The order

| step | touches | done when |
|---|---|---|
| **F1 — the contact** | `model.ts`, `loop.ts`, `changes.ts`, `shared/installation.ts`, `shared/run.ts`, `routes/agent.ts`, admin limits and provider form | the third task passes through `tools`; a provider is refused when its block is written unless it carries `tools` and structured output, with reachability at connect; the output ceiling is read with the capabilities and caps every `max_tokens`; transient failures back off, permanent ones stop the pass; a spent day reads nothing, the cursor advances only past what was worked, and one pass takes a **bounded batch** (a bound `changes.ts` does not have today) |
| **F2 — eight jobs** | `agent/tools/*`, `tools.ts`, `areas.ts`, fixtures | every one of the 45 endpoint tools has a home or is dropped; each schema shows only the allowed `kind`/`action`; `read`, `find`, `say`, `remember` are always present; zero argument refusals |
| **F3 — repair** | `model.ts`, `loop.ts` | a plan with one bad and one good call leaves the good one on the record |
| **F4 — the measure** | `eval.ts`, `agent/eval/tasks/` | ten tasks **in the repository**, one file each with its message, data and reference; the runner passes the **same**
provider check as the product, not a relaxed one; at least six drive the model;
partial credit; retry of failures; `pass@1` and cost printed |
| **F5 — context** | prompt builder, step projection | the threshold is measured; the last steps in full and earlier ones one line each, no summary call; a long run costs less than with the whole plan |
| **F6 — trend** | run and pass documents, admin view | cost and refusals readable over a week, through OTLP when configured and the documents otherwise |
| **F7 — memory** | `memory.ts`, `shared/memory.ts`, memory tools | a superseded fact is closed and not recalled; an entity is created by its first fact; retrieval is exact then similarity where an embedding exists; the pass applies the TTL; precision and recall measured |

**F1 comes first** because nothing is measurable until a turn produces an answer.
F2 depends on F1's request shape (the schema is the interface); F3 needs F1; F4
needs F1–F3 to have something to measure.

## The risk F1 will settle

The installation's provider is Deepseek. If it lacks **either** `tools` or the
structured output, it cannot be selected and the deployment must move to a provider
that carries both. That is a product decision, not a bug to work around — and it is
settled at the first probe, not after the catalogue is rewritten.

## The owed, after F7

The judge on the evidence, the injection test, the CI replay, and the alignment of
`ROADMAP.md`, `KNOWN-ISSUES.md`, `FEATURES.md` and `README.md` (ADR 0038, *Owed*).
The **judge comes first**, right after F7: it is not optional.

## Open decisions, with a proposal

- `limits.maxRunTokens`: **120 000**.
- `limits.maxDailyTokens`: **2 000 000**.
- Probe: the two capabilities are checked **when the provider block is written** (one
  request if they travel together, two if not), and the output ceiling is read with
  them; at connect, reachability only.
