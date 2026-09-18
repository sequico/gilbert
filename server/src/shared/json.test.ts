import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "./json.js";

test("an object is a record", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(Object.create(null)), true);
});

test("an array is not, whatever it holds", () => {
  // What separates the two: every reader here takes fields off the value, and
  // a field read off an array is silently absent rather than wrong.
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([1, 2]), false);
  assert.equal(isRecord(JSON.parse("[1,2]")), false);
});

test("a scalar, null or undefined is not", () => {
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord(0), false);
  assert.equal(isRecord(""), false);
  assert.equal(isRecord("{}"), false);
  assert.equal(isRecord(true), false);
});
