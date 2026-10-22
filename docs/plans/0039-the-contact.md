# Plan — the contact (ADR 0039)

Status: **proposed**. The skeleton of ADR 0038 is built; this plan rebuilds the
one layer the eval of 2026-10-22 proved unfit — the model↔tools contact — and
measures each step with the runner (`server/src/agent/eval.ts`).

The ADR is the decision. This is the order the tree takes it.

## F0 — the turn that produces nothing (done)

- The prompt's own text never contained the word `json`, while every call
  without native tools asked for `response_format: json_object`: the provider
  answered 400 on each of them, and no run could open. One sentence in the
  system prompt says the answer is one JSON object.
- A reasoning model that spends the provider's default budget before writing is
  still open: the fix is either a stated `max_tokens` with room for the
  reasoning, or one retry when `finish_reason` is `length` with empty content.
  Decided with F1, because the ceiling belongs to the provider path.
- Done when: a mail in a declared area opens a run and reaches an ending.

## F1 — native function calling

- The catalogue travels in `tools`; the answer is read from `tool_calls` (the
  reader exists, `nativeToolCalls`). `response_format` is never sent beside
  `tools`.
- A provider that refuses `tools` falls back to JSON in the text **and the run
  records the fallback**, so a deployment sees which path it is on.
- The provider path owns the ceiling: a stated `max_tokens` with room for
  reasoning, and a named failure for a turn with no content.
- Done when: the same eval task passes through `tools` on the installation's
  provider, and the run says which protocol it used.

## F2 — the eight jobs

- The forty-eight endpoint tools become the eight of ADR 0038. Every capability
  of the old catalogue is either a field of a job or consciously dropped, and the
  map is written beside the tools (one table, one source).
- The schema is the interface: `enum` for a set, required where required, and
  every id names its kind in the argument's own description.
- Reading stays free and writing needs the area (ADR 0038): the selection does
  not change, only the names and the schemas.

## F3 — a refusal is a repair

- A wrong argument returns to the same turn with the field, the value sent and
  the allowed values; the valid calls of the same answer still run.
- The whole-answer refusal (`model.ts`) disappears, and a test pins that a plan
  with one bad call and one good call leaves the good one on the record.
- The four-lookup ceiling becomes the job's own bound.

## F4 — the measure

- Seven tasks to write beside the three: the drop of files, the credential, "fai
  tu", the recurring invitation, the unreadable attachment, the repeated reading,
  and the two run cases whose messages were exported (`false-done-cases.jsonl`,
  `gilbert-eval-messages.jsonl`).
- A task passes only at zero argument refusals and within the `done` averages
  (7 calls, one minute); the runner prints both.
- Not in the gate: the runner needs a provider key. A CI run may instead replay
  the recorded provider answers, and that is a decision for its own record.

## Open decisions

1. **The ceiling**: a stated `max_tokens` for every call, or a retry when the
   answer is cut. The first is simpler and costs nothing when the model stops
   early; the second hides the provider's default.
2. **The fallback**: keep JSON in the text for a provider without `tools`, or
   require `tools` and refuse the deployment with a sentence. The corpus says the
   fallback is where the format refusals live.
3. **The eight jobs' names and arguments** — F2's table, to be reviewed before
   the tools are written.
