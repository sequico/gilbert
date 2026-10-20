/**
 * The run's shape and its transitions (ADR 0030) — no server, no I/O.
 *
 * What a transition does is the whole of what is pinned here: a run ends in one
 * of three ways and says which, a step's outcome is recorded where it belongs,
 * the plan grows with the step the model chose — a step may wait on an earlier
 * one and be left unrun when no branch names its outcome — what the run touched,
 * which facts of the installation's memory it recalled, and what it
 * spent are written by a transition each, an authorisation carries the sentence
 * it arrived in, the authority that was given and the act it is for, and the
 * wait is a date in the
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
  recordRecall,
  recordStep,
  spendRun,
  startRun,
  takeAuthorisation,
  touchObject,
  waitDueAt,
  waitUntil,
} from "./run.js";

const START = {
  rule: "intake",
  instruction: null,
  woke: "mail created: m-1",
} as const;
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
  assert.deepEqual(run.recalled, [], "and recalled nothing");
  assert.deepEqual(run.evidence, []);
  assert.deepEqual(run.authorisations, []);
  assert.deepEqual(run.spent, { steps: 0, calls: 0, ms: 0 });
  assert.equal(run.v, RUN_VERSION);
  assert.deepEqual(
    run.plan,
    [
      { what: "read the mail", state: "open", outcome: "", needs: null },
      { what: "file it", state: "open", outcome: "", needs: null },
    ],
    "every step the plan names is open, waits on nothing and has not ended",
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

test("a document written before the start instant is read, without inventing one", () => {
  const started = startRun({ id: "r1", startedBy: START });
  assert.match(started.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  const older: Record<string, unknown> = { ...started };
  delete older.startedAt;
  const stored = parseRunDocumentDetailed(JSON.stringify(older));
  assert.ok("run" in stored, "an older document stays readable");
  assert.equal(stored.run.startedAt, undefined, "and keeps no instant it never had");

  const bad = parseRunDocumentDetailed(
    JSON.stringify({ ...started, startedAt: "yesterday" }),
  );
  assert.ok("problem" in bad, "a start instant that is not one is refused");
});

test("a step records how it ended, and a run that ended does not act again", () => {
  const run = startRun({ id: "r2", startedBy: START, plan: ["one", "two"] });

  const afterOne = recordStep(run, 0, { state: "done", outcome: "filed it" });
  assert.deepEqual(afterOne.plan[0], {
    what: "one",
    state: "done",
    outcome: "filed it",
    needs: null,
  });
  assert.deepEqual(
    afterOne.plan[1],
    { what: "two", state: "open", outcome: "", needs: null },
    "the other steps are left as they were",
  );
  assert.deepEqual(run.plan[0], {
    what: "one",
    state: "open",
    outcome: "",
    needs: null,
  });
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
    { what: "answer the shipper", state: "open", outcome: "", needs: null },
    "and it starts open and waits on nothing, like every step the plan names by itself",
  );
  assert.equal(run.plan.length, 1, "the run it was given is untouched");
  assert.throws(() => appendStep(run, ""), /needs what it is/);
  assert.throws(
    () => appendStep(finishRun(run, "done", { at: AT, why: "over" }), "one more"),
    /has ended/,
  );
});

test("a step may wait on an earlier step, and is left unrun when no branch names its outcome", () => {
  const run = startRun({ id: "r14", startedBy: START, plan: ["file the confirmation"] });

  const planned = appendStep(run, "tell the shipper", { step: 0, when: "done" });
  assert.deepEqual(
    planned.plan[1]?.needs,
    { step: 0, when: "done" },
    "a step says which step it waits on and the outcome it needs",
  );
  assert.equal(planned.plan[1]?.state, "open", "and it starts open like any other");
  assert.throws(
    () => appendStep(run, "waiting on nothing there", { step: 5, when: "done" }),
    /no step 5 to wait on/,
    "a step cannot wait on a step the plan does not already carry",
  );

  // The step it waited on ends the other way: no branch names that outcome, so
  // the step is left unrun and its own record says which step and outcome did.
  const denied = recordStep(planned, 0, {
    state: "failed",
    outcome: "refused: no authority",
  });
  const left = recordStep(denied, 1, {
    state: "skipped",
    outcome: "left unrun: it waits on step 1 ending done, and that step ended failed",
  });
  assert.equal(left.plan[1]?.state, "skipped", "a step no branch reaches is not run");

  const stored = parseRunDocumentDetailed(JSON.stringify(left));
  assert.ok(
    "run" in stored,
    "a plan with a dependency and a skipped step is a document this build reads",
  );
  assert.deepEqual(stored.run.plan[1]?.needs, { step: 0, when: "done" });
  assert.equal(stored.run.plan[1]?.state, "skipped");
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

test("a run records which facts of the installation's memory it recalled", () => {
  const run = startRun({ id: "r15", startedBy: START });

  const recalled = recordRecall(run, ["f-1", "f-2"]);
  assert.deepEqual(
    recalled.recalled,
    ["f-1", "f-2"],
    "what the memory gave its calls is on the run, as references to the sheets",
  );
  assert.deepEqual(
    recordRecall(recalled, ["f-2", "f-3"]).recalled,
    ["f-1", "f-2", "f-3"],
    "a later call adds what it carried and repeats nothing",
  );
  assert.deepEqual(run.recalled, [], "the run it was given is untouched");
  assert.throws(() => recordRecall(run, [""]), /is not one/);
  assert.throws(
    () => recordRecall(finishRun(run, "done", { at: AT, why: "over" }), ["f-1"]),
    /has ended/,
  );

  const stored = parseRunDocumentDetailed(JSON.stringify(recalled));
  assert.ok("run" in stored, "and the list is part of the stored contract");
  assert.deepEqual(stored.run.recalled, ["f-1", "f-2"]);

  // The version before this one carries no `recalled` list, because the field
  // did not exist when it was written: it reads with an empty one rather than
  // being refused, so an installation that ran the build before this one keeps
  // working its runs.
  const { recalled: _none, ...older } = recalled;
  const readOlder = parseRunDocumentDetailed(JSON.stringify({ ...older, v: 4 }));
  assert.ok("run" in readOlder, "the version before this one is a run this build reads");
  assert.deepEqual(readOlder.run.recalled, [], "with nothing recalled");
  assert.equal(
    readOlder.run.v,
    RUN_VERSION,
    "and it reads as the version this build writes",
  );
  assert.equal(readOlder.run.id, "r15", "with the rest of the document untouched");
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

test("an authorisation says which authority it is, and which act it is for", () => {
  const run = startRun({ id: "r11", startedBy: START });

  const sent = takeAuthorisation(run, {
    what: "send the confirmation",
    authority: "outward",
    act: { target: "shipper@example.com", content: "the booking is confirmed" },
    by: "sam@example.com",
    at: AT,
    from: { channel: "mail", id: "m-42" },
  });
  const overridden = takeAuthorisation(sent, {
    what: "file it outside the policy",
    authority: "override",
    act: { target: "wo-1", content: null },
    by: "admin@example.com",
    at: AT,
    from: { channel: "chat", id: "node-9" },
  });

  assert.deepEqual(
    overridden.authorisations.map((authorisation) => authorisation.authority),
    ["outward", "override"],
    "a send and an override are told apart by the field, never by reading the prose",
  );
  assert.deepEqual(
    overridden.authorisations[0]?.act,
    { target: "shipper@example.com", content: "the booking is confirmed" },
    "and each names the act it is for, which is what the guard compares",
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
        act: { target: "a@example.com", content: null },
        by: "sam@example.com",
        at: AT,
        from: { channel: "mail", id: "m-1" },
      }),
    /cannot take that authorisation/,
  );
  assert.throws(
    () =>
      takeAuthorisation(run, {
        what: "a send that names nothing to send to",
        authority: "outward",
        act: { target: "", content: null },
        by: "sam@example.com",
        at: AT,
        from: { channel: "mail", id: "m-1" },
      }),
    /cannot take that authorisation/,
    "an authority for no act would authorise every act of its class",
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

test("the run answers when its wait is due, and a dateless or stopped wait has no date", () => {
  const run = startRun({ id: "r13", startedBy: START });
  assert.equal(waitDueAt(run), null, "a run that is not waiting has no date");
  assert.equal(
    waitDueAt(waitUntil(run, QUESTION)),
    null,
    "a wait on a person is a question, not an instant",
  );

  const dated = waitUntil(run, { what: "the booking window", asked: ASKED, until: AT });
  assert.equal(waitDueAt(dated), AT, "a dated wait answers its own instant");

  // A date kept beside an ending is not a wait: the run has stopped, and firing
  // it would start a run whose end nobody re-opened.
  const stopped = finishRun(dated, "blocked", { at: AT, why: "a person must decide" });
  assert.equal(stopped.waiting?.until, AT, "the blocked run keeps the question it left");
  assert.equal(waitDueAt(stopped), null, "and its date is no longer a wait");
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
    startedBy: {
      rule: null,
      instruction: { channel: "chat", id: "node-7" },
      woke: null,
    },
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
    ['{"v":6,"id":"r6"}', /this build reads version 5/],
    // The one version before this is read (with `recalled` empty); anything
    // older is a document this build did not write.
    ['{"v":3,"id":"r3"}', /this build reads version 5/],
    [
      '{"v":5,"id":"","startedBy":{"rule":"a","instruction":null,"woke":"mail created: m-1"}}',
      /"id" must be/,
    ],
    [
      '{"v":5,"id":"r6","startedBy":{"rule":"a","instruction":null,"woke":"mail created: m-1"}}',
      /"plan" must be a list of steps/,
    ],
    // A step this build writes carries what it waits on; one without it is a
    // document a build before this one wrote.
    [
      JSON.stringify({ ...whole, plan: [{ what: "a", state: "open", outcome: "" }] }),
      /"plan" must be a list of steps/,
    ],
    // A step waits only on a step defined before it: waiting forward, or on
    // itself, is a cycle this build's own loop cannot write.
    [
      JSON.stringify({
        ...whole,
        plan: [
          { what: "a", state: "open", outcome: "", needs: null },
          {
            what: "b",
            state: "open",
            outcome: "",
            needs: { step: 1, when: "done" },
          },
        ],
      }),
      /wait on a step the plan already carries/,
    ],
    [
      JSON.stringify({
        ...whole,
        plan: [
          { what: "a", state: "open", outcome: "", needs: { step: 0, when: "done" } },
        ],
      }),
      /wait on a step the plan already carries/,
    ],
    // A branch names an outcome a step can end with, and nothing else.
    [
      JSON.stringify({
        ...whole,
        plan: [
          { what: "a", state: "open", outcome: "", needs: { step: 0, when: "maybe" } },
        ],
      }),
      /"plan" must be a list of steps/,
    ],
    [
      JSON.stringify({
        ...whole,
        startedBy: { rule: "a", instruction: null },
      }),
      /"startedBy" must name/,
    ],
    [
      JSON.stringify({
        ...whole,
        startedBy: { rule: "a", instruction: null, woke: null },
      }),
      /"startedBy" must name/,
      // A rule is woken by a change, so a rule-started run that names no change
      // is a document this build did not write.
    ],
    [JSON.stringify({ ...whole, touched: [{ kind: "nope" }] }), /"touched" must be/],
    [
      JSON.stringify({ ...whole, recalled: ["f-1", ""] }),
      /"recalled" must be the ids of the facts/,
    ],
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
      JSON.stringify({
        ...whole,
        // An authority the document does not bind to an act is the class-only
        // authority ADR 0028 refuses: it would authorise every act of its class.
        authorisations: [
          { what: "send", authority: "outward", by: "s", at: AT, from: ASKED },
        ],
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
