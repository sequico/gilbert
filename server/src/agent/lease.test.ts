import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * The claim machinery against the mock's FileNode store (ADR 0003 §6).
 *
 * The mock **does** enforce `ifInState` (`compare-and-set.test.ts` pins it), so
 * a write whose state moved is refused exactly as a real 0.16 server refuses
 * it. What these tests exercise is every ownership decision — take what is
 * free, refuse what somebody holds, renew my own, take over a claim whose
 * heartbeat went stale while keeping the catch-up states it recorded — and,
 * since a refusal is no longer indistinguishable from a loss, why a claim came
 * back empty.
 */

const PORT = 18851;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const {
  claimArea,
  claimStream,
  claimStillMine,
  releaseClaim,
  releaseStreamClaim,
  renewClaim,
  saveClaimStates,
  workerId,
} = await import("./lease.js");
const { AgentStore } = await import("./store.js");
const { claimEpoch } = await import("./documents.js");

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

/*
 * From here on each test takes its own area, so it starts from a claim nobody
 * holds and the tests above keep their sequence.
 */

test("a takeover moves the epoch, a renewal does not", async () => {
  const first = await claimArea(store, "files", "w1", {
    now: new Date(),
    leaseMs: LEASE,
  });
  assert.ok(first);
  const atEpoch = claimEpoch(first);

  const renewed = await claimArea(store, "files", "w1", {
    now: new Date(),
    leaseMs: LEASE,
  });
  assert.ok(renewed);
  assert.equal(
    claimEpoch(renewed),
    atEpoch,
    "a renewal is the same ownership, so a fence taken before it still holds",
  );

  await store.writeClaim({
    ...renewed,
    heartbeatAt: new Date(Date.now() - 2 * LEASE).toISOString(),
  });
  const taken = await claimArea(store, "files", "w2", {
    now: new Date(),
    leaseMs: LEASE,
  });
  assert.ok(taken);
  assert.equal(
    claimEpoch(taken),
    atEpoch + 1,
    "a takeover is a new ownership, so the old run's fence stops matching",
  );
  assert.equal(
    await claimStillMine(store, "files", "w1", atEpoch),
    false,
    "the superseded run is told it no longer holds the unit",
  );
  assert.equal(await claimStillMine(store, "files", "w2", claimEpoch(taken)), true);
});

test("two workers racing for one unit: exactly one wins", async () => {
  const now = new Date();
  const [one, two] = await Promise.all([
    claimArea(store, "tasks", "racer-a", { now, leaseMs: LEASE }),
    claimArea(store, "tasks", "racer-b", { now, leaseMs: LEASE }),
  ]);
  assert.equal(
    [one, two].filter(Boolean).length,
    1,
    "two workers must never both believe they hold the same unit (ADR 0003 §6)",
  );
  const held = await store.readClaim("tasks");
  assert.ok(held);
  assert.equal(held.doc.worker, (one ?? two)?.worker);
});

test("a released claim is not resurrected by saving states into it", async () => {
  const claim = await claimArea(store, "calendars", "w1", {
    now: new Date(),
    leaseMs: LEASE,
  });
  assert.ok(claim);
  assert.equal(await releaseClaim(store, "calendars", "w1"), true);

  const saved = await saveClaimStates(store, claim, { Email: "42" });
  assert.equal(
    saved,
    null,
    "a claim that is gone is not mine to write into: the next pass claims it again",
  );
  assert.equal(
    await store.readClaim("calendars"),
    null,
    "the unit must not come back busy under a worker that already gave it away",
  );
});

test("a refusal says whether a peer holds the unit or the write kept losing", async () => {
  assert.ok(
    await claimArea(store, "contacts", "holder", { now: new Date(), leaseMs: LEASE }),
  );
  const reasons: string[] = [];
  const refused = await claimArea(store, "contacts", "other", {
    now: new Date(),
    leaseMs: LEASE,
    onRefused: (reason) => reasons.push(reason),
  });
  assert.equal(refused, null);
  assert.deepEqual(reasons, ["held"], "a live lease is ownership, not contention");
  // Free again, so the only thing that can refuse the next attempt is losing
  // the write rather than finding an owner.
  assert.equal(await releaseClaim(store, "contacts", "holder"), true);

  // A store whose token moves under the writer: every conditional write loses,
  // which is the case a bare `null` cannot tell from "somebody else has it".
  let moved = 0;
  const slippery = {
    accountId: store.accountId,
    state: async () => `moved-${moved++}`,
    readClaim: (area: string) => store.readClaim(area as never),
    writeClaim: (claim: never, opts?: { ifInState?: string }) =>
      store.writeClaim(claim, opts),
  } as unknown as AgentStore;
  const contended: string[] = [];
  const lost = await claimArea(slippery, "contacts", "w1", {
    now: new Date(),
    leaseMs: LEASE,
    onRefused: (reason) => contended.push(reason),
  });
  assert.equal(lost, null);
  assert.deepEqual(
    contended,
    ["contended"],
    "nobody holds it and the write kept losing: the fleet is quietly stopping",
  );
});
