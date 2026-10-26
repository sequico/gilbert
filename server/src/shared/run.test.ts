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
 * wait is a date in the document — an instant the run waits for, or the deadline
 * a question to a person carries, whose coming due sends the run on without the
 * answer. The
 * parser's half is the other side of the same contract: a run this build did not
 * write is reported rather than read as an empty one, and a field it does not
 * know does not refuse a run that is otherwise whole.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerOverdue,
  appendStep,
  compactAt,
  compactRun,
  finishRun,
  isRunDue,
  NOTE_MAX,
  parseRunDocumentDetailed,
  QUESTION_TTL_MS,
  RUN_VERSION,
  recordEvidence,
  recordRecall,
  recordStep,
  setNote,
  spendRun,
  startRun,
  stepIdentity,
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

/**
 * A step's line is clipped at four kilobytes, so the line cannot be the step's
 * identity: two writes whose texts share an opening are one line there, and the
 * second would be answered from the first. The digest of the whole call travels
 * beside the line, and a document written before it still answers to its line.
 */
test("a step keeps the identity of the whole call it made, beside its readable line", () => {
  const run = startRun({ id: "r15", startedBy: START, plan: ["read the mail"] });

  const asked = appendStep(run, 'probe.write {"text":"…"}', null, "digest-one");
  assert.equal(asked.plan[1]?.ask, "digest-one", "the digest is written with the step");
  assert.equal(
    asked.plan[1]?.what,
    'probe.write {"text":"…"}',
    "and the line is what a reader reads",
  );

  const ended = recordStep(asked, 1, { state: "done", outcome: "saved" });
  assert.equal(ended.plan[1]?.ask, "digest-one", "ending the step keeps it");
  assert.equal(
    stepIdentity(ended.plan[1]!),
    "digest-one",
    "and it is what the step answers to",
  );

  const legacy = recordStep(run, 0, { state: "done", outcome: "read" });
  assert.equal(
    stepIdentity(legacy.plan[0]!),
    "read the mail",
    "a document written before the digest answers to its line",
  );
  const stored = parseRunDocumentDetailed(JSON.stringify(ended));
  assert.ok(
    "run" in stored,
    "and a step that carries one is a document this build reads",
  );

  const broken = parseRunDocumentDetailed(
    JSON.stringify({
      ...ended,
      plan: [ended.plan[0], { ...ended.plan[1], ask: 7 }],
    }),
  );
  assert.ok("problem" in broken, "a digest that is not a string is refused");
});

test("a step keeps the time its call took, and a run the limits in force", () => {
  /*
   * The record's answer to "where did the run's time go, and what held it": a
   * step is one call to the account and carries its own milliseconds, and the run
   * records the limits that were in force when it opened — recorded, never
   * enforced, so a pass that fell back to the defaults is visible in the run it
   * paid for (ADR 0038).
   */
  const run = startRun({
    id: "r16",
    startedBy: START,
    limits: { maxRunTokens: 200_000, maxRunSteps: 40, maxDailyTokens: 4_000_000 },
  });
  const asked = recordStep(appendStep(run, 'read {"kind":"message","id":"m-1"}'), 0, {
    state: "done",
    outcome: "the body",
    ms: 120,
  });
  assert.equal(asked.plan[0]?.ms, 120, "a step says how long its own call took");

  const stored = parseRunDocumentDetailed(JSON.stringify(asked));
  assert.ok("run" in stored, "the document reads back");
  assert.equal(
    stored.run.limits?.maxDailyTokens,
    4_000_000,
    "and the run what was in force when it opened",
  );

  const bad = parseRunDocumentDetailed(
    JSON.stringify({ ...asked, limits: { maxRunTokens: "many" } }),
  );
  assert.ok("problem" in bad, "a limits shape that is not three numbers is refused");
});

