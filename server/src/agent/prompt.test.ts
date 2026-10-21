import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunStep } from "../shared/run.js";
import type { DecisionQuestion, StepQuestion } from "./model.js";
import {
  READ_IN_PROMPT_MAX,
  STEP_OUTCOME_FULL_MAX,
  STEP_OUTCOME_OLD_MAX,
  stepData,
  turnData,
} from "./prompt.js";

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
  const prompt = turnData(question, [{ name: "files.read", result: { text: huge } }]);

  assert.ok(prompt.length < huge.length, "the whole document is not in the prompt");
  assert.ok(prompt.includes("…"), "and the reader can see it was cut");
  assert.ok(
    prompt.includes("a".repeat(1_000)),
    "what is carried is the answer's own beginning",
  );
});

/** One ended step whose outcome is longer than the prompt carries of an old one. */
function ended(at: number, state: RunStep["state"] = "done"): RunStep {
  return {
    what: `step-${at} action`,
    state,
    outcome: `${at}:${"x".repeat(STEP_OUTCOME_OLD_MAX * 4)}`,
    needs: null,
  };
}

/**
 * The plan is re-sent on every choosing turn, so its outcomes are what makes a
 * long run's prompt grow: the last few are carried whole, an older one as its
 * beginning, and the step a step still to run waits on stays whole however old
 * it is — that is what the next choice branches on.
 */
test("an old step's outcome is carried as its beginning, the last few whole", () => {
  const plan = Array.from({ length: STEP_OUTCOME_FULL_MAX + 2 }, (_, at) => ended(at));
  const prompt = stepData({ woke: "mail created: m-1", plan, prose: {} } as StepQuestion);

  assert.ok(!prompt.includes(plan[0]?.outcome ?? ""), "the oldest is cut");
  assert.ok(prompt.includes("0:"), "what is kept is its own beginning");
  assert.ok(
    prompt.includes("An outcome that ends in … is carried as its beginning"),
    "and the model is told what the cut means",
  );
  for (const at of plan.slice(-STEP_OUTCOME_FULL_MAX))
    assert.ok(prompt.includes(at.outcome), "the steps just taken are whole");
  assert.ok(prompt.includes(`step ${plan.length}`), "the plan's own shape is untouched");
});

test("a step a later step waits on is carried whole however old it is", () => {
  const plan: RunStep[] = [
    ended(0),
    ended(1),
    ended(2),
    ended(3),
    { what: "the step that waits", state: "open", outcome: "", needs: null },
    {
      what: "waiting",
      state: "open",
      outcome: "",
      needs: { step: 0, when: "done" },
    },
  ];
  const prompt = stepData({ woke: "chat created: c-1", plan, prose: {} } as StepQuestion);

  assert.ok(prompt.includes(plan[0]?.outcome ?? ""), "the waited-on step is whole");
});

/**
 * A chat message is somebody else's text and can be a pasted log: the turn that
 * decides the change carries its beginning, and the words it was not shown are
 * what a later lookup is for.
 */
test("a chat message longer than the prompt's bound is carried as its beginning", () => {
  const huge = "b".repeat(READ_IN_PROMPT_MAX + 500);
  const question = {
    event: { source: "chat", change: "created", where: "c-1" },
    detail: { from: "someone@example.com", text: huge },
  } as DecisionQuestion;
  const prompt = turnData(question, [], []);

  assert.ok(prompt.length < huge.length, "the whole paste is not in the prompt");
  assert.ok(prompt.includes("b".repeat(1_000)), "its beginning is");
  assert.ok(prompt.includes("…"), "and the cut is visible");
});
