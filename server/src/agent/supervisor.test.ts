/**
 * The supervisor's own behaviour, pinned without a model or a mail server (ADR 0038).
 *
 * What is tested here is the one thing that goes wrong without a line: a pass that
 * never returns. Every call inside a pass has its own timeout, so a pass still
 * running after `PASS_WATCHDOG_MS` is the loop stuck where no timeout reaches — and
 * left alone it holds the schedule for ever, which reads as an idle agent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { PASS_WATCHDOG_MS, supervise } from "./supervisor.js";

test("a pass that does not return is abandoned, said, and replaced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lines: string[] = [];
  let started = 0;
  const loop = {
    pass: async () => {
      started += 1;
      // The first pass never returns; the one the watchdog starts does.
      if (started === 1) await new Promise<void>(() => {});
      return {
        claimed: true,
        accounts: 1,
        changes: 0,
        runs: 0,
        due: 0,
        tokens: 0,
        ms: 1,
        gaps: [],
      };
    },
    stop: () => {},
  };
  const agent = supervise({
    loop,
    // Long enough that the interval never fires inside this test: the watchdog is
    // the only clock here.
    intervalMs: 24 * 60 * 60_000,
    log: (line) => lines.push(line),
  });
  await settle();
  assert.equal(started, 1, "the first pass starts at once");

  t.mock.timers.tick(PASS_WATCHDOG_MS);
  await settle();
  assert.match(
    lines.join("\n"),
    /had not returned in 5 minutes, so it was abandoned and the next one starts/,
    "the abandonment is said, not silent",
  );

  // The kick the watchdog asked for is debounced, like any other.
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(started, 2, "and the next pass starts while the stuck one is behind it");

  await agent.stop();
});
