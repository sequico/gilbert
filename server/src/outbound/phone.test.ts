import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNumber, normaliseNumber } from "./phone.js";

test("an international number is reduced to E.164", () => {
  assert.deepEqual(normaliseNumber("+39 02 1234 567"), { ok: true, e164: "+39021234567", extension: null });
  assert.deepEqual(normaliseNumber("+1 (415) 555-0100"), { ok: true, e164: "+14155550100", extension: null });
  assert.deepEqual(normaliseNumber("  +39.333.123.4567  "), { ok: true, e164: "+393331234567", extension: null });
});

test("the old international prefix is the same statement", () => {
  assert.deepEqual(normaliseNumber("0039 333 123 4567"), { ok: true, e164: "+393331234567", extension: null });
});

test("a normalised number normalises to itself", () => {
  const once = normaliseNumber("+39 333 123 4567");
  assert.equal(once.ok, true);
  assert.deepEqual(normaliseNumber((once as { e164: string }).e164), once);
});

test("a form that names its country is resolved, and keeps the country it named", () => {
  assert.deepEqual(normaliseNumber("39 333 123 4567"), { ok: true, e164: "+393331234567", extension: null });
  assert.deepEqual(normaliseNumber("260 977 123456"), { ok: true, e164: "+260977123456", extension: null });
});

test("a form without a country is refused, not guessed", () => {
  assert.deepEqual(normaliseNumber("02 1234567"), { ok: false, reason: "no_country" });
  assert.deepEqual(normaliseNumber("333 123 4567"), { ok: false, reason: "no_country" });
});

test("the extension leaves the number and comes back beside it", () => {
  assert.deepEqual(normaliseNumber("+39 02 1234567 int. 24"), {
    ok: true,
    e164: "+39021234567",
    extension: "24",
  });
  assert.deepEqual(normaliseNumber("+39 333 1234567 x24"), { ok: true, e164: "+393331234567", extension: "24" });
});

test("what is not a number is refused with its reason", () => {
  assert.deepEqual(normaliseNumber(""), { ok: false, reason: "empty" });
  assert.deepEqual(normaliseNumber("   "), { ok: false, reason: "empty" });
  assert.deepEqual(normaliseNumber("+39 000"), { ok: false, reason: "invalid" });
  assert.deepEqual(normaliseNumber("+39 333 123456789012"), { ok: false, reason: "invalid" });
});

test("a number shown to a person reads as a number, and never replaces it", () => {
  const shown = formatNumber("+39021234567");
  assert.ok(shown.startsWith("+39"));
  assert.ok(shown.includes("02"));
  assert.equal(formatNumber("not a number"), "not a number");
});
