import assert from "node:assert/strict";
import { test } from "node:test";
import { type ShutdownParts, shutDown } from "./shutdown.js";

/**
 * A shutdown that does not finish is a SIGKILL in the middle of its own steps.
 *
 * The deployment waits 90 s and then kills the process, which on 2026-10-27 left
 * the agent's loop opening runs after the signal. Every step here is therefore
 * bounded, the agent stops before anything is awaited, and the subscription
 * release still runs after a drain that never finished.
 */

/** A server whose close never calls back — an event stream nobody closed. */
const stuckServer = {
  close: () => undefined,
  closeIdleConnections: () => undefined,
  closeAllConnections: () => undefined,
};

/** The parts, with what each step did, in the order it did it. */
function parts(over: Partial<ShutdownParts> = {}): {
  seen: string[];
  exited: number[];
  parts: ShutdownParts;
} {
  const seen: string[] = [];
  const exited: number[] = [];
  return {
    seen,
    exited,
    parts: {
      server: stuckServer,
      stopAgent: async () => {
        seen.push("agent");
      },
      releaseSubscriptions: async () => {
        seen.push("subscriptions");
      },
      closeSessions: async () => {
        seen.push("sessions");
      },
      exit: (code) => exited.push(code),
      drainMs: 10,
      ...over,
    },
  };
}

test("the agent is stopped before the drain is waited on", async () => {
  const { seen, parts: p } = parts();
  // The drain hangs, so the order is what the array can show; the deadline is
  // what ends this test.
  await shutDown("SIGTERM", p);
  assert.deepEqual(seen, ["agent", "subscriptions", "sessions"]);
});

test("a drain that never closes still lets the rest run and the process exit", async () => {
  const { seen, exited, parts: p } = parts();
  const started = Date.now();
  await shutDown("SIGTERM", p);
  assert.ok(Date.now() - started < 1_000, "the drain was bounded, not waited out");
  assert.deepEqual(exited, [0], "the process exits, in order, rather than being killed");
  assert.ok(
    seen.includes("subscriptions"),
    "a credential is still live when the subscription is released",
  );
});

test("an agent that cannot stop is said, and does not hold the shutdown", async () => {
  const said: string[] = [];
  const {
    seen,
    exited,
    parts: p,
  } = parts({
    stopAgent: async () => {
      throw new Error("the claim store refused");
    },
    log: (line) => said.push(line),
  });
  await shutDown("SIGTERM", p);
  assert.deepEqual(exited, [0]);
  assert.ok(seen.includes("sessions"), "the steps after it still run");
  assert.ok(
    said.some((line) => line.includes("the agent did not stop cleanly")),
    "the failure is said, not swallowed",
  );
});
