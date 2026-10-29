import assert from "node:assert/strict";
import { test } from "node:test";
import type { RowDoc } from "../shared/outbound.js";
import { at } from "../testkit.js";
import { CLAIM_LEASE_MS, settleRow, takeRow } from "./rowActions.js";

const now = new Date("2026-10-28T10:00:00Z");
const outcome = "booked";

const row = (over: Partial<RowDoc> = {}): RowDoc => ({
  version: 1,
  uid: "r1",
  campaignUid: "c1",
  e164: "+393331234567",
  extension: null,
  context: null,
  cardUid: null,
  state: "open",
  claim: null,
  nextCallAt: null,
  calls: [],
  trimmed: 0,
  createdAt: "2026-10-28T09:00:00Z",
  ...over,
});

test("taking a row holds it for one lease", () => {
  const result = takeRow(row(), { by: "sam", now });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.claim?.by, "sam");
  assert.equal(
    result.row.claim?.until,
    new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(),
  );
});

test("a row another caller holds cannot be taken, and one's own can be re-taken", () => {
  const held = row({
    claim: { by: "anna", at: now.toISOString(), until: "2026-10-28T10:10:00Z" },
  });
  assert.deepEqual(takeRow(held, { by: "sam", now }), {
    ok: false,
    reason: "held_by_other",
  });
  assert.equal(takeRow(held, { by: "anna", now }).ok, true);
});

test("a lease that lapsed is free again", () => {
  const stale = row({
    claim: { by: "anna", at: now.toISOString(), until: "2026-10-28T09:59:00Z" },
  });
  assert.equal(takeRow(stale, { by: "sam", now }).ok, true);
});

test("a settled row is not work", () => {
  const done = row({ state: "done" });
  assert.deepEqual(takeRow(done, { by: "sam", now }), {
    ok: false,
    reason: "settled",
  });
});

test("a settlement records the call and releases the row", () => {
  const taken = takeRow(row(), { by: "sam", now });
  assert.equal(taken.ok, true);
  if (!taken.ok) return;
  const settled = settleRow(
    taken.row,
    { outcome, note: "wants a quote", by: "sam", at: now },
    [outcome],
  );
  assert.equal(settled.ok, true);
  if (!settled.ok) return;
  assert.equal(settled.row.state, "done");
  assert.equal(settled.row.claim, null);
  assert.equal(settled.row.nextCallAt, null);
  assert.deepEqual(
    settled.row.calls.map((call) => call.outcome),
    [outcome],
  );
});

test("a date settles the row for later, not for good", () => {
  const settled = settleRow(
    row(),
    { outcome, note: null, by: "sam", at: now, nextCallAt: "2026-11-02T09:00:00Z" },
    [outcome],
  );
  assert.equal(settled.ok, true);
  if (!settled.ok) return;
  assert.equal(settled.row.state, "open");
  assert.equal(settled.row.nextCallAt, "2026-11-02T09:00:00Z");
});

test("an outcome the campaign never named is refused, and nothing is written", () => {
  assert.deepEqual(
    settleRow(row(), { outcome: "whatever", note: null, by: "sam", at: now }, [outcome]),
    {
      ok: false,
      reason: "unknown_outcome",
    },
  );
});

test("a call that names somebody points the row at the card", () => {
  const settled = settleRow(
    row(),
    { outcome, note: null, by: "sam", at: now, cardUid: "card-9" },
    [outcome],
  );
  assert.equal(settled.ok, true);
  if (!settled.ok) return;
  assert.equal(settled.row.cardUid, "card-9");
  assert.equal(at(settled.row.calls, 0).cardUid, "card-9");
});
