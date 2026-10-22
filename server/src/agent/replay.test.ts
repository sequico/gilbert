/**
 * The regression replay of ADR 0038 — no key, no network, no model.
 *
 * The eval records the provider's own answers (`eval/replay.ts`); this test
 * reads them back through **today's** parsers: the action turn through
 * `parseStepAnswerDetailed` and the job catalogue, the decision turn through
 * `parseAnswerDetailed`, the judge through its shape. A change that stops
 * reading an answer a real model gave — a renamed job, a schema the parser no
 * longer accepts, a decision shape it refuses — fails here, in `npm test`, where
 * no provider key is needed.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isRecord } from "../shared/json.js";
import { type RecordedCall, recordedCalls } from "./eval/replay.js";
import {
  jsonObjectIn,
  nativeToolCalls,
  parseAnswerDetailed,
  parseStepAnswerDetailed,
} from "./model.js";
import { READING_TOOLS, TOOLS, validatedTool } from "./tools.js";

const RECORDINGS = fileURLToPath(new URL("./eval/recordings/", import.meta.url));

/** The body of a chat completion the recording holds. */
function answerOf(call: RecordedCall): Record<string, unknown> | null {
  try {
    const body = JSON.parse(call.response) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

test("every recorded answer still parses through today's parsers", () => {
  const files = readdirSync(RECORDINGS).filter((name) => name.endsWith(".jsonl"));
  assert.ok(files.length > 0, "the recordings are in the repository");

  let actions = 0;
  let decisions = 0;
  let judgements = 0;
  let refusals = 0;
  /*
   * A recorded call the endpoint refuses **for its arguments** is history: the
   * model gave it, the catalogue refused it, the run paid for it. What is a
   * regression is a name the catalogue no longer holds, or a shape the parser
   * no longer reads: those throw here.
   */
  const stillKnown = (
    catalogue: Parameters<typeof validatedTool>[0],
    name: string,
    args: unknown,
  ): string => {
    try {
      return validatedTool(catalogue, name, args).tool.name;
    } catch (err) {
      if ((err as { code?: string }).code === "bad_arguments") {
        refusals += 1;
        return name;
      }
      throw err;
    }
  };
  for (const file of files) {
    for (const call of recordedCalls(`${RECORDINGS}${file}`)) {
      if (!call.url.endsWith("/chat/completions")) continue;
      // The capability probe is a request of its own, not a turn of the agent.
      if (call.system.startsWith('Answer in JSON: {"ok": true}')) continue;
      if (call.tools.includes("gilbert_probe")) continue;
      const body = answerOf(call);
      if (call.status !== 200 || !body) continue;

      if (call.tools.length) {
        const native = nativeToolCalls(body);
        if (native) {
          const parsed = parseStepAnswerDetailed({
            calls: native.map((one) => ({
              name: one.name,
              arguments: one.arguments,
            })),
          });
          assert.ok(
            !("problem" in parsed),
            `an action answer was refused: ${JSON.stringify(parsed)}`,
          );
          if (!("problem" in parsed) && parsed.choice.kind === "plan")
            for (const one of parsed.choice.calls) {
              const name = stillKnown(TOOLS, one.name, one.args);
              assert.ok(
                call.tools.includes(name),
                `"${name}" was called without being offered`,
              );
            }
        } else {
          // A sentence with no call is the run's ending, and only prose.
          const content = (
            body.choices as Array<{ message?: { content?: unknown } }>
          )?.[0]?.message?.content;
          assert.ok(
            typeof content === "string" && content.trim(),
            "an action answer was neither a call nor a sentence",
          );
        }
        actions += 1;
        continue;
      }

      const content = (body.choices as Array<{ message?: { content?: unknown } }>)?.[0]
        ?.message?.content;
      const object = typeof content === "string" ? jsonObjectIn(content) : null;
      if (object === null) {
        /*
         * Two shapes a structured turn may take without a JSON object: the
         * decision turn's lookup named as a native call, and — when the change
         * came from the conversation — a person's words as the reply.
         */
        const native = nativeToolCalls(body);
        if (native) {
          for (const one of native) stillKnown(READING_TOOLS, one.name, one.arguments);
          decisions += 1;
          continue;
        }
        assert.ok(
          typeof content === "string" && content.trim(),
          `a structured answer was neither JSON nor prose: ${JSON.stringify(call).slice(0, 300)}`,
        );
        decisions += 1;
        continue;
      }
      if (call.system.includes("judge whether a run's report stands")) {
        assert.equal(typeof (object as { stands?: unknown }).stands, "boolean");
        assert.equal(typeof (object as { why?: unknown }).why, "string");
        judgements += 1;
      } else {
        const parsed = parseAnswerDetailed(object);
        assert.ok(
          !("problem" in parsed),
          `a decision answer was refused: ${JSON.stringify(parsed)}`,
        );
        decisions += 1;
      }
    }
  }
  assert.ok(actions > 0, "the recording holds action turns");
  assert.ok(decisions > 0, "the recording holds decision turns");
  console.error(
    `replayed ${actions} action turn(s), ${decisions} decision(s), ${judgements} judgement(s), ${refusals} recorded argument refusal(s)`,
  );
});
