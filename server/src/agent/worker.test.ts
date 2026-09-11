import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * The worker's second entrypoint against the mock (ADR 0003, v1 scope).
 *
 * The process-level half — the poll loop, the event stream, signals — is driven
 * through the same seam with `timers: false`, so one pass is exercised without
 * the test holding a live fleet. What a pass must do is durable and observable:
 * claim `account × area` for every group mailbox the principal can see, write
 * the heartbeat in the agent's own account, hold the single stream claim, and
 * give the claims back on stop.
 */

const PORT = 18849;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const {
  areasFor,
  basicAuth,
  candidateAccounts,
  groupNameOf,
  servedAreasFor,
  startWorker,
  withdrawnAccounts,
} = await import("./worker.js");
const { AgentStore } = await import("./store.js");
const { AGENT_AREAS } = await import("./documents.js");
const { filesAccountId, readAppJsonAt } = await import("../appFolder.js");
const { WITHDRAWALS_PATH } = await import("./views.js");

const BASE = `http://127.0.0.1:${PORT}`;
/** The group mailboxes of the demo session, and the demo's own account. */
const GROUP = "a3";
const AGENT = "gilbert@example.com";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const agentStore = new AgentStore(ctx, "a1");

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the accounts a v1 worker may serve are the group mailboxes", () => {
  const candidates = candidateAccounts(session);
  assert.ok(candidates.includes(GROUP), "a group mailbox is served");
  assert.ok(candidates.includes("a5"), "a second group is served too");
  assert.ok(!candidates.includes("a1"), "a person's own account is not v1 work");
  for (const id of candidates) {
    const account = session.accounts[id] as { isPersonal?: unknown; name?: unknown };
    assert.equal(account.isPersonal, false);
    assert.match(String(account.name), /@/);
  }
});

test("the authorization header a worker derives its session with", () => {
  assert.equal(
    basicAuth(AGENT, "an-app-password"),
    `Basic ${Buffer.from(`${AGENT}:an-app-password`).toString("base64")}`,
  );
});

test("one pass claims its units, heartbeats, and gives everything back on stop", async () => {
  const lines: string[] = [];
  const worker = await startWorker({
    ctx,
    address: AGENT,
    areas: ["mail"],
    workerId: "w-worker-test",
    log: (line) => lines.push(line),
    timers: false,
  });

  const served = await worker.pass();
  assert.deepEqual([...served].sort(), [...candidateAccounts(session)].sort());
  for (const accountId of served) {
    const claim = await new AgentStore(ctx, accountId).readClaim("mail");
    assert.equal(
      claim?.doc.worker,
      "w-worker-test",
      `${accountId}/mail is this worker's`,
    );
  }

  const record = (await agentStore.listWorkers()).find((w) => w.id === "w-worker-test");
  assert.ok(record, "the worker says it is alive, in the agent's own account");
  assert.equal(record.address, AGENT);
  assert.deepEqual(record.areas, ["mail"]);
  assert.equal(
    (await agentStore.readStreamClaim())?.doc.worker,
    "w-worker-test",
    "exactly one worker holds the agent's event stream",
  );

  // A second pass is the same pass: renewal, not a second claim.
  await worker.pass();
  const again = await new AgentStore(ctx, GROUP).readClaim("mail");
  assert.equal(again?.doc.worker, "w-worker-test");

  await worker.stop();
  assert.equal(await agentStore.readStreamClaim(), null, "the stream claim is released");
  for (const accountId of served) {
    assert.equal(
      await new AgentStore(ctx, accountId).readClaim("mail"),
      null,
      "and so are the areas, so a replacement serves at once",
    );
  }
  assert.equal(worker.served().length, 0);
  assert.ok(
    lines.some((line) => line.includes(`claimed ${GROUP}/mail`)),
    "a meaningful event is one line",
  );
});

