# Plan — ADR 0038 in the tree

Status: **in progress**, branch `agents-reloaded`. The decisions are ADR 0038's;
this file holds only the order, the files each step touches, and what the step must
prove. F0 is written; F1–F7 are not built.

## Where the tree stands

Built: areas and their selection, one instruction per group, the change as trigger
with the run keyed by it, the one-off clear, the `done` read against its plan, the
credential filter, the eval runner. The eval's first two tasks pass; the third does
not, because the provider answers 400 on `response_format` and, when it does
answer, leaves the content empty (6 passes, 20 calls, 0 steps). The corpus and the
provider block live outside the repository.

## The order

| step | touches | done when |
|---|---|---|
| **F1 — the contact** | `model.ts`, `loop.ts`, `shared/installation.ts`, `shared/run.ts`, `routes/agent.ts`, admin limits | the third task passes through `tools`; the decision turn uses structured output; the provider's output ceiling is read at connect and caps every `max_tokens`; a provider without `tools`, or three failures of the same code mid-run, ends `refused` |
| **F2 — eight jobs** | `agent/tools/*`, `tools.ts`, `areas.ts`, fixtures | every one of the 45 endpoint tools has a home or is dropped; the guard reads `kind`/`action`; `read`, `find`, `say`, `remember` are always present; zero argument refusals |
| **F3 — repair** | `model.ts`, `loop.ts` | a plan with one bad and one good call leaves the good one on the record |
| **F4 — the measure** | `eval.ts` | ten tasks, each with a reference; at least six drive the model; partial credit; retry of failures; `pass@1` and cost printed |
| **F5 — context** | prompt builder, step projection | the threshold is measured; the summary is deterministic and the prompt's order is fixed; a long run costs less than with the whole plan |
| **F6 — trend** | run and pass documents, admin view | cost and refusals readable over a week, through OTLP when configured and the documents otherwise |
| **F7 — memory** | `memory.ts`, `shared/memory.ts`, memory tools | a superseded fact is closed and not recalled; the pass applies the TTL; precision and recall measured |

**F1 comes first** because nothing is measurable until a turn produces an answer.
F2 depends on F1's request shape (the schema is the interface); F3 needs F1; F4
needs F1–F3 to have something to measure.

## The risk F1 will settle

The installation's provider is Deepseek. If it refuses `tools` with this payload,
the probe refuses it and the deployment must move to a provider that accepts them.
That is a product decision, not a bug to work around.

## The owed, after F7

The judge on the evidence, the injection test, the CI replay, and the alignment of
`ROADMAP.md`, `KNOWN-ISSUES.md`, `FEATURES.md` and `README.md` (ADR 0038, *Owed*).

## Open decisions, with a proposal

- `limits.maxRunTokens`: **120 000**.
- `limits.maxDailyTokens`: **2 000 000**.
- Probe cost: one tool-carrying call per provider session, cached until the
  provider configuration changes.
