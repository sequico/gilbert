# Plan — ADR 0038 in the tree

Status: **in progress**, branch `agents-reloaded`. The areas, the instruction, the
change as trigger, the guard and the eval runner are built. **F0 is written; F1–F7
are decided and not built.** Each step lands on its own, with its tests, and the
gate (`npm run check:ci`) runs once, at the push.

The order below is the order of dependency, not of taste: **F1 first**, because
nothing else can be measured until a turn produces a usable answer against the
installation's provider.

## Where the tree stands

- Areas and their selection (`server/src/agent/areas.ts`), one instruction per
  group (`instruction.ts`, panel `GroupInstruction.tsx`), the change as trigger
  with the run keyed by it (`changes.ts`, `loop.ts`), the one-off clear of the old
  rules (`legacy.ts`), the `done` read against its plan and `refused` as an ending,
  the credential filter (`redact.ts`), the eval runner (`eval.ts`).
- The eval today: the first two tasks pass (a mention with no instruction is
  answered without a run; a mail in an undeclared area opens nothing); the third
  does not, because the provider answers 400 on `response_format` and, when it
  does answer, puts the content nowhere. 6 passes, 20 calls, 0 steps.
- The corpus and the provider block are outside the repository (171 runs, the
  installation's provider), and the eval never runs in the gate.

## F1 — the contact (blocks the measure)

**Touches:** `model.ts` (request shape, tool-call reader, probe), `loop.ts` (the
budget of a run), `shared/installation.ts` and `shared/run.ts` (the two limits),
`routes/agent.ts` and the admin limits panel.

- Native calls only: the catalogue in `tools`, the answer from `tool_calls`; the
  `{"calls": …}` prose fallback removed from the parser and from the prompt.
- The probe carries **one tool** at connect and at every reconnection; a provider
  that refuses it fails with a sentence naming the refusal. Cached per provider +
  base URL + model, re-run when the configuration moves.
- `limits.maxRunTokens` (proposal: **120 000**) and `limits.maxDailyTokens`
  (proposal: **2 000 000**), both editable in admin. Each call sends what is left
  of the run's budget as `max_tokens`; a run that reaches it ends `out-of-budget`
  naming the token; a spent day works no new change and the pass says so.

**Done when:** the third eval task passes through `tools`, the run records which
protocol it used, a provider without `tools` is refused at connect, and the loop
fixtures answer with `tool_calls` instead of prose.

**Risk, named first:** the installation's provider is Deepseek. If it does not
accept `tools` with this payload, the probe will refuse it and the deployment must
move to a provider that does. That is a product decision discovered in F1, not a
bug to work around.

## F2 — the eight jobs

**Touches:** `agent/tools/*`, `tools.ts`, `areas.ts`, every fixture that names a
tool.

- `read`, `find`, `place`, `draft`, `event`, `say`, `remember`, `settle`, as the
  record's table; every one of the 45 endpoint tools is either a field of a job or
  deliberately gone (`mail.send`).
- Schema as the interface: `enum` for a set, required fields required, ids naming
  their kind, a refusal quoting the real names and a valid example.
- The area selection does not change; only the names and the schemas.

**Done when:** the map is exhausted (no endpoint tool without a home), the area
invariant test still holds, the eval's third task runs at zero argument refusals,
and no fixture refers to a dropped name.

## F3 — a refusal is a repair

**Touches:** `model.ts` (the whole-answer refusal), `loop.ts` (the invalid call as
its own step).

- One bad call returns to the same turn with the field, the value sent and the
  allowed values; the valid calls of the same answer still run.
- The four-lookup ceiling is replaced by the job's own bound.

**Done when:** a test pins a plan with one bad and one good call, the good one on
the record, and the run continues.

## F4 — the measure

**Touches:** `eval.ts`, the task corpus outside the repository.

- Seven tasks beside the three; every task carries a reference its grader accepts;
  partial credit for a task with more than one side; a failed task run once more
  and reported `unstable` when only the second trial passes; `pass@1` printed.
- The two run cases whose messages were exported become tasks.

**Done when:** ten tasks exist, every one has a reference, and the runner reports
score, first-trial score and cost per task.

**Owed after it:** the replay of recorded provider answers, so the regression form
runs in CI without a key.

## F5 — the context is selected

**Touches:** the prompt builder, the run's step projection.

- The turn sees the ask, the instruction, the retrieved facts and the plan's tail;
  earlier steps one line each; past a threshold, a summary.
- The stable prefix is cached where the provider does; caching against compression
  is decided by the eval's cost.

**Done when:** the threshold is measured on the eval, and a long run costs less
with selection than with the whole plan.

## F6 — the trend

**Touches:** the pass and run documents, the admin view.

- Each run and pass emits the OpenTelemetry GenAI attributes; the last pass is no
  longer the only thing a person can read about the agent.

**Done when:** cost, refusals and endings are readable over a week without opening
a document.

## F7 — the memory

**Touches:** `memory.ts`, `shared/memory.ts`, the memory tools, the eval.

- Entities, typed relations and atomic facts with a validity interval; one
  document each in `gilbert/memory/`; the vector with the fact; the index rebuilt
  at boot.
- Retrieval by exact subject, then similarity, then recency, bounded by the
  context rule; a contradicting fact closes the one it replaces.
- Precision and recall are a task of the eval.

**Done when:** a fact that stops being true is closed and not recalled, and the
retrieval task reports precision and recall.

## The owed, in order after F7

1. **The judge** on the ask and the evidence, only on a suspect plan, calibrated.
2. **The injection test**, against the structural defence.
3. **The input guardrail** that ends a run `refused`.
4. **The regression replay** in CI.
5. **The other documents** — `ROADMAP.md`, `KNOWN-ISSUES.md`, `FEATURES.md`,
   `README.md` — aligned to this record.

## Open decisions, with a proposal

- Default of `limits.maxRunTokens`: **120 000** tokens per run.
- Default of `limits.maxDailyTokens`: **2 000 000** tokens per installation/day.
- The probe's cost: one tool-carrying call per provider session, cached and
  re-run when the provider configuration changes.
