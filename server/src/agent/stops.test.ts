import assert from "node:assert/strict";
import { test } from "node:test";
import { askToStop, forgetStop, stopAsked } from "./stops.js";

/**
 * A stop asked of a run, before its document knows.
 *
 * The compare-and-set alone is a race the loop can win for ever — it writes a
 * step every few seconds — so a press that loses every attempt answers "the run
 * moved" and the run carries on (`{"stopped":2,"left":2}`, live on 2026-10-27).
 * The ask is what the loop reads before its next write; these pin the three
 * facts the mechanism rests on: it is per run, it carries who asked, and it is
 * forgotten once the document carries the ending.
 */

test("an ask is remembered per account and run, with who asked", () => {
  askToStop("a1", "r1", "sam@example.com");
  const ask = stopAsked("a1", "r1");
  assert.equal(ask?.by, "sam@example.com");
  assert.ok(ask?.at, "the ending's sentence carries when it was asked");

  assert.equal(
    stopAsked("a1", "r2"),
    undefined,
    "another run of the account is untouched",
  );
  assert.equal(
    stopAsked("a2", "r1"),
    undefined,
    "the same id under another account is another run",
  );
});

test("a later press replaces the ask it supersedes", () => {
  askToStop("a1", "r9", "first@example.com");
  askToStop("a1", "r9", "second@example.com");
  assert.equal(stopAsked("a1", "r9")?.by, "second@example.com");
});

test("forgetting the ask is the end of it", () => {
  askToStop("a1", "r7", "sam@example.com");
  forgetStop("a1", "r7");
  assert.equal(stopAsked("a1", "r7"), undefined);
});
