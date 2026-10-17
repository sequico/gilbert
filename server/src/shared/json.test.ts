import assert from "node:assert/strict";
import { test } from "node:test";
import { isInstant, isRecord, isStringArray, isStringMap } from "./json.js";

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

test("a string map is a record whose values are all strings", () => {
  // The shape behind the `{ by, at }` stamps and a workorder checklist's
  // `variants`, shared so every reader accepts the same documents.
  assert.equal(isStringMap({}), true, "a document with nothing stamped yet");
  assert.equal(isStringMap({ a: "", b: "x" }), true);
  assert.equal(isStringMap({ a: 1 }), false);
  assert.equal(isStringMap({ a: null }), false);
  assert.equal(isStringMap({ a: ["x"] }), false);
  assert.equal(isStringMap({ a: { b: "x" } }), false, "a nested object is not a string");
  assert.equal(isStringMap([]), false, "an array is not a map");
  assert.equal(isStringMap(null), false);
  assert.equal(isStringMap("x"), false);
});

test("a string array is a list whose entries are all strings", () => {
  assert.equal(isStringArray([]), true);
  assert.equal(isStringArray(["a", "b"]), true);
  assert.equal(isStringArray(["a", 1]), false);
  assert.equal(isStringArray([["a"]]), false);
  assert.equal(isStringArray({ 0: "a" }), false, "a record is not a list");
  assert.equal(isStringArray(null), false);
});

test("an instant is a date this build can order a document by", () => {
  assert.equal(isInstant("2026-10-17T09:30:00.000Z"), true, "an ISO instant is one");
  assert.equal(isInstant("not a date"), false, "text that parses as nothing is not");
  assert.equal(isInstant(null), false, "and neither is a missing one");
  assert.equal(isInstant(1760000000000), false, "a number is not this document's date");
});
