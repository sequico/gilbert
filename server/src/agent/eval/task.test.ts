/**
 * The refusal counter the eval reads from a run (ADR 0038).
 *
 * The two numbers are the interface's measure: how many steps were refused, and
 * how many of those the run recovered from. They are counted from the record —
 * a `failed` step, and a later step that is not one — so a run that repeated the
 * same invented name cannot look like one that fixed it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { RunStepState } from "../../shared/run.js";
import { refusedAndRecovered } from "./task.js";

/** A plan of steps, as the record keeps them, by their state alone. */
function plan(...states: RunStepState[]): Array<{ state: RunStepState }> {
  return states.map((state) => ({ state }));
}

test("a run that recovered from its refusal counts the refusal and the recovery", () => {
  assert.deepEqual(refusedAndRecovered(plan("failed", "done")), {
    refused: 1,
    recovered: 1,
  });
});

test("a run that repeated the same refusal recovers from nothing", () => {
  /*
   * The failure ADR 0038 was written about: the model came back with the same
   * invented name because nothing had told it what the catalogue holds. Two
   * refusals, no recovery — and a ratio would have called it one of two.
   */
  assert.deepEqual(refusedAndRecovered(plan("failed", "failed")), {
    refused: 2,
    recovered: 0,
  });
});

test("every refusal followed by a step that worked is recovered", () => {
  assert.deepEqual(refusedAndRecovered(plan("failed", "failed", "done")), {
    refused: 2,
    recovered: 2,
  });
});

test("a step the run never reached does not count as a recovery", () => {
  /*
   * A branch no outcome reaches is `skipped`, and a step still `open` has proved
   * nothing: neither is a call the catalogue kept, so a plan that failed and then
   * skipped recovered from nothing.
   */
  assert.deepEqual(refusedAndRecovered(plan("failed", "skipped")), {
    refused: 1,
    recovered: 0,
  });
  assert.deepEqual(refusedAndRecovered(plan("failed", "open")), {
    refused: 1,
    recovered: 0,
  });
  assert.deepEqual(refusedAndRecovered(plan("failed", "skipped", "done")), {
    refused: 1,
    recovered: 1,
  });
});

test("a plan with no refusal counts nothing, and reports nothing recovered", () => {
  assert.deepEqual(refusedAndRecovered(plan("done", "done")), {
    refused: 0,
    recovered: 0,
  });
  assert.deepEqual(refusedAndRecovered([]), { refused: 0, recovered: 0 });
});