test("a case note is kept whole, cut at its bound, and cleared when empty", () => {
  /*
   * The scratchpad the instruction asks for: carried whole on every turn, so it is
   * bounded where it is written — the model sees the cut in its own answer and
   * rewrites it — and what must outlive the case is a fact in the memory, not a
   * longer note (ADR 0033, 0034).
   */
  const run = startRun({ id: "r17", startedBy: START });
  const noted = setNote(
    run,
    "  BK-901 · folder MS2/BK-901 · naming: <ref> <container>  ",
  );
  assert.equal(
    noted.note,
    "BK-901 · folder MS2/BK-901 · naming: <ref> <container>",
    "trimmed, as the model wrote it",
  );
  const stored = parseRunDocumentDetailed(JSON.stringify(noted));
  assert.ok("run" in stored, "the document reads back");
  assert.equal(stored.run.note, noted.note, "with the note it kept");

  const huge = setNote(run, "x".repeat(NOTE_MAX + 100));
  assert.equal(huge.note?.length, NOTE_MAX + 1, "cut at the bound, with the cut visible");
  assert.equal(setNote(noted, "   ").note, undefined, "an empty note is no note");

  const bad = parseRunDocumentDetailed(JSON.stringify({ ...noted, note: 7 }));
  assert.ok("problem" in bad, "a note that is not text is refused");
});

