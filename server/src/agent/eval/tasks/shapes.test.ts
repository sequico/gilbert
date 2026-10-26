/**
 * The three tasks written from the failures of 2026-10-26, graded by hand.
 *
 * Their point is what the live runs did not do: file a delivery once, find the
 * reference in the thread instead of re-reading its own message, and report a list
 * whole without re-reading it. The graders are the tasks' own judgement, so they
 * are measured here against a measure a person would accept and against one they
 * would not — without a provider, which is why this is a test and the eval is not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Harness, RunMeasure } from "../task.js";
import { deliveryInPieces } from "./delivery-in-pieces.js";
import { listInOneMessage } from "./list-in-one-message.js";
import { threadReference } from "./thread-reference.js";

/** A measure as the run document answers one: nothing but what a task reads. */
function measure(over: Partial<RunMeasure> = {}): RunMeasure {
  return {
    run: "r-1",
    ending: "done",
    steps: 2,
    calls: 2,
    refused: 0,
    recovered: 0,
    said: null,
    tokens: 1000,
    cachedTokens: 600,
    ms: 1000,
    ...over,
  };
}

/** A harness holding only what these three tasks read. */
function harness(files: Record<string, string[]>): Harness {
  return {
    agent: "agent@example.org",
    subjectsIn: async (folder) => files[folder] ?? [],
  } as Harness;
}

test("a delivery in pieces is whole only when every item is filed", async () => {
  const all = harness({
    "BK-901": ["BK-901 (1 of 3)", "BK-901 (2 of 3)", "BK-901 (3 of 3)"],
  });
  assert.equal(await deliveryInPieces.grade(all, measure()), 1);

  const none = harness({});
  assert.equal(
    await deliveryInPieces.grade(none, measure()),
    0.25,
    "done and nothing filed",
  );

  const half = harness({ "BK-901": ["BK-901 (1 of 3)"] });
  assert.ok(
    (await deliveryInPieces.grade(half, measure({ ending: "out-of-budget" }))) < 0.5,
    "one of three filed and no ending is not half a delivery",
  );
});

test("a thread's reference counts only when the report carries it", async () => {
  const found = measure({ said: "BK-902: the papers are on the way" });
  assert.equal(await threadReference.grade(harness({}), found), 1);
  assert.equal(
    await threadReference.grade(
      harness({}),
      measure({ said: "the papers are on the way" }),
    ),
    0,
    "a report that does not name the booking is not the report asked for",
  );
});

test("a list in one message is cheap as well as whole", async () => {
  const whole = measure({
    said: "MRKU7862150, MRSU0039101, TGHU9988776, MSKU7654321, TCLU1122334",
    calls: 3,
  });
  assert.equal(await listInOneMessage.grade(harness({}), whole), 1);

  const four = measure({
    said: "MRKU7862150, MRSU0039101, TGHU9988776, MSKU7654321",
    calls: 3,
  });
  assert.ok(
    (await listInOneMessage.grade(harness({}), four)) < 0.8,
    "a missing item costs",
  );

  const slow = measure({
    said: "MRKU7862150, MRSU0039101, TGHU9988776, MSKU7654321, TCLU1122334",
    calls: 9,
  });
  assert.ok(
    (await listInOneMessage.grade(harness({}), slow)) < 1,
    "the same report at nineteen calls is not the same work",
  );
});
