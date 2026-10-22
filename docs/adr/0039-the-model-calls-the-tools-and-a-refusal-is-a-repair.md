# ADR 0039 — The model calls the tools, and a refusal is a repair

Status: Proposed

Implementation: Not built. The choosing turn reads native tool calls when a
provider sends them (`nativeToolCalls` in `server/src/agent/model.ts`), but the
catalogue is still forty-eight endpoint tools written into the prompt, a whole
answer is refused when one call is wrong, and the fallback is JSON in the text.
This record fixes the protocol and the shape of the error; ADR 0038 already fixes
the catalogue's size (eight jobs).

## Context

The 171-run corpus is unambiguous about where the work is lost. Of 260 failed
steps, **48** are `"id" must be text`, **42** `"fact" must be at most 400
characters`, **9** an invented tool name (`mail.search`), **9** a wrong argument
set (`memory.remember`), and only the remainder are reasoning. The eval run of
2026-10-22 added the same lesson from the other side: with the installation's
own provider, a turn asked for `response_format: json_object` while the prompt
never contained the word `json` (400, every call without tools), and a reasoning
model spent its provider-default budget before writing any content at all
(`answered without a message`, with only `reasoning_content`).

None of that is a decision the model got wrong. It is the interface asking the
model to spell things it cannot see.

## Decision

1. **Native function calling is the protocol.** The catalogue travels in the
   request's `tools`, never as prose in the prompt, and the answer is read from
   `tool_calls`. JSON in the text is a **declared fallback** for a provider that
   refuses `tools`: the run records that the fallback was used, so a deployment
   can see it rather than infer it.
2. **A refusal is a repair, not a lost answer.** An invalid call comes back to
   the same turn with the field, the value that was sent and the values the
   schema allows, and the refusal is one step on the run. The calls that were
   valid still run. The whole-answer refusal disappears.
3. **The schema is narrow and self-describing.** A field that takes one of a set
   is an `enum`; a field that takes an id says which kind (`mail id`, `file
   path`, `event id`); a required field is required in the schema, not in a
   sentence the model may skip. The eight jobs are ADR 0038's, not new ones.
4. **The ceilings are per job.** Four lookups per turn was a number of the
   endpoint catalogue; a job declares what it needs and the turn may look up
   that much. The budget of steps, calls and milliseconds stays.
5. **A provider's silence is a named failure.** A turn that answers with no
   content, or with reasoning only, fails with its own code and the pass says so;
   no run opens on it. A ceiling the provider applies is not this build's guess,
   and the build does not pretend the answer was empty on purpose.

## Consequences

- The prompt gets shorter (no catalogue prose) and the request gets larger
  (`tools` definitions). The saving is measured, not assumed: the eval prints
  calls, refusals and milliseconds per task.
- A provider without `tools` still works through the declared fallback, at the
  cost of the format refusals the corpus already measured; the run says which
  path it took.
- `run.read`, the endings and the evidence rules do not change: a repair is a
  step, and the record remains the product (ADR 0030).
- The eval of ADR 0038 becomes the judge of this change: a job that still costs
  an argument refusal is a job the schema has not described well enough.
