import assert from "node:assert/strict";
import { test } from "node:test";
import { localDateOnly, localDateTime, pad2 } from "./localDateTime.js";

test("a datetime is the local wall clock, zero-padded, with no zone", () => {
  // 09:05:07 on 3 February: every component below ten, so a missing `pad2`
  // shows up as a shorter string rather than as a plausible one.
  const d = new Date(2026, 1, 3, 9, 5, 7);
  assert.equal(localDateTime(d), "2026-02-03T09:05:07");
});

test("it carries no UTC offset, at any hour", () => {
  // The property that makes it a wall clock: midnight and noon are named by
  // their local components whatever the runner's zone is, and `toISOString`
  // would move both.
  assert.equal(localDateTime(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01T00:00:00");
  assert.equal(localDateTime(new Date(2026, 11, 31, 23, 59, 59)), "2026-12-31T23:59:59");
});

test("a date is the same local day, without a time", () => {
  assert.equal(localDateOnly(new Date(2026, 1, 3, 23, 59, 59)), "2026-02-03");
  assert.equal(localDateOnly(new Date(2026, 1, 3, 0, 0, 0)), "2026-02-03");
});

test("padding is two digits", () => {
  assert.equal(pad2(0), "00");
  assert.equal(pad2(7), "07");
  assert.equal(pad2(31), "31");
});
