import assert from "node:assert/strict";
import { test } from "node:test";
import type { RowDoc } from "../shared/outbound.js";
import { todayQueue } from "./queue.js";

const now = new Date("2026-10-28T10:00:00Z");

const row = (over: Partial<RowDoc> = {}): RowDoc => ({
  version: 1,
  uid: "r1",
  campaignUid: "c1",
  e164: "+393331234567",
  extension: null,
  label: { company: null, name: null },
  cardUid: null,
  state: "open",
  claim: null,
  nextCallAt: null,
  calls: [],
  trimmed: 0,
  createdAt: "2026-10-28T09:00:00Z",
  ...over,
});

const claim = (by: string, until: string) => ({ by, at: "2026-10-28T09:55:00Z", until });

test("the work that is late comes before the work without a date", () => {
  const late = row({ uid: "late", nextCallAt: "2026-10-28T09:00:00Z" });
  const free = row({ uid: "free", createdAt: "2026-10-20T09:00:00Z" });
  const { queue, due, upcoming } = todayQueue([free, late], { caller: "sam", now });
  assert.deepEqual(
    queue.map((r) => r.uid),
    ["late", "free"],
  );
  assert.equal(due, 1);
  assert.equal(upcoming, 0);
});

test("a row I have started comes first, so I can finish it", () => {
  const started = row({ uid: "started", claim: claim("sam", "2026-10-28T10:15:00Z") });
  const late = row({ uid: "late", nextCallAt: "2026-10-28T08:00:00Z" });
  const { queue } = todayQueue([late, started], { caller: "sam", now });
  assert.equal(queue[0].uid, "started");
});

test("a row another caller holds is not offered, and is counted", () => {
  const theirs = row({ uid: "theirs", claim: claim("anna", "2026-10-28T10:15:00Z") });
  const { queue, heldByOthers } = todayQueue([theirs], { caller: "sam", now });
  assert.deepEqual(queue, []);
  assert.equal(heldByOthers, 1);
});

test("a claim that has lapsed is free again", () => {
  const abandoned = row({
    uid: "abandoned",
    claim: claim("anna", "2026-10-28T09:59:00Z"),
  });
  const { queue, heldByOthers } = todayQueue([abandoned], { caller: "sam", now });
  assert.deepEqual(
    queue.map((r) => r.uid),
    ["abandoned"],
  );
  assert.equal(heldByOthers, 0);
});

test("a call due later is not in Today, and is counted", () => {
  const later = row({ uid: "later", nextCallAt: "2026-10-29T09:00:00Z" });
  const { queue, upcoming } = todayQueue([later], { caller: "sam", now });
  assert.deepEqual(queue, []);
  assert.equal(upcoming, 1);
});

test("a row that is settled is not work", () => {
  const done = row({ uid: "done", state: "done" });
  const dropped = row({ uid: "dropped", state: "dropped" });
  const result = todayQueue([done, dropped], { caller: "sam", now });
  assert.deepEqual(result.queue, []);
  assert.equal(result.due + result.upcoming + result.heldByOthers, 0);
});

test("the limit cuts the queue and not the count", () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    row({ uid: `r${index}`, nextCallAt: `2026-10-28T0${index}:00:00Z` }),
  );
  const { queue, due } = todayQueue(rows, { caller: "sam", now, limit: 2 });
  assert.equal(queue.length, 2);
  assert.equal(due, 5);
});
