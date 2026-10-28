import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignPath,
  doNotCallPath,
  isCampaignDoc,
  isDoNotCallDoc,
  isRowDoc,
  MAX_CALLS_KEPT,
  rowPath,
  withCall,
  type CampaignDoc,
  type RowDoc,
} from "./outbound.js";

const campaign = (over: Partial<CampaignDoc> = {}): CampaignDoc => ({
  version: 1,
  uid: "c1",
  purpose: "book appointments for the new material",
  script: null,
  outcomes: [{ id: "booked", label: "Appointment booked" }],
  window: { from: null, to: null },
  state: "running",
  createdAt: "2026-10-28T09:00:00Z",
  createdBy: "sam@example.com",
  ...over,
});

const row = (over: Partial<RowDoc> = {}): RowDoc => ({
  version: 1,
  uid: "r1",
  campaignUid: "c1",
  e164: "+393331234567",
  extension: null,
  label: { company: "ACME", name: null },
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

test("the paths are the ones the decision names", () => {
  assert.equal(campaignPath("c1"), "outbound/campaigns/c1.json");
  assert.equal(rowPath("c1", "r1"), "outbound/rows/c1/r1.json");
  assert.equal(doNotCallPath(), "outbound/do-not-call.json");
});

test("a campaign this build can read is read", () => {
  assert.equal(isCampaignDoc(campaign()), true);
  assert.equal(isCampaignDoc(campaign({ script: { nodeId: "node-1", revision: "abc" } })), true);
  assert.equal(isCampaignDoc(campaign({ state: "closed" })), true);
});

test("a campaign without a vocabulary, or with one word and two meanings, is not", () => {
  assert.equal(isCampaignDoc(campaign({ outcomes: [] })), false);
  assert.equal(
    isCampaignDoc(
      campaign({
        outcomes: [
          { id: "booked", label: "Appointment booked" },
          { id: "booked", label: "Something else" },
        ],
      }),
    ),
    false,
  );
  assert.equal(isCampaignDoc(campaign({ outcomes: [{ id: "", label: "x" }] })), false);
});

test("a campaign state outside the two it has is not", () => {
  assert.equal(isCampaignDoc({ ...campaign(), state: "paused" }), false);
  assert.equal(isCampaignDoc({ ...campaign(), version: 2 }), false);
  assert.equal(isCampaignDoc(null), false);
});

test("a row this build can read is read, with and without a card", () => {
  assert.equal(isRowDoc(row()), true);
  assert.equal(isRowDoc(row({ cardUid: "card-9", nextCallAt: "2026-10-30T10:00:00Z" })), true);
  assert.equal(isRowDoc(row({ claim: { by: "sam", at: "2026-10-28T09:00:00Z", until: "2026-10-28T09:15:00Z" } })), true);
});

test("a row stores only a canonical number", () => {
  assert.equal(isRowDoc(row({ e164: "3331234567" })), false);
  assert.equal(isRowDoc(row({ e164: "+39 333 1234567" })), false);
  assert.equal(isRowDoc(row({ e164: "+0039333" })), false);
});

test("a row that has outgrown its window, or miscounts it, is not", () => {
  const call = { at: "2026-10-28T09:00:00Z", by: "sam", outcome: "booked", note: null, cardUid: null };
  assert.equal(isRowDoc(row({ calls: Array(MAX_CALLS_KEPT).fill(call) })), true);
  assert.equal(isRowDoc(row({ calls: Array(MAX_CALLS_KEPT + 1).fill(call) })), false);
  assert.equal(isRowDoc(row({ trimmed: -1 })), false);
  assert.equal(isRowDoc(row({ trimmed: 1.5 })), false);
});

test("a call that fills the window drops the oldest and counts it", () => {
  const call = { at: "2026-10-28T09:00:00Z", by: "sam", outcome: "booked", note: null, cardUid: null };
  const full = row({
    calls: Array.from({ length: MAX_CALLS_KEPT }, (_, index) => ({ ...call, note: `call ${index}` })),
    trimmed: 3,
  });
  const next = withCall(full, { ...call, note: "the new one" });
  assert.equal(next.calls.length, MAX_CALLS_KEPT);
  assert.equal(next.calls[next.calls.length - 1].note, "the new one");
  assert.equal(next.calls[0].note, "call 1");
  assert.equal(next.trimmed, 4);
});

test("the do-not-call document holds canonical numbers, one each, and says when", () => {
  assert.equal(isDoNotCallDoc({ version: 1, numbers: ["+393331234567"], updatedAt: "2026-10-28T09:00:00Z" }), true);
  assert.equal(isDoNotCallDoc({ version: 1, numbers: ["3331234567"], updatedAt: "x" }), false);
  assert.equal(isDoNotCallDoc({ version: 1, numbers: [1], updatedAt: "x" }), false);
  assert.equal(isDoNotCallDoc({ version: 1, numbers: [] }), false);
});
