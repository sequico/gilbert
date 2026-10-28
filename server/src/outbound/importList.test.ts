import assert from "node:assert/strict";
import { test } from "node:test";
import { planImport } from "./importList.js";

const now = new Date("2026-10-28T10:00:00Z");
let seq = 0;
const newUid = () => `r${++seq}`;

const plan = (
  text: string,
  doNotCall: string[] = [],
  cards: Record<string, string> = {},
) => {
  seq = 0;
  return planImport({ campaignUid: "c1", text, doNotCall, cards, now, newUid });
};

test("each line becomes one row, with the words around its number kept", () => {
  const result = plan("ACME, chiedi di Tizio, +39 333 123 4567\n+39 02 1234567");
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].e164, "+393331234567");
  assert.equal(result.rows[0].context, "ACME, chiedi di Tizio");
  assert.equal(result.rows[1].e164, "+39021234567");
  assert.equal(result.rows[1].context, null);
});

test("a line without a number is refused, not skipped in silence", () => {
  const result = plan("ACME\nMilano\n");
  assert.deepEqual(
    result.refused.map((entry) => entry.reason),
    ["no_number", "no_number"],
  );
  assert.equal(result.rows.length, 0);
});

test("a number that cannot be resolved is refused with its reason", () => {
  const result = plan("02 1234567 — Milano");
  assert.deepEqual(result.refused, [
    { line: "02 1234567 — Milano", reason: "no_country" },
  ]);
});

test("a number given twice in one paste is counted once, and written once", () => {
  const result = plan("+39 333 1234567\n+39.333.123.4567\n+39 02 1234567");
  assert.equal(result.rows.length, 2);
  assert.equal(result.duplicate, 1);
});

test("a number the installation promised never to call is counted and not written", () => {
  const result = plan("+39 333 1234567\n+39 02 1234567", ["+393331234567"]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].e164, "+39021234567");
  assert.equal(result.blocked, 1);
});

test("the extension leaves the line and stays on the row", () => {
  const result = plan("+39 02 1234567 int. 24");
  assert.equal(result.rows[0].extension, "24");
  assert.equal(result.rows[0].context, null);
});

test("a row arrives open, unclaimed and with an empty window", () => {
  const [row] = plan("+39 333 1234567").rows;
  assert.equal(row.state, "open");
  assert.equal(row.claim, null);
  assert.equal(row.nextCallAt, null);
  assert.deepEqual(row.calls, []);
  assert.equal(row.trimmed, 0);
  assert.equal(row.cardUid, null);
});

test("a number the group's cards carry becomes a row pointed at that card", () => {
  const result = plan("+39 02 1234567\n+39 06 12345678", [], {
    "+39021234567": "card-1",
  });
  assert.equal(result.matched, 1);
  assert.equal(result.rows[0].cardUid, "card-1");
  assert.equal(result.rows[1].cardUid, null);
});

test("blank lines are not lines", () => {
  assert.deepEqual(plan("\n\n  \n").rows, []);
  assert.deepEqual(plan("\n\n  \n").refused, []);
});
