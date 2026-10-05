import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "../testkit.js";

/**
 * The claim machinery against the mock's FileNode store (ADR 0003).
 *
 * The mock **does** enforce `ifInState` (`compare-and-set.test.ts` pins it), so
 * a write whose state moved is refused exactly as a real 0.16 server refuses
 * it. What these tests exercise is every ownership decision — take what is
 * free, leave what a peer that started after us holds, hold our own without
 * writing anything, take over a claim taken before this process started while
 * keeping the catch-up states it recorded — and why a claim came back empty,
 * which a refusal that cannot be told apart from a loss could not answer.
 *
 * Two of them are read against the mock's upload counter, because the claim is
 * a fence and not a lease: holding one is worth zero uploads, and a real
 * Stalwart charges the account for every blob it is asked to store.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const {
  claimAccount,
  claimStream,
  claimStillMine,
  releaseClaim,
  releaseStreamClaim,
  saveClaimStates,
  agentId,
} = await import("./lease.js");
const { AgentStore } = await import("./store.js");
const { claimEpoch } = await import("./documents.js");

const BASE = `http://127.0.0.1:${PORT}`;
/** The group mailbox of the demo session; its app folder holds the claims. */
const GROUP = "a3";
/** The demo principal's own account, which stands in for the agent's. */
const AGENT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const store = new AgentStore(ctx, GROUP);
const agentStore = new AgentStore(ctx, AGENT);

/**
 * A process start that is after every claim written so far, and one before it.
 *
 * The whole of the takeover rule is this comparison, so a test says which side
 * of it it means instead of aging anything: `startedAfter()` is a process that
 * came up later (and therefore may take a claim over), `startedBefore()` one
 * that was already running when the claim was written (and therefore may not).
 */
const startedAfter = (ms = 1_000) => new Date(Date.now() + ms);
const startedBefore = (ms = 1_000) => new Date(Date.now() - ms);

/** The account holds one claim, so a test that needs a free unit drops it. */
const freeUnit = (): Promise<void> => store.destroyClaim();

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a claim nobody holds is taken", async () => {
  const claim = await claimAccount(store, "w1", {
    now: new Date(),
    startedAt: startedBefore(),
  });
  assert.ok(claim, "the first agent takes the free unit");
  assert.equal(claim.agent, "w1");
  assert.equal(claim.accountId, GROUP);
  assert.equal(claim.epoch, 0, "a fresh ownership, so the fence starts at zero");
  assert.ok(
    Number.isFinite(Date.parse(claim.takenAt)),
    "the claim records when it was taken, on the clock the fleet agrees on",
  );
  assert.deepEqual(claim.states, {});
});

test("a claim held by another agent that started after us is not taken", async () => {
  const claim = await claimAccount(store, "w2", {
    now: new Date(),
    startedAt: startedBefore(),
  });
  assert.equal(claim, null, "losing a race is normal, not an error");
});

test("the holder that finds its claim its own writes nothing at all", async () => {
  const held = await store.readClaim();
  assert.ok(held);
  const uploads = mock.uploads.count;
  const renewed = await claimAccount(store, "w1", {
    now: startedAfter(),
    startedAt: startedBefore(),
  });
  assert.ok(renewed);
  assert.equal(renewed.takenAt, held.doc.takenAt, "the take time is not rewritten");
  assert.equal(claimEpoch(renewed), claimEpoch(held.doc), "and neither is the epoch");
  const again = await store.readClaim();
  assert.equal(
    again?.state,
    held.state,
    "the document did not move: holding a fence is not an event",
  );
  assert.equal(
    mock.uploads.count,
    uploads,
    "and the account was not charged for anything",
  );
});

test("states are recorded on the claim, and merge instead of replacing", async () => {
  const held = await store.readClaim();
  assert.ok(held);
  const first = await saveClaimStates(store, held.doc, { Email: "7" });
  assert.ok(first);
  assert.equal(first.states.Email, "7");
  const second = await saveClaimStates(store, first, { FileNode: "9" });
  assert.ok(second);
  assert.deepEqual(second.states, { Email: "7", FileNode: "9" });
});