test("the health endpoint answers a probe and nothing else", async () => {
  // Deployment's restart policy asks one question — is this process serving
  // what it claimed — and a port nobody asked for would be surface for
  // nothing, which is why the endpoint exists only when one is named.
  const { startHealthServer } = await import("./worker.js");
  const healthPort = 18853;
  const close = startHealthServer({
    port: healthPort,
    health: () => ({
      status: "ok",
      worker: "w1",
      address: AGENT,
      areas: ["mail"],
      accounts: [GROUP],
      streaming: true,
      startedAt: new Date().toISOString(),
      uptimeSeconds: 3,
    }),
  });
  try {
    const ok = await fetch(`http://127.0.0.1:${healthPort}/health`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { status: string; accounts: string[] };
    assert.equal(body.status, "ok");
    assert.deepEqual(body.accounts, [GROUP]);
    const missing = await fetch(`http://127.0.0.1:${healthPort}/anything`);
    assert.equal(missing.status, 404);
  } finally {
    close();
  }
});

test("a second worker takes over a stale lease, and never double-serves", async () => {
  // Two handles are two processes as far as the documents are concerned: the
  // claim is the only thing that says who serves `account × area` (ADR 0003
  // §6, resolution 8). What has to hold is that a live holder is left alone
  // and a dead one is taken over with its catch-up states intact.
  const store = new AgentStore(ctx, GROUP);
  const start = new Date("2026-09-10T09:00:00Z");
  const later = (ms: number) => () => new Date(start.getTime() + ms);

  const first = await startWorker({
    ctx,
    address: AGENT,
    areas: ["mail"],
    workerId: "w-first",
    log: () => {},
    timers: false,
    now: later(0),
    leaseMs: 60_000,
  });
  await first.pass();
  const claimed = await store.readClaim("mail");
  assert.equal(claimed?.doc.worker, "w-first");
  assert.deepEqual(claimed?.doc.areas ?? claimed?.doc.area, "mail");

  // The holder is alive: a peer's pass must not take anything from it.
  const second = await startWorker({
    ctx,
    address: AGENT,
    areas: ["mail"],
    workerId: "w-second",
    log: () => {},
    timers: false,
    now: later(30_000),
    leaseMs: 60_000,
  });
  await second.pass();
  assert.equal((await store.readClaim("mail"))?.doc.worker, "w-first");
  assert.ok(!second.served().includes(GROUP), "a live holder keeps its unit");

  // Its lease goes stale: the peer takes over and serves the unit. (The
  // takeover keeps the dead worker's catch-up anchor — `lease.test.ts` proves
  // that at the claim level; here the reconcile that follows re-anchors it,
  // because a state this mock never issued is one `Email/changes` cannot
  // answer from, which is the documented catch-up rule.)
  const states = { Email: "s-42" };
  await store.writeClaim({ ...(await store.readClaim("mail"))!.doc, states });
  const third = await startWorker({
    ctx,
    address: AGENT,
    areas: ["mail"],
    workerId: "w-third",
    log: () => {},
    timers: false,
    now: later(10 * 60_000),
    leaseMs: 60_000,
  });
  await third.pass();
  const taken = await store.readClaim("mail");
  assert.equal(taken?.doc.worker, "w-third");
  assert.ok(third.served().includes(GROUP), "the peer serves what the dead worker held");
  assert.equal(
    typeof taken?.doc.states.Email,
    "string",
    "the claim always carries an anchor for the next pass",
  );
  await first.stop();
  await second.stop();
  await third.stop();
});

test("a withdrawal is the accounts that left the session, with the names they had", () => {
  const before = new Map([
    ["a3", "sales@example.com"],
    ["a5", "ops@example.com"],
  ]);
  assert.deepEqual(withdrawnAccounts(before, ["a3"]), [
    { account: "a5", name: "ops@example.com" },
  ]);
  assert.deepEqual(
    withdrawnAccounts(before, ["a5", "a3"]),
    [],
    "a session that still lists them all reports nothing",
  );
  assert.deepEqual(
    withdrawnAccounts(new Map(), ["a3"]),
    [],
    "the first pass has no before to compare, so nothing is a withdrawal",
  );
});

/**
 * The group name is read in one spelling, and one place reads it: `areasFor`
 * and the withdrawal report both go through this, so a session that returns a
 * name with space around it cannot narrow one and not the other.
 */
test("the name a group is served under is trimmed and lower-cased, in one place", () => {
  const named = {
    accounts: { a9: { name: "  Ops@Example.com " } },
  } as unknown as Parameters<typeof groupNameOf>[0];
  assert.equal(groupNameOf(named, "a9"), "ops@example.com");
  assert.equal(groupNameOf(named, "a8"), "", "an account the session does not name");
  assert.deepEqual(
    areasFor(named, "a9", ["mail"]),
    ["mail"],
    "a group the installation has no record for is served the deployment's areas",
  );
});

test("a grant that is withdrawn is reported, and stops being served", async () => {
  // The grant is withdrawn in Stalwart's own administration, which is a change
  // this installation never sees: the group simply leaves the agent's session.
  // What the pass must do then is stop serving it and say so where it can still
  // write — its own account — rather than failing against it on every pass
  // (ADR 0003 §2, resolution 21).
  const own = {
    authorization: AUTH,
    session: await fetchUpstreamSession(AUTH, BASE),
    username: "demo@example.com",
  };
  const start = new Date("2026-09-11T09:00:00Z");
  const worker = await startWorker({
    ctx: own,
    address: AGENT,
    areas: ["mail"],
    workerId: "w-withdrawal",
    log: () => {},
    timers: false,
    now: () => new Date(start.getTime()),
    leaseMs: 60_000,
  });

  assert.ok((await worker.pass()).includes(GROUP), "the group is served to begin with");
  assert.equal(
    await readAppJsonAt(own, filesAccountId(own), WITHDRAWALS_PATH),
    null,
    "and nothing is reported while the grant stands",
  );

  const accounts = own.session.accounts as Record<string, unknown>;
  delete accounts[GROUP];

  const after = await worker.pass();
  assert.ok(!after.includes(GROUP), "the withdrawn account is not served any more");
  const report = (await readAppJsonAt(
    own,
    filesAccountId(own),
    WITHDRAWALS_PATH,
  )) as Array<{ account: string; group: string; heldAreas: string[]; at: string }>;
  assert.equal(report.length, 1, "one withdrawal, reported once");
  assert.equal(report[0].account, GROUP);
  assert.equal(
    report[0].group,
    groupNameOf(session, GROUP),
    "the name the session had given",
  );
  assert.deepEqual(report[0].heldAreas, ["mail"], "with what it was holding");
  assert.equal(report[0].at, start.toISOString());

  // The claim it held is left where it is: a withdrawal is not a release, and a
  // worker that deleted another account's documents on its way out would be
  // taking a trust it was never given. The lease lapses instead.
  assert.equal(
    (await new AgentStore(own, GROUP).readClaim("mail"))?.doc.worker,
    "w-withdrawal",
    "the claim is left for its lease to lapse",
  );
  await worker.stop();
});

/**
 * The intersection an installation's record makes with the deployment's areas
 * (ADR 0003): a record can take work away from a group and can never hand it
 * work the operator did not open. This is the whole rule, so it is one
 * function — the alternative is a fleet whose reach depends on which of two
 * lists a process happened to read.
 */
test("a per-group record narrows the deployment's areas, never widens them", () => {
  const deployment = [...AGENT_AREAS];
  assert.deepEqual(
    servedAreasFor(deployment, null),
    deployment,
    "nothing named for this group: the deployment speaks",
  );
  assert.deepEqual(
    servedAreasFor(deployment, []),
    deployment,
    'an empty list is how "as the deployment says" is written down',
  );
  assert.deepEqual(servedAreasFor(deployment, ["mail"]), ["mail"]);
  assert.deepEqual(
    servedAreasFor(["mail"], ["mail", "files"]),
    ["mail"],
    "a record cannot open an area the deployment does not serve",
  );
});
