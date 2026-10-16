/**
 * The run's shape and its transitions (ADR 0034) — no server, no I/O.
 *
 * What a transition does is the whole of what is pinned here: a run ends in one
 * of three ways and says which, a step's outcome is recorded where it belongs,
 * the plan grows with the step the model chose, what the run touched and what it
 * spent are written by a transition each, an authorisation carries the sentence
 * it arrived in and the authority that was given, and the wait is a date in the
 * document — or no date at all, when what it waits for is a person. The
 * parser's half is the other side of the same contract: a run this build did not
 * write is reported rather than read as an empty one, and a field it does not
 * know does not refuse a run that is otherwise whole.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendStep,
  finishRun,
  isRunDue,
  parseRunDocumentDetailed,
  RUN_VERSION,
  recordEvidence,
  recordStep,
  spendRun,
  startRun,
  takeAuthorisation,
  touchObject,
  waitUntil,
} from "./run.js";

const START = { rule: "intake", instruction: null } as const;
const AT = "2026-10-16T10:00:00.000Z";
const ASKED = { channel: "mail", id: "m-ask-1" } as const;
const QUESTION = { what: "the shipper's answer", asked: ASKED, until: null } as const;

test("a run starts running, its plan open, having touched and spent nothing", () => {
  const run = startRun({
    id: "r1",
    startedBy: START,
    plan: ["read the mail", "file it"],
  });

  assert.equal(run.state, "running");
  assert.equal(run.ended, null);
  assert.equal(run.waiting, null);
  assert.deepEqual(run.touched, [], "a run that just started has touched nothing");
  assert.deepEqual(run.evidence, []);
  assert.deepEqual(run.authorisations, []);
  assert.deepEqual(run.spent, { steps: 0, calls: 0, ms: 0 });
  assert.equal(run.v, RUN_VERSION);
  assert.deepEqual(
    run.plan,
    [
      { what: "read the mail", state: "open", outcome: "" },
      { what: "file it", state: "open", outcome: "" },
    ],
    "every step the plan names is open and none is ended",
  );

  for (const ending of ["done", "blocked", "out-of-budget"] as const) {
    // A blocked run left a question, which is the one ending that carries one.
    const ended = finishRun(waitUntil(run, QUESTION), ending, {
      at: AT,
      why: "the reason it stopped",
    });
    assert.equal(ended.state, ending, "the run says how it ended");
    const stored = parseRunDocumentDetailed(JSON.stringify(ended));
    assert.ok("run" in stored, "the ending survives the document");
    assert.equal(stored.run.state, ending, "and the document says it too");
    assert.deepEqual(stored.run.ended, { at: AT, why: "the reason it stopped" });
  }
  assert.notEqual(
    finishRun(run, "out-of-budget", { at: AT, why: "" }).state,
    "done",
    "spent budget is not a done job",
  );
});

test("a step records how it ended, and a run that ended does not act again", () => {
  const run = startRun({ id: "r2", startedBy: START, plan: ["one", "two"] });

  const afterOne = recordStep(run, 0, { state: "done", outcome: "filed it" });
  assert.deepEqual(afterOne.plan[0], { what: "one", state: "done", outcome: "filed it" });
  assert.deepEqual(
    afterOne.plan[1],
    { what: "two", state: "open", outcome: "" },
    "the other steps are left as they were",
  );
  assert.deepEqual(run.plan[0], { what: "one", state: "open", outcome: "" });
  // The transition answers a new document: the one it was handed is untouched.
  assert.notEqual(afterOne, run);

  assert.throws(
    () => recordStep(run, 9, { state: "done", outcome: "" }),
    /has no step 9/,
  );

  const ended = finishRun(run, "done", { at: AT, why: "there was nothing to do" });
  assert.throws(() => recordStep(ended, 0, { state: "done", outcome: "" }), /has ended/);
  assert.throws(() => finishRun(ended, "done", { at: AT, why: "again" }), /has ended/);
});

test("the plan grows with the step the model chose after seeing a result", () => {
  const run = startRun({ id: "r7", startedBy: START, plan: ["read the mail"] });

  const grown = appendStep(run, "answer the shipper");
  assert.deepEqual(
    grown.plan.map((step) => step.what),
    ["read the mail", "answer the shipper"],
    "the step is appended at the end of the plan, never inserted",
  );
  assert.deepEqual(
    grown.plan[1],
    { what: "answer the shipper", state: "open", outcome: "" },
    "and it starts open, like every step the plan names",
  );
  assert.equal(run.plan.length, 1, "the run it was given is untouched");
  assert.throws(() => appendStep(run, ""), /needs what it is/);
  assert.throws(
    () => appendStep(finishRun(run, "done", { at: AT, why: "over" }), "one more"),
    /has ended/,
  );
});

test("a run names every object it touched, in one reference shape", () => {
  const run = startRun({ id: "r8", startedBy: START });

  const filed = touchObject(run, { accountId: "acc-1", kind: "message", id: "m-7" });
  const touched = touchObject(filed, { accountId: "acc-1", kind: "file", id: "f-2" });
  assert.deepEqual(
    touched.touched,
    [
      { accountId: "acc-1", kind: "message", id: "m-7" },
      { accountId: "acc-1", kind: "file", id: "f-2" },
    ],
    "every object the run touched is named where a person can read it back",
  );
  assert.deepEqual(filed.touched.length, 1, "each transition answers a new document");
  assert.deepEqual(run.touched, []);

  const stored = parseRunDocumentDetailed(JSON.stringify(touched));
  assert.ok("run" in stored, "and the list is part of the stored contract");
  assert.deepEqual(stored.run.touched, touched.touched);

  assert.throws(
    () => touchObject(run, { accountId: "acc-1", kind: "nope", id: "x" } as never),
    /is not one/,
    "a reference of a kind no reader knows is refused, not written",
  );
});

test("the budget is a tally the run carries, and it only grows", () => {
  const run = startRun({ id: "r9", startedBy: START });

  const spent = spendRun(run, { steps: 1, calls: 2, ms: 1_500 });
  assert.deepEqual(
    spent.spent,
    { steps: 1, calls: 2, ms: 1_500 },
    "the three counters the budget is measured in are the run's own",
  );
  assert.deepEqual(
    spendRun(spent, { calls: 1 }).spent,
    { steps: 1, calls: 3, ms: 1_500 },
    "a spend adds to the tally, and a later turn adds to the same sum",
  );
  assert.deepEqual(
    run.spent,
    { steps: 0, calls: 0, ms: 0 },
    "the run it was given is untouched",
  );
  assert.throws(() => spendRun(run, { ms: -1 }), /can only grow/);
  assert.throws(() => spendRun(run, { steps: Number.NaN }), /can only grow/);

  const stored = parseRunDocumentDetailed(JSON.stringify(spent));
  assert.ok("run" in stored, "the tally is part of the stored contract");
  assert.deepEqual(
    stored.run.spent,
    { steps: 1, calls: 2, ms: 1_500 },
    "and it is in the document, which is what survives a restart",
  );
});

test("the evidence behind a claim is recorded on the run", () => {
  const run = startRun({ id: "r10", startedBy: START, plan: ["settle the step"] });

  const supported = recordEvidence(run, {
    claim: "settle the step",
    source: "workorders/w-1.json",
  });
  assert.deepEqual(supported.evidence, [
    { claim: "settle the step", source: "workorders/w-1.json" },
  ]);
  assert.deepEqual(run.evidence, [], "the run it was given is untouched");
  assert.throws(
    () => recordEvidence(run, { claim: "x", source: "" }),
    /cannot rest on that/,
  );

  const stored = parseRunDocumentDetailed(JSON.stringify(supported));
  assert.ok("run" in stored);
  assert.deepEqual(stored.run.evidence, supported.evidence);
});

test("an authorisation says which authority it is", () => {
  const run = startRun({ id: "r11", startedBy: START });

  const sent = takeAuthorisation(run, {
    what: "send the confirmation",
    authority: "outward",
    by: "sam@example.com",
    at: AT,
    from: { channel: "mail", id: "m-42" },
  });
  const overridden = takeAuthorisation(sent, {
    what: "file it outside the policy",
    authority: "override",
    by: "admin@example.com",
    at: AT,
    from: { channel: "chat", id: "node-9" },
  });

  assert.deepEqual(
    overridden.authorisations.map((authorisation) => authorisation.authority),
    ["outward", "override"],
    "a send and an override are told apart by the field, never by reading the prose",
  );
  assert.equal(
    overridden.authorisations[0]?.from.id,
    "m-42",
    "each keeps its own sentence",
  );
  assert.deepEqual(sent.authorisations.length, 1, "the run it was given is untouched");
  assert.throws(
    () =>
      takeAuthorisation(run, {
        what: "something",
        authority: "allowed" as never,
        by: "sam@example.com",
        at: AT,
        from: { channel: "mail", id: "m-1" },
      }),
    /cannot take that authorisation/,
  );
});

test("a wait is a date on the run, and the run is due when it passes", () => {
  const run = startRun({ id: "r3", startedBy: START });

  const waiting = waitUntil(run, {
    what: "the shipper's answer",
    asked: ASKED,
    until: AT,
  });
  assert.deepEqual(waiting.waiting, {
    what: "the shipper's answer",
    asked: ASKED,
    until: AT,
  });
  assert.equal(isRunDue(waiting, new Date("2026-10-16T09:59:59.999Z")), false);
  assert.equal(isRunDue(waiting, new Date(AT)), true, "due at the instant it names");
  assert.equal(
    isRunDue(run, new Date(AT)),
    false,
    "a run that is not waiting is not due",
  );

  // A person's answer has no date: the wait is the question and its sentence.
  const asking = waitUntil(run, QUESTION);
  assert.equal(asking.waiting?.until, null, "a wait may name no instant at all");
  assert.equal(
    isRunDue(asking, new Date("2027-01-01T00:00:00.000Z")),
    false,
    "and a wait with no date never comes due by one",
  );

  assert.throws(
    () => waitUntil(run, { what: "whenever", asked: ASKED, until: "not a date" }),
    /is not an instant/,
  );
  assert.throws(
    () => waitUntil(run, { what: "", asked: ASKED, until: AT }),
    /cannot wait on that/,
  );

  const ended = finishRun(waiting, "done", { at: AT, why: "the answer came" });
  assert.equal(ended.waiting, null, "a run that ended is not waiting");
  assert.equal(isRunDue(ended, new Date("2026-10-17T00:00:00.000Z")), false);
});

test("a run blocked on a person keeps the question it left, and where it asked", () => {
  const run = startRun({ id: "r12", startedBy: START });

  const blocked = finishRun(waitUntil(run, QUESTION), "blocked", {
    at: AT,
    why: "the answer has to come from a person",
  });
  assert.deepEqual(
    blocked.waiting,
    { what: "the shipper's answer", asked: ASKED, until: null },
    "the question and the sentence it was asked in are not reduced to prose",
  );
  assert.equal(isRunDue(blocked, new Date("2027-01-01T00:00:00.000Z")), false);

  const stored = parseRunDocumentDetailed(JSON.stringify(blocked));
  assert.ok("run" in stored, "a blocked run with a wait is a run this build reads");
  assert.deepEqual(stored.run.waiting, blocked.waiting);
  assert.deepEqual(
    stored.run.waiting?.asked,
    { channel: "mail", id: "m-ask-1" },
    "the answer's own message id is what the run can be recognised by",
  );

  assert.throws(
    () => finishRun(run, "blocked", { at: AT, why: "a person has to say" }),
    /names the question it left/,
    "a run blocked on nobody is a run whose reason nobody can act on",
  );
});

test("a stored run tolerates a field this build does not know, and keeps the rest", () => {
  const run = startRun({
    id: "r5",
    startedBy: { rule: null, instruction: { channel: "chat", id: "node-7" } },
    plan: ["look"],
  });
  const stored = JSON.stringify({ ...run, budget: { steps: 12 }, retiredThing: true });

  const parsed = parseRunDocumentDetailed(stored);
  assert.ok(
    "run" in parsed,
    "the extra keys do not refuse a run that is otherwise whole",
  );
  assert.equal(parsed.run.id, "r5");
  assert.equal(parsed.run.startedBy.instruction?.id, "node-7");
  assert.equal(
    (parsed.run as unknown as Record<string, unknown>).budget,
    undefined,
    "and the parsed run carries only the fields this build reads",
  );
});

test("a run this build cannot read is reported, with what was wrong", () => {
  const whole = startRun({ id: "r6", startedBy: START });
  const bad = [
    ["not JSON at all", /Not valid JSON/],
    ["[]", /must be a JSON object/],
    ['{"v":2,"id":"r6"}', /this build reads version 1/],
    ['{"v":1,"id":"","startedBy":{"rule":"a","instruction":null}}', /"id" must be/],
    [
      '{"v":1,"id":"r6","startedBy":{"rule":"a","instruction":null}}',
      /"plan" must be a list of steps/,
    ],
    [JSON.stringify({ ...whole, touched: [{ kind: "nope" }] }), /"touched" must be/],
    [JSON.stringify({ ...whole, spent: { steps: 1, calls: 0 } }), /"spent" must be/],
    [
      JSON.stringify({
        ...whole,
        waiting: { what: "an answer", asked: ASKED, until: "soon" },
      }),
      /"waiting" must be null or what the run waits for/,
    ],
    [
      JSON.stringify({
        ...whole,
        authorisations: [{ what: "send", by: "s", at: AT, from: ASKED }],
      }),
      /"authorisations" must be a list of authorisations/,
    ],
    [
      JSON.stringify({ ...whole, state: "done", ended: null }),
      /"ended" must be there exactly when/,
    ],
    [
      JSON.stringify({
        ...whole,
        waiting: QUESTION,
        state: "done",
        ended: { at: AT, why: "the answer came" },
      }),
      /unless it ended blocked on a person/,
    ],
    [
      JSON.stringify({
        ...whole,
        state: "blocked",
        ended: { at: AT, why: "a person has to say" },
      }),
      /"waiting" must name the question a run blocked on a person left/,
    ],
    [
      JSON.stringify({ ...whole, startedBy: { rule: null, instruction: null } }),
      /"startedBy" must name/,
    ],
  ] as const;

  for (const [text, expectation] of bad) {
    const parsed = parseRunDocumentDetailed(text);
    assert.ok("problem" in parsed, `${text} is refused`);
    assert.match(parsed.problem, expectation);
  }
});