test("a claim taken before this process started is taken over, keeping the states", async () => {
  const held = await store.readClaim();
  assert.ok(held);
  const taken = await claimAccount(store, "w3", {
    now: new Date(),
    startedAt: startedAfter(),
  });
  assert.ok(
    taken,
    "a peer that was here before us is a peer that cannot have been waiting for us",
  );
  assert.equal(taken.agent, "w3");
  assert.equal(
    claimEpoch(taken),
    claimEpoch(held.doc) + 1,
    "a takeover is a new ownership",
  );
  assert.ok(taken.takenAt > held.doc.takenAt, "and it records when it happened");
  assert.deepEqual(
    taken.states,
    { Email: "7", FileNode: "9" },
    "catch-up continues where the process before us stopped",
  );
});

test("a claim taken after this process started stays with its holder", async () => {
  const held = await store.readClaim();
  assert.ok(held);
  assert.equal(
    await claimAccount(store, "somebody-else", {
      now: startedAfter(),
      startedAt: startedBefore(),
    }),
    null,
    "a peer that came up after us is running now, however long we take",
  );
  assert.equal(await releaseClaim(store, "not-me"), false);
  assert.equal(await releaseClaim(store, "w3"), true);
  assert.equal(await store.readClaim(), null);
});

test("a claim whose take time cannot be read is nobody's to take over", async () => {
  // An unreadable instant means the answer is unknown, and taking over on an
  // unknown is how two agents end up on one unit. Read as held, which is the
  // safe way to be wrong: the holder serves it and the next process that starts
  // reads it again.
  await freeUnit();
  await store.writeClaim({
    v: 1,
    accountId: GROUP,
    agent: "w-broken-clock",
    takenAt: "not a time",
    epoch: 3,
    states: {},
  });
  const refused: string[] = [];
  const claim = await claimAccount(store, "w1", {
    now: new Date(),
    startedAt: startedAfter(),
    onRefused: (reason) => refused.push(reason),
  });
  assert.equal(claim, null);
  assert.deepEqual(refused, ["held"], "unknown is held, not free");
  assert.equal((await store.readClaim())?.doc.agent, "w-broken-clock");
  await freeUnit();
});

test("the stream claim is exclusive, in the agent's own account", async () => {
  const won = await claimStream(agentStore, "w1", {
    now: new Date(),
    startedAt: startedBefore(),
  });
  assert.ok(won);
  assert.equal(
    await claimStream(agentStore, "w2", {
      now: new Date(),
      startedAt: startedBefore(),
    }),
    null,
    "one agent holds the agent's EventSource",
  );
  // Its holder holding it is not an event either.
  const uploads = mock.uploads.count;
  const again = await claimStream(agentStore, "w1", {
    now: startedAfter(),
    startedAt: startedBefore(),
  });
  assert.ok(again);
  assert.equal(again.takenAt, won.takenAt, "the stream's take time is not rewritten");
  assert.equal(mock.uploads.count, uploads, "and holding it costs no upload");
  assert.equal(await releaseStreamClaim(agentStore, "w2"), false);
  assert.equal(await releaseStreamClaim(agentStore, "w1"), true);
  assert.equal(await agentStore.readStreamClaim(), null);

  // A stream taken before this process started is free to take, like an account.
  const earlier = await claimStream(agentStore, "w-old", {
    now: new Date(),
    startedAt: startedBefore(),
  });
  assert.ok(earlier);
  const successor = await claimStream(agentStore, "w-new", {
    now: new Date(),
    startedAt: startedAfter(),
  });
  assert.ok(successor, "a successor takes the stream without waiting anything out");
  assert.equal(successor.epoch, claimEpoch(earlier) + 1);
  assert.equal(await releaseStreamClaim(agentStore, "w-new"), true);
});

