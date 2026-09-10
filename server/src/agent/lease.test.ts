import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * The claim machinery against the mock's FileNode store (ADR 0003 §6).
 *
 * The mock does not enforce `ifInState`, where a real 0.16 server refuses a
 * write whose state moved, so the compare-and-set **retry** path is not
 * exercised here. What is exercised is every ownership decision, because those
 * are made from the documents themselves: take what is free, refuse what
 * somebody holds, renew my own, and take over a claim whose heartbeat went
 * stale while keeping the catch-up states it recorded.
 */

const PORT = 18851;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const {
  claimArea,
  claimStream,
  releaseClaim,
  releaseStreamClaim,
  renewClaim,
  saveClaimStates,
  workerId,
} = await import("./lease.js");
const { AgentStore } = await import("./store.js");

const BASE = `http://127.0.0.1:${PORT}`;
/** The group mailbox of the demo session; its app folder holds the claims. */
const GROUP = "a3";
/** The demo principal's own account, which stands in for the agent's. */
const AGENT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;
const LEASE = 60_000;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const store = new AgentStore(ctx, GROUP);
const agentStore = new AgentStore(ctx, AGENT);

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a claim nobody holds is taken", async () => {
  const claim = await claimArea(store, "mail", "w1", { now: new Date(), leaseMs: LEASE });
  assert.ok(claim, "the first worker takes the free unit");
  assert.equal(claim.worker, "w1");
  assert.equal(claim.area, "mail");
  assert.equal(claim.accountId, GROUP);
  assert.deepEqual(claim.states, {});
});

test("a claim held by another worker with a live lease is not taken", async () => {
  const claim = await claimArea(store, "mail", "w2", { now: new Date(), leaseMs: LEASE });
  assert.equal(claim, null, "losing a race is normal, not an error");
});

test("the holder renews, keeping the instant its lease started", async () => {
  const held = await store.readClaim("mail");
  assert.ok(held);
  const renewed = await renewClaim(store, held.doc, {
    now: new Date(Date.now() + 1_000),
  });
  assert.ok(renewed);
  assert.equal(renewed.leasedAt, held.doc.leasedAt);
  assert.ok(renewed.heartbeatAt > held.doc.heartbeatAt);
});

test("states are recorded on the claim, and merge instead of replacing", async () => {
  const held = await store.readClaim("mail");
  assert.ok(held);
  const first = await saveClaimStates(store, held.doc, { Email: "7" });
  assert.ok(first);
  assert.equal(first.states.Email, "7");
  const second = await saveClaimStates(store, first, { FileNode: "9" });
  assert.ok(second);
  assert.deepEqual(second.states, { Email: "7", FileNode: "9" });
});

test("a stale lease is taken over, keeping the catch-up states", async () => {
  const held = await store.readClaim("mail");
  assert.ok(held);
  await store.writeClaim({
    ...held.doc,
    heartbeatAt: new Date(Date.now() - 2 * LEASE).toISOString(),
  });
  const taken = await claimArea(store, "mail", "w3", { now: new Date(), leaseMs: LEASE });
  assert.ok(taken, "a heartbeat older than the tolerance is free to take");
  assert.equal(taken.worker, "w3");
  assert.deepEqual(
    taken.states,
    { Email: "7", FileNode: "9" },
    "catch-up continues where the dead worker stopped",
  );
  assert.equal(taken.leasedAt, taken.heartbeatAt, "a takeover starts a new lease");
});

test("renewal and release only touch the claim of the holder", async () => {
  const held = await store.readClaim("mail");
  assert.ok(held);
  assert.equal(
    await renewClaim(
      store,
      { ...held.doc, worker: "somebody-else" },
      { now: new Date() },
    ),
    null,
  );
  assert.equal(await releaseClaim(store, "mail", "not-me"), false);
  assert.equal(await releaseClaim(store, "mail", "w3"), true);
  assert.equal(await store.readClaim("mail"), null);
});

test("the stream claim is exclusive, in the agent's own account", async () => {
  const won = await claimStream(agentStore, "w1", { now: new Date(), leaseMs: LEASE });
  assert.ok(won);
  assert.equal(
    await claimStream(agentStore, "w2", { now: new Date(), leaseMs: LEASE }),
    null,
    "one worker holds the agent's EventSource",
  );
  assert.equal(await releaseStreamClaim(agentStore, "w2"), false);
  assert.equal(await releaseStreamClaim(agentStore, "w1"), true);
  assert.equal(await agentStore.readStreamClaim(), null);
});

test("a worker id is stable for the process and names the agent", () => {
  const id = workerId("gilbert@example.com");
  assert.equal(id, workerId("gilbert@example.com"));
  assert.match(id, /^gilbert@example\.com#[0-9]+-/);
});