test("a long transcript is folded up to a mark, and the mark only moves forward", () => {
  /*
   * The turn is a transcript (ADR 0038), so what bounds it is a summary: the steps
   * above the mark are the ones carried whole, and the rest keep their place as one
   * line each. The mark is a fact about the turn, never a claim about the record:
   * every outcome stays on the run in full.
   */
  let run = startRun({ id: "r18", startedBy: START });
  for (let at = 0; at < 18; at += 1) {
    run = appendStep(run, `read ${at}`);
    run = recordStep(run, run.plan.length - 1, {
      state: "done",
      outcome: "x".repeat(4 * 1024),
    });
  }
  assert.equal(
    compactAt(run),
    12,
    "eighteen steps of four kilobytes are folded up to the last six",
  );

  const folded = compactRun(run, 12);
  assert.equal(folded.compactedUpTo, 12, "the mark is on the run");
  assert.equal(folded.plan.length, 18, "and no step left the record");
  assert.equal(compactRun(folded, 1).compactedUpTo, 12, "the mark never moves back");
  assert.equal(compactAt(folded), null, "and what is left is short enough");

  const stored = parseRunDocumentDetailed(JSON.stringify(folded));
  assert.ok("run" in stored, "the document reads back");
  assert.equal(stored.run.compactedUpTo, 12, "with its mark");
  assert.ok(
    "problem" in
      parseRunDocumentDetailed(JSON.stringify({ ...folded, compactedUpTo: 19 })),
    "a mark past the plan is refused",
  );
  assert.throws(() => compactRun(folded, 99), /is not a step of the run/);
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

  // This version records which retrieval the run used, and the version before
  // it carries neither the field nor a `recalled` list: both read rather than
  // being refused, so an installation that ran an earlier build keeps working
  // its runs.
  const { recalled: _none, ...older } = recalled;
  const readOlder = parseRunDocumentDetailed(JSON.stringify({ ...older, v: 4 }));
  assert.ok("run" in readOlder, "the version before this one is a run this build reads");
  assert.deepEqual(readOlder.run.recalled, [], "with nothing recalled");
  assert.equal(
    readOlder.run.retrieval,
    "exact",
    "and the exact retrieval, the only one it had",
  );
  assert.equal(
    readOlder.run.v,
    RUN_VERSION,
    "and it reads as the version this build writes",
  );
  assert.equal(readOlder.run.id, "r15", "with the rest of the document untouched");

  const { retrieval: _unused, ...previous } = recalled;
  const readPrevious = parseRunDocumentDetailed(JSON.stringify({ ...previous, v: 5 }));
  assert.ok("run" in readPrevious, "the immediately previous version too");
  assert.equal(readPrevious.run.retrieval, "exact", "which recorded no retrieval");
  assert.deepEqual(readPrevious.run.recalled, ["f-1", "f-2"]);

  assert.equal(
    recordRecall(recalled, [], "exact+similarity").retrieval,
    "exact+similarity",
    "a similarity pass is recorded as what the run used",
  );
  assert.equal(
    recordRecall(recordRecall(run, ["f-1"], "exact+similarity"), [], "exact").retrieval,
    "exact+similarity",
    "and a later exact turn does not retract it",
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

test("the run answers when its wait is due, and a stopped wait has no date", () => {
  const run = startRun({ id: "r13", startedBy: START });
  assert.equal(waitDueAt(run), null, "a run that is not waiting has no date");
  assert.equal(
    waitDueAt(waitUntil(run, QUESTION)),
    null,
    "a question with no deadline is not an instant",
  );

  const dated = waitUntil(run, { what: "the booking window", asked: ASKED, until: AT });
  assert.equal(waitDueAt(dated), AT, "a dated wait answers its own instant");

  // A date kept beside a stop is not a wait: the run has ended, and firing it
  // would start a run whose end nobody re-opened.
  const stopped = finishRun(dated, "cancelled", { at: AT, why: "a person stopped it" });
  assert.equal(waitDueAt(stopped), null, "and its date is no longer a wait");
});

test("a run a guardrail stopped ends refused, and the record says which check", () => {
  /*
   * A guardrail is not the clock: a run stopped because a check fired says
   * `refused`, with the check and what it found, so a reader is not told it ran
   * out of budget (ADR 0030, 0038).
   */
  const running = startRun({
    id: "guardrail",
    startedBy: { rule: null, instruction: null, woke: "mail created: m-1" },
  });
  const stopped = finishRun(running, "refused", {
    at: AT,
    why: "the tool answer carried a credential, so it was not handed to the model",
  });
  assert.equal(stopped.state, "refused");
  assert.match(stopped.ended?.why ?? "", /carried a credential/);
  const read = parseRunDocumentDetailed(JSON.stringify(stopped));
  assert.ok("run" in read, "and a document carrying it is still read by this build");
  assert.equal(read.run.state, "refused");
});

test("a question carries a deadline, and coming due sends the run on without the answer", () => {
  /*
   * The one case nothing else covers: a person who never answers. The question's
   * deadline is the run's own date (ADR 0029, 0030), so the alarm the agent arms
   * from the document is what comes due — and the work goes on without the
   * answer, with a step that says what did not come, instead of waiting for ever.
   */
  const run = startRun({ id: "r14", startedBy: START });
  const deadline = new Date(Date.parse(AT) + QUESTION_TTL_MS).toISOString();
  const blocked = finishRun(waitUntil(run, { ...QUESTION, until: deadline }), "blocked", {
    at: AT,
    why: "the answer has to come from a person",
  });
  assert.equal(
    isRunDue(blocked, new Date(Date.parse(deadline) - 1)),
    false,
    "before the deadline the run is still waiting on the person",
  );
  assert.equal(
    isRunDue(blocked, new Date(deadline)),
    true,
    "and at the deadline it is the run's own date",
  );

  const resumed = answerOverdue(blocked, deadline);
  assert.equal(resumed.state, "running", "the work goes on without the answer");
  assert.equal(resumed.waiting, null, "the question is no longer the run's to wait on");
  assert.equal(resumed.ended, null, "a running run carries no ending");
  assert.equal(resumed.spent.steps, blocked.spent.steps + 1, "the step it took is spent");
  assert.equal(resumed.plan.at(-1)?.state, "failed", "and the record says it failed");
  assert.match(
    resumed.plan.at(-1)?.outcome ?? "",
    /nobody answered it within the deadline/,
  );

  assert.throws(() => answerOverdue(run, deadline), /not waiting on an answer/);
  assert.throws(
    () => answerOverdue(blocked, "not an instant"),
    /not an instant/,
    "an overdue question names the instant it came due",
  );
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

test("a person stops a run that is waiting on them, and no other ending takes it", () => {
  /*
   * A run parked on a question is still in flight — nothing but an answer moves
   * it — and Stop on it did nothing, so the row stayed on screen and the person
   * saw a control that was not there. A stop is `cancelled`, which drops the
   * question; nothing else ends a blocked run, because only an answer continues
   * it (ADR 0029, 0030).
   */
  const blocked = finishRun(
    waitUntil(startRun({ id: "r13", startedBy: START }), QUESTION),
    "blocked",
    { at: AT, why: "the answer has to come from a person" },
  );
  const stopped = finishRun(blocked, "cancelled", { at: AT, why: "stopped by a member" });
  assert.equal(stopped.state, "cancelled", "the stop is the run's ending");
  assert.equal(stopped.waiting, null, "and the question it left is dropped with it");
  for (const ending of ["done", "out-of-budget", "blocked"] as const)
    assert.throws(
      () => finishRun(blocked, ending, { at: AT, why: "not a stop" }),
      /has ended \(blocked\)/,
      `"${ending}" is not how a run waiting on a person ends`,
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
    [JSON.stringify({ v: RUN_VERSION + 1, id: "r6" }), /this build reads version 6/],
    // The two versions before this are read (with the fields they lack
    // defaulted); anything older is a document this build did not write.
    ['{"v":3,"id":"r3"}', /this build reads version 6/],
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