test("an agent id is stable for the process and names the agent", () => {
  const id = agentId("gilbert@example.com");
  assert.equal(id, agentId("gilbert@example.com"));
  assert.match(id, /^gilbert@example\.com#.+-[0-9]+-/);
});

/*
 * From here on each test drops the account's claim first, so it starts from a
 * unit nobody holds and the tests above keep their sequence.
 */

test("a takeover moves the epoch, and holding does not", async () => {
  await freeUnit();
  const first = await claimAccount(store, "w1", {
    now: new Date(),
    startedAt: startedBefore(),
  });
  assert.ok(first);
  const atEpoch = claimEpoch(first);

  const held = await claimAccount(store, "w1", {
    now: new Date(),
    startedAt: startedAfter(),
  });
  assert.ok(held);
  assert.equal(
    claimEpoch(held),
    atEpoch,
    "holding is the same ownership, so a fence taken before it still holds",
  );

  const taken = await claimAccount(store, "w2", {
    now: new Date(),
    startedAt: startedAfter(),
  });
  assert.ok(taken);
  assert.equal(
    claimEpoch(taken),
    atEpoch + 1,
    "a takeover is a new ownership, so the old run's fence stops matching",
  );
  assert.equal(
    await claimStillMine(store, "w1", atEpoch),
    false,
    "the superseded run is told it no longer holds the unit",
  );
  assert.equal(await claimStillMine(store, "w2", claimEpoch(taken)), true);
});

test("two agents racing for one unit: exactly one wins", async () => {
  await freeUnit();
  const now = new Date();
  const startedAt = startedBefore();
  const [one, two] = await Promise.all([
    claimAccount(store, "racer-a", { now, startedAt }),
    claimAccount(store, "racer-b", { now, startedAt }),
  ]);
  assert.equal(
    [one, two].filter(Boolean).length,
    1,
    "two agents must never both believe they hold the same unit (ADR 0003)",
  );
  const held = await store.readClaim();
  assert.ok(held);
  assert.equal(held.doc.agent, (one ?? two)?.agent);
});

test("a released claim is not resurrected by saving states into it", async () => {
  await freeUnit();
  const claim = await claimAccount(store, "w1", {
    now: new Date(),
    startedAt: startedBefore(),
  });
  assert.ok(claim);
  assert.equal(await releaseClaim(store, "w1"), true);

  const saved = await saveClaimStates(store, claim, { Email: "42" });
  assert.equal(
    saved,
    null,
    "a claim that is gone is not mine to write into: the next pass claims it again",
  );
  assert.equal(
    await store.readClaim(),
    null,
    "the unit must not come back held by a agent that already gave it away",
  );
});

test("a refusal says whether a peer holds the unit or the write kept losing", async () => {
  await freeUnit();
  assert.ok(
    await claimAccount(store, "holder", {
      now: new Date(),
      startedAt: startedBefore(),
    }),
  );
  const reasons: string[] = [];
  const refused = await claimAccount(store, "other", {
    now: new Date(),
    startedAt: startedBefore(),
    onRefused: (reason) => reasons.push(reason),
  });
  assert.equal(refused, null);
  assert.deepEqual(
    reasons,
    ["held"],
    "another agent's claim is ownership, not contention",
  );
  // Free again, so the only thing that can refuse the next attempt is losing
  // the write rather than finding an owner.
  assert.equal(await releaseClaim(store, "holder"), true);

  // A store whose token moves under the writer: every conditional write loses,
  // which is the case a bare `null` cannot tell from "somebody else has it".
  let moved = 0;
  const slippery = {
    accountId: store.accountId,
    state: async () => `moved-${moved++}`,
    readClaim: () => store.readClaim(),
    writeClaim: (claim: never, opts?: { ifInState?: string }) =>
      store.writeClaim(claim, opts),
  } as unknown as AgentStore;
  const contended: string[] = [];
  const lost = await claimAccount(slippery, "w1", {
    now: new Date(),
    startedAt: startedBefore(),
    onRefused: (reason) => contended.push(reason),
  });
  assert.equal(lost, null);
  assert.deepEqual(
    contended,
    ["contended"],
    "nobody holds it and the write kept losing: the fleet is quietly stopping",
  );
});
