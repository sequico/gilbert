# Plan — ADR 0038 in the tree

Status: **in progress, on branch `agents-reloaded`**. The server and the client
carry the new shape; the eval set and the job-shaped catalogue are still owed.
Each block lands green and on its own.

The gate is the project's own (`npm run check:ci`) at every push, and the measure
is the eval set of ADR 0038 — tasks taken from the runs that failed, judged on
whether the work is accepted and what it cost in calls and refusals.

## Done

1. **The areas exist and select the catalogue.**
   `shared/areas.ts` (the vocabulary both tiers read) and `agent/areas.ts` (which
   tool is in which area, and the selection): a run is handed the areas its
   instruction declares and its matrix names, plus chat, knowledge and memory;
   **reading is free, a write needs its area**. Wired into the turn that chooses,
   with the invariant test that a surface turned off takes its writings out.
2. **One instruction is the document.** `InstructionDoc` v2 — prose, areas, the
   surface matrix, and whether it sends — read by both tiers, with a document of
   any other version refused: this build reads v2, and a group whose document is
   v1 does no work until an administrator writes a new one. `GET /admin/groups/:name/prose`
   returns it; the `PUT` accepts the areas and refuses one nobody has.
3. **The rules are gone.** `rule.ts`, `rules.ts`, `shared/rule.ts`, their tests
   and their endpoints are deleted. The decision turn no longer names rules: it
   is told the change and answers what the change is about. A change is the
   group's when its area is declared or its surface is `watch`; a run is keyed by
   its change, and a group with no instruction gets a notice in its conversation.
   `prose.ts` carries two levels, not three.
4. **The old documents are cleared once.** `agent/legacy.ts` removes `rules/`
   and `agent/rules.json` from an account, writes `agent/reset-0038.json` so it
   happens once, and touches nothing else — the instruction, the runs, the
   cursors and the memory are the group's present. The loop calls it per account
   before anything reads the account (owner decision 2026-10-22: agents-reloaded
   starts from scratch, no residue).
5. **The client says the new words.** `GroupRules.tsx` and the rules calls are
   gone; `GroupInstruction.tsx` shows the prose and a checkbox per area, under
   Administration → AI Agents → Instruction. The `@gilbert/agent` alias the
   browser no longer needs is removed from both configs, and the six stale i18n
   keys are out of the eleven catalogues.
6. **The documents follow the tree.** `FEATURES.md` and `README.md` describe one
   instruction, the areas, the run keyed by its change and the one-off clear.
7. **A `done` stands on its plan, and a tool's answer is filtered.**
   `loop.ts` sends back once a `done` that carries no finished step or a refused
   step the run has not been told about, and a second one with nothing finished
   ends the run `refused` — the ending that had a reader and no writer — without
   spending the last step of the budget on the question. Every tool answer is
   emptied of a credential-shaped field before it reaches the turn or the record
   (`agent/redact.ts`), and the step says what was withheld.
8. **The panel repairs what the build cannot read, and a loss is said.**
   `GET /prose` answers an unreadable document with an empty instruction and the
   document's own sentence, so an administrator can write a new one over it; the
   clear reports in the pass's gaps that a group which had rules and has no
   instruction will do no work; a credential pasted into the prose a turn is
   given is emptied by the same filter (`redactText`); and a run's state labels
   are in all eleven catalogues.
9. **The eval exists and runs.** `server/src/agent/eval.ts` starts the mock, the
   group account and the loop on its own, with the installation's own provider
   (`GILBERT_EVAL_PROVIDER`, default the provider block exported from the
   deployment). Three tasks are written, each with the outcome a person would
   accept; a task that opens no run prints `no-run`. It is not a test and never
   runs in the gate.

## The eval, as it ran (2026-10-22)

| task | result |
|---|---|
| a mention in a group with no instruction is answered, without a run | **PASS** — no run, no model call, one message |
| a mail in an area the instruction does not declare opens no run | **PASS** — no run, no call |
| a mail in the mail area is read and answered | **FAIL** — `ending=running`, 6 passes, 20 calls, 0 steps |

The third task never produced a usable turn. The causes are in the contact, not
in the loop, and they are three:

- **`response_format: json_object` without the word `json` in the prompt.** The
  provider answers `400: Prompt must contain the word 'json' in some form to use
  'response_format' of type 'json_object'` on every call that carries no native
  tools — the decision turn, and the choosing turn when its tool definitions are
  refused. The prompt's own text never contains the word (`prompt.ts` has it only
  inside `JSON.stringify`). One sentence in the system prompt is the likely fix;
  it must be checked against what the deployment sends, since the 171-run corpus
  shows the same provider answering on 21 October.
- **A reasoning model with no stated ceiling.** `deepseek-flash` put its answer in
  `reasoning_content` and left `content` as spaces: `answered without a message`.
  The build deliberately sends no `max_tokens` ("a ceiling this build guessed cut
  the content away"); with this model the provider's own default is what runs out.
- **Four lookups per turn.** One of the six passes reported "The model asked to
  look something up with all 4 lookups spent", so the turn could not finish what
  it started.

No measure of the model's quality exists yet: the contact does not deliver a
response to measure. The two blocking defects come first.

## The contact, in order

The one layer the eval proved unfit. F0 is done; each step is measured with the
runner.

- **F0 — the turn that produces nothing (done).** The decision turn said "JSON";
  the choosing turn did not, and every call that fell back to
  `response_format: json_object` was answered 400 by the provider. One sentence
  in the choosing turn's system prompt names JSON. Done when a mail in a declared
  area opens a run and reaches an ending.
- **F1 — native function calling, and only it.** The catalogue travels in `tools`
  and the answer is read from `tool_calls`. The fallback to JSON in the text is
  removed, and the parser stops reading a `{"calls": …}` written in prose. A
  provider that does not take `tools` is refused at connect **and at every
  reconnection** with a sentence naming the refusal; the probe is the one that
  already asks the provider a question, extended to carry one tool.
  `limits.maxRunTokens` (editable where the installation's limits are) is the
  run's budget of prompt and completion tokens; each call sends what is left as
  its `max_tokens`, and a run that reaches it ends `out-of-budget` naming the
  token.
- **F2 — the eight jobs.** The forty-eight endpoint tools become the eight of the
  record (`read`, `find`, `place`, `draft`, `event`, `say`, `remember`,
  `settle`), the map in the record is the authority, and `mail.send` is dropped:
  every capability is either a field of a job or consciously gone. The schema is
  the interface: `enum` for a set, required where required, every id naming its
  kind.
- **F3 — a refusal is a repair.** A wrong argument returns to the same turn with
  the field, the value sent and the allowed values; the valid calls of the same
  answer still run; the whole-answer refusal disappears, with a test that pins a
  plan whose bad call and good call leave the good one on the record. The
  four-lookup ceiling becomes the job's own bound.
- **F4 — the measure.** Seven tasks beside the three: the drop of files, the
  credential, "fai tu", the recurring invitation, the unreadable attachment, the
  repeated reading, and the two run cases whose messages were exported. A task
  passes only at zero argument refusals and within the `done` averages (7 calls,
  one minute).

## Open decisions

1. **The default of `limits.maxRunTokens`** — the value a fresh installation
   starts from; the shape is decided, the number is not.
2. **The probe's cost**: one tool-carrying call at every reconnection is a real
   request; whether it is cached per provider session is a decision for F1.

## Owed, and named so it is not forgotten

- **The judge that reads the ask and the evidence against the plan**: the guard
  reads the plan alone, so a `done` that stands on a refused step while a later
  step succeeded still passes.
