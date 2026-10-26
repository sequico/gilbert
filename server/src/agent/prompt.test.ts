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
  assert.ok(
    prompt.includes("Asking for the same call again brings it back whole once more"),
    "and how to get that answer back, since a read of the run's record is clipped to its first four kilobytes",
  );
  for (const at of plan.slice(-STEP_OUTCOME_FULL_MAX))
    assert.ok(prompt.includes(at.outcome), "the steps just taken are whole");
  assert.ok(prompt.includes(`step ${plan.length}`), "the plan's own shape is untouched");
});

test("a repeated call is shown once, and the repeat points at the answer", () => {
  const plan: RunStep[] = [
    {
      what: 'find {"kind":"folders"}',
      state: "done",
      outcome: "the folders it holds",
      needs: null,
    },
    {
      what: 'find {"kind":"folders"}',
      state: "done",
      outcome: "the folders it holds",
      needs: null,
    },
  ];
  const prompt = stepData({ woke: "chat created: c-1", plan, prose: {} } as StepQuestion);

  assert.equal(
    prompt.split("the folders it holds").length - 1,
    1,
    "the answer is carried once, not once per proposal",
  );
  assert.match(prompt, /same call as step 1/, "the repeat names the step that answered");
});

/**
 * A repeat is a pointer and carries no answer of its own, so counting it among the
 * steps carried whole spends the window on pointers. A live run re-read one
 * message twelve times, and every time the body it wanted had been pushed out by
 * repeats of itself: two of the three places held a pointer to the same step.
 */
test("a repeated call does not take a place in the carried-whole window", () => {
  const body = `the body:${"m".repeat(STEP_OUTCOME_OLD_MAX * 4)}`;
  const read: RunStep = {
    what: 'read {"kind":"message","id":"m-1"}',
    state: "done",
    outcome: body,
    needs: null,
  };
  const plan: RunStep[] = [
    read,
    ...Array.from({ length: STEP_OUTCOME_FULL_MAX }, (_, at) => ended(at)),
    { ...read },
  ];
  const prompt = stepData({ woke: "mail created: m-1", plan, prose: {} } as StepQuestion);

  assert.ok(
    prompt.includes(body),
    "the answer the run asked for again is carried whole, not only as its beginning",
  );
  assert.match(prompt, /same call as step 1/, "and the repeat still says where it is");
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

/** One step as the record holds it after it ended: an outcome the prompt carries whole. */
function ran(at: number): RunStep {
  return {
    what: `step-${at} place`,
    state: "done",
    outcome: `${at}:${"x".repeat(3_000)}`,
    needs: null,
  };
}

/**
 * The threshold is measured, not guessed (ADR 0038): the whole plan is what a
 * turn used to be handed, and the projection is what it is handed now.
 *
 * Forty ended steps of three kilobytes are 120 000 characters of outcome; the
 * turn carries the last three whole and thirty-seven beginnings, 23 064
 * characters — about a fifth — and the extra cost of twenty more steps is one
 * line each, not three kilobytes each.
 */
test("a long run's prompt is a fraction of the whole plan, and grows a line a step", () => {
  const plan = Array.from({ length: 20 }, (_, at) => ran(at));
  const longer = Array.from({ length: 40 }, (_, at) => ran(at));
  const ask = (steps: RunStep[]) =>
    stepData({ woke: "mail created: m-1", plan: steps, prose: {} } as StepQuestion);

  const whole = longer.reduce((sum, step) => sum + step.outcome.length, 0);
  const prompt = ask(longer);
  assert.ok(
    prompt.length < whole * 0.2,
    `the turn carries ${Math.round((prompt.length / whole) * 100)}% of the plan`,
  );

  const grew = prompt.length - ask(plan).length;
  const wholeGrew = whole - plan.reduce((sum, step) => sum + step.outcome.length, 0);
  assert.ok(
    grew < wholeGrew / 8,
    `twenty more steps add ${grew} characters, against ${wholeGrew} carried whole`,
  );
  for (const step of longer.slice(-STEP_OUTCOME_FULL_MAX))
    assert.ok(prompt.includes(step.outcome), "the steps just taken are whole");
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
  const prompt = turnData(question, []);

  assert.ok(prompt.length < huge.length, "the whole paste is not in the prompt");
  assert.ok(prompt.includes("b".repeat(1_000)), "its beginning is");
  assert.ok(prompt.includes("…"), "and the cut is visible");
});

/**
 * A quote reply is about the sentence it quotes. The turn that answers it in
 * words is shown that sentence: a live reply was answered "I do not have the
 * content of the message you refer to", which is the turn telling the truth
 * about the prompt it was given.
 */
test("a reply carries the message it answers into the turn", () => {
  const question = {
    event: { source: "chat", change: "created", where: "c-2" },
    detail: {
      from: "sam@example.org",
      text: "can you send me the links to those?",
      replyTo: "c-1",
      quoted: "two invoices are archived: 07/10 and 01/10",
    },
  } as DecisionQuestion;
  const prompt = turnData(question, []);

  assert.ok(
    prompt.includes("it answers: two invoices are archived: 07/10 and 01/10"),
    "the quoted words travel with the reply",
  );
  assert.ok(prompt.includes("answers: c-1"), "and the id it answers is still named");
});

test("a quoted message longer than the bound is carried as its beginning", () => {
  const huge = "q".repeat(READ_IN_PROMPT_MAX + 500);
  const question = {
    event: { source: "chat", change: "created", where: "c-3" },
    detail: { from: "sam@example.org", text: "and those?", quoted: huge },
  } as DecisionQuestion;
  const prompt = turnData(question, []);
  assert.ok(prompt.length < huge.length, "the whole quoted message is not carried");
  assert.ok(prompt.includes("q".repeat(1_000)), "its beginning is");
});
