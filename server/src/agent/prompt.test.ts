import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunStep } from "../shared/run.js";
import type { DecisionQuestion, StepQuestion } from "./model.js";
import { READ_IN_PROMPT_MAX, stepData, turnData } from "./prompt.js";

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

/** One ended step whose answer is longer than one line, so a cut would show. */
function ended(at: number, state: RunStep["state"] = "done"): RunStep {
  return {
    what: `step-${at} action`,
    state,
    outcome: `${at}:${"x".repeat(1_000)}`,
    needs: null,
  };
}

/**
 * The turn is a transcript: every step's answer is carried as the record keeps it —
 * bounded when it was written, never clipped when it is read — and nothing that is
 * already in it changes on a later turn. The window that re-clipped older answers
 * bought a shorter prompt at the price of the provider's cache and of a body the
 * model had to fetch again (ADR 0038).
 */
test("every step's answer is carried as the record keeps it", () => {
  const plan = Array.from({ length: 6 }, (_, at) => ended(at));
  const prompt = stepData({ woke: "mail created: m-1", plan, prose: {} } as StepQuestion);

  for (const step of plan)
    assert.ok(prompt.includes(step.outcome), `step ${step.what} is carried whole`);
  assert.ok(
    !prompt.includes("carried as its beginning"),
    "and nothing is cut, so nothing explains a cut",
  );
});

test("a step's text does not change when the plan grows", () => {
  const plan = Array.from({ length: 4 }, (_, at) => ended(at));
  const ask = (steps: RunStep[]) =>
    stepData({ woke: "mail created: m-1", plan: steps, prose: {} } as StepQuestion);
  /* The fence token is drawn per call; what must not move is the text inside it. */
  const strip = (text: string) => text.replace(/\[[0-9a-f]{8}\]/g, "");

  const first = strip(ask(plan));
  const grown = strip(ask([...plan, ended(4)]));
  assert.ok(
    grown.startsWith(first),
    "the turn grows by a step at the end; no earlier step's text is rewritten",
  );
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
 * A repeat is a line pointing at the step that answered: the answer never leaves the
 * transcript, so the repeat needs no copy of it and no re-fetch.
 */
test("a repeated call is a line, and the answer stays where it was", () => {
  const body = `the body:${"m".repeat(1_000)}`;
  const read: RunStep = {
    what: 'read {"kind":"message","id":"m-1"}',
    state: "done",
    outcome: body,
    needs: null,
  };
  const plan: RunStep[] = [
    read,
    ...Array.from({ length: 3 }, (_, at) => ended(at)),
    { ...read },
  ];
  const prompt = stepData({ woke: "mail created: m-1", plan, prose: {} } as StepQuestion);

  assert.ok(
    prompt.includes(body),
    "the answer the run asked for again is still there, whole",
  );
  assert.equal(
    prompt.split(body).length - 1,
    1,
    "and the repeat adds a line rather than a second copy",
  );
  assert.match(prompt, /same call as step 1/, "the repeat says where the answer is");
});

/**
 * A step still to run has answered nothing, and the transcript says so rather than
 * printing an empty answer as if it were one.
 */
test("a step still to run is shown as having answered nothing", () => {
  const first = `the answer:${"a".repeat(1_000)}`;
  const plan: RunStep[] = [
    {
      what: 'read {"kind":"message","id":"m-1"}',
      state: "done",
      outcome: first,
      needs: null,
    },
    { what: 'find {"kind":"files"}', state: "open", outcome: "", needs: null },
  ];
  const prompt = stepData({ woke: "mail created: m-1", plan, prose: {} } as StepQuestion);

  assert.ok(prompt.includes(first), "the answer that is there is carried whole");
  assert.match(
    prompt,
    /state: open\noutcome: \(nothing yet\)/,
    "and the open one is empty",
  );
});

test("the case's note is carried whole in the turn", () => {
  /*
   * The instruction asks the agent to record what it needs and not to re-read what
   * it has read; the note is where it records it, and a turn that lost it is a turn
   * sent looking for the same page again (ADR 0034).
   */
  const note = `reference BK-901\nfolder MS2/BK-901\nnaming: <ref> <container>\n${"x".repeat(1_000)}`;
  const prompt = stepData({
    woke: "mail created: m-1",
    plan: [],
    prose: {},
    note,
  } as StepQuestion);

  assert.ok(prompt.includes(note), "the note the model wrote is the note it reads");
  assert.ok(
    prompt.includes("What this case has kept"),
    "and it is named as its own working memory, not as an instruction",
  );
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
 * A long run's prompt is what the record holds, and it grows by one answer a step —
 * which is what the provider's cache is worth, and why the transcript is compacted
 * rather than re-clipped (ADR 0038). The record's own bound is what limits one
 * answer; the plan is not projected down to a fraction of itself any more.
 */
test("a long run's prompt grows by one answer a step, and no earlier answer moves", () => {
  const plan = Array.from({ length: 20 }, (_, at) => ran(at));
  const longer = Array.from({ length: 40 }, (_, at) => ran(at));
  const ask = (steps: RunStep[]) =>
    stepData({ woke: "mail created: m-1", plan: steps, prose: {} } as StepQuestion);

  const whole = longer.reduce((sum, step) => sum + step.outcome.length, 0);
  const prompt = ask(longer);
  assert.ok(
    prompt.length > whole,
    "every answer the record holds is in the turn, not a projection of them",
  );
  const grew = prompt.length - ask(plan).length;
  const wholeGrew = whole - plan.reduce((sum, step) => sum + step.outcome.length, 0);
  const overhead = grew - wholeGrew;
  assert.ok(
    overhead >= 0 && overhead < 20 * 200,
    `twenty more steps add ${grew} characters: ${wholeGrew} of answers and ${overhead} of fence`,
  );
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
