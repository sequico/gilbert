import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionQuestion } from "./model.js";
import { READ_IN_PROMPT_MAX, turnData } from "./prompt.js";

/**
 * The prompt is paid for by the token and bounded by the provider's context: a
 * lookup that answered a large document is clipped, and the cut is visible in
 * the text rather than a call that fails at the provider.
 */
test("a lookup larger than the prompt's bound is clipped, and says so", () => {
  const question = {
    event: { source: "mail", change: "created", where: "m-1" },
  } as DecisionQuestion;
  const huge = "a".repeat(READ_IN_PROMPT_MAX + 500);
  const prompt = turnData(question, [], [{ name: "files.read", result: { text: huge } }]);

  assert.ok(prompt.length < huge.length, "the whole document is not in the prompt");
  assert.ok(prompt.includes("…"), "and the reader can see it was cut");
  assert.ok(
    prompt.includes("a".repeat(1_000)),
    "what is carried is the answer's own beginning",
  );
});
