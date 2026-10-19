import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit, READ_CONCURRENCY } from "./concurrency.js";

test("mapLimit keeps the order of its items whatever finishes first", async () => {
  const out = await mapLimit([3, 1, 2], 3, async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return ms * 10;
  });
  assert.deepEqual(out, [30, 10, 20]);
});

test("mapLimit runs no more than the bound at once", async () => {
  /*
   * The bound is the whole point: a walk that opened every document at once
   * would be a burst the mail server has to absorb. Fails if the workers
   * ignore `limit` or the function runs every item eagerly.
   */
  let running = 0;
  let peak = 0;
  await mapLimit(
    Array.from({ length: 20 }, (_, i) => i),
    4,
    async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    },
  );
  assert.equal(peak, 4);
});

test("mapLimit answers an empty list without running anything", async () => {
  let calls = 0;
  const out = await mapLimit([], READ_CONCURRENCY, async () => {
    calls += 1;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("mapLimit throws the first failure", async () => {
  await assert.rejects(
    mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("second failed");
      return n;
    }),
    /second failed/,
  );
});

test("mapLimit still runs every item when the bound is wider than the list", async () => {
  const out = await mapLimit([1, 2], 50, async (n) => n + 1);
  assert.deepEqual(out, [2, 3]);
});
