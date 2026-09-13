import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * Idle costs nothing, and that is the whole incident this pins.
 *
 * Stalwart charges an account for every blob it stores and JMAP has no blob
 * deletion, so a write that changes nothing is a write that spends a permanent
 * budget: the liveness machinery that rewrote a worker record and renewed every
 * claim on a 30-second clock was spending a group's thousand blobs in under
 * three hours of doing nothing. A claim is now a fence, taken and released, and
 * the record is written when the work changes — so a worker with no work to do
 * asks (which costs nothing) and writes nothing.
 *
 * The counter is the mock's own blob-upload count, which is the one place a
 * blob is bought, and a pass is driven directly here rather than waited for on a
 * timer: the clock is what used to cause the write, and this test is the same
 * loop without the waiting. Put the periodic write back — a renewed claim, a
 * fresh heartbeat on every pass — and the first test fails on the first pass of
 * the loop.
 */

const PORT = 18861;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { startWorker, groupNameOf } = await import("./agent.js");
const { AgentStore } = await import("./store.js");
const { writeAppFileAt, writeBytesIntoVisibleFolder } = await import("../appFolder.js");

const BASE = `http://127.0.0.1:${PORT}`;
/** A group mailbox of the demo session, and its second one. */
const GROUPS = ["a3", "a5"];
const AGENT = "gilbert@example.com";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const agentStore = new AgentStore(ctx, "a1");

/** Give the accounts back, so each test starts from a fleet that holds nothing. */
async function clearClaims(): Promise<void> {
  for (const accountId of GROUPS) await new AgentStore(ctx, accountId).destroyClaim();
  await agentStore.destroyStreamClaim();
}

after(() => {
  (mock as { server?: { close?: () => void } }).server?.close?.();
});

test("an idle worker buys no blob, however many passes it runs", async () => {
  await clearClaims();
  const worker = await startWorker({
    ctx,
    address: AGENT,
    workerId: "w-idle",
    log: () => {},
    timers: false,
  });
  const served = await worker.pass();
  assert.ok(
    served.length > 0,
    "the worker claims what it serves before the idle loop starts",
  );
  const uploads = mock.uploads.count;
  const claim = await new AgentStore(ctx, "a3").readClaim();
  const record = (await agentStore.listWorkers()).find((w) => w.id === "w-idle");
  assert.ok(claim && record, "the claim and the record the pass wrote are readable");

  // Twenty-five more passes, which is what a heartbeat interval used to be
  // spent on (the timer called the same claim-and-heartbeat work every 30s).
  for (let pass = 0; pass < 25; pass++) await worker.pass();

  assert.equal(
    mock.uploads.count,
    uploads,
    "a worker with no work to do must not spend a single blob of the account's budget",
  );
  assert.equal(
    (await new AgentStore(ctx, "a3").readClaim())?.doc.takenAt,
    claim.doc.takenAt,
    "and the claim it holds is untouched: holding a fence is not an event",
  );
  assert.equal(
    (await agentStore.listWorkers()).find((w) => w.id === "w-idle")?.updatedAt,
    record.updatedAt,
    "and neither is the record it wrote: a pass that changes nothing writes nothing",
  );
  await worker.stop();
});

test("work still writes what it must, and the documents are readable", async () => {
  await clearClaims();
  const before = mock.uploads.count;
  const worker = await startWorker({
    ctx,
    address: AGENT,
    workerId: "w-work",
    log: () => {},
    timers: false,
  });
  const served = await worker.pass();
  assert.ok(
    mock.uploads.count > before,
    "claiming a unit and saying what it serves is work, and it buys blobs",
  );

  // What it wrote is what the rest of the system reads: the claim in the group's
  // own account, the record in the agent's, and the single stream claim.
  for (const accountId of served) {
    const claim = await new AgentStore(ctx, accountId).readClaim();
    assert.equal(claim?.doc.worker, "w-work", `${accountId}: the claim names its holder`);
    assert.equal(claim?.doc.epoch, 0, "and a fresh ownership starts at epoch zero");
    assert.ok(
      Number.isFinite(Date.parse(String(claim?.doc.takenAt))),
      "with the instant it was taken",
    );
  }
  const record = (await agentStore.listWorkers()).find((w) => w.id === "w-work");
  assert.ok(record, "the worker record is a document in the agent's own account");
  assert.deepEqual(
    [...(record.serves ?? [])].sort(),
    served.map((id) => groupNameOf(session, id)).sort(),
    "and it names the groups it is holding",
  );
  assert.equal(
    (await agentStore.readStreamClaim())?.doc.worker,
    "w-work",
    "one worker holds the agent's event stream",
  );

  // A change in the work is what a write is for: a process that starts later
  // takes the unit over, and that is a blob — not a clock.
  const taken = mock.uploads.count;
  const successor = await startWorker({
    ctx,
    address: AGENT,
    workerId: "w-successor",
    log: () => {},
    timers: false,
    now: () => new Date(Date.now() + 60_000),
  });
  await successor.pass();
  assert.ok(
    mock.uploads.count > taken,
    "a takeover writes the new ownership, which is the one write a fence costs",
  );
  const after = await new AgentStore(ctx, "a3").readClaim();
  assert.equal(after?.doc.worker, "w-successor");
  assert.equal(after?.doc.epoch, 1, "a takeover is a new ownership");
  await worker.stop();
  await successor.stop();
});

/*
 * The other writer that used the clock: the pass itself.
 *
 * A pass records the state it reconciled up to in the claim, and everything the
 * worker writes — jobs, decisions, the notebook, the audit — is a file in the
 * very account whose state it is reading. So recording after one of those writes
 * makes the next pass read the recording as a change, and record again: a blob a
 * minute for a group where nothing is happening, forever. A change the group
 * made is news and anchors; a change Gilbert made to its own bookkeeping does
 * not.
 */
test("a change of our own does not anchor, and the group's own does", async () => {
  await clearClaims();
  const worker = await startWorker({
    ctx,
    address: AGENT,
    workerId: "w-anchor",
    log: () => {},
    timers: false,
  });
  await worker.pass();
  const store = new AgentStore(ctx, "a3");
  const anchor = async (): Promise<string> =>
    (await store.readClaim())?.doc.states?.FileNode ?? "";
  const settled = await anchor();
  assert.ok(settled, "the first pass anchored the state it read");

  // A document of Gilbert's own, in the group's app folder: bookkeeping.
  await writeAppFileAt(ctx, "a3", "agent/notebook.json", { v: 1, facts: [] });
  const spent = mock.uploads.count;
  for (let pass = 0; pass < 3; pass += 1) await worker.pass();
  assert.equal(
    await anchor(),
    settled,
    "a change of our own does not move the anchor, so the next pass reads it again and writes nothing",
  );
  assert.equal(mock.uploads.count, spent, "and three passes over it bought no blob");

  // A file of the group's own, outside the app folder: news.
  await writeBytesIntoVisibleFolder(
    ctx,
    "a3",
    "Documents",
    "note.txt",
    new TextEncoder().encode("the group's own change"),
    "text/plain",
  );
  await worker.pass();
  assert.notEqual(
    await anchor(),
    settled,
    "the group's own change anchors, so the pass after it does not read it again",
  );
  await worker.stop();
});
