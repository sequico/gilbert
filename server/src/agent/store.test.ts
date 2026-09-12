import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The agent's documents, against the mock Stalwart.
 *
 * Everything the fleet keeps is a file in an account's `gilbert` app folder,
 * so this exercises the real path: upload a blob, point a FileNode at it, read
 * it back through the download route, and — where the mock reproduces it — the
 * conditional write that stands in for a lock.
 */

const PORT = 18814;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-agent-store";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId } = await import("../appFolder.js");
type Ctx = import("../appFolder.js").Ctx;
const { AgentStore, UnreadableDocumentError } = await import("./store.js");
const { writeAppFileAt } = await import("../appFolder.js");
const { newJob } = await import("./documents.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

let ctx: Ctx;
let store: AgentStore;

before(async () => {
  // Importing the mock starts it listening (it is a process, not a factory),
  // which is what the server's own suites rely on too.
  await waitForPort();
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  const accountId = filesAccountId(ctx);
  assert.ok(accountId, "the demo account owns Files");
  store = new AgentStore(ctx, accountId);
  await store.provision();
});

test("provisioning is idempotent and creates the whole tree", async () => {
  await store.provision();
  assert.deepEqual(await store.listJobs(), []);
  assert.equal(await store.readClaim(), null);
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** The mock is listening by the time its import resolves; give it a moment. */
async function waitForPort(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/.well-known/jmap`, {
        headers: { authorization: AUTH },
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the mock never came up");
}

test("a document that was never written reads as absent, not as empty", async () => {
  assert.equal(await store.readRules(), null);
  assert.equal(await store.readConfig(), null);
  assert.equal(await store.readClaim("mail"), null);
  assert.deepEqual(await store.listJobs(), []);
  assert.equal(await store.readAudit("2026-09"), null);
});

test("rules round-trip through the group's own app folder", async () => {
  const rules = [
    {
      v: 1 as const,
      id: "r1",
      version: 1,
      name: "File the invoices",
      enabled: true,
      trigger: { on: "email" as const, filter: { subject: "invoice" } },
      review: { mode: "never" as const },
      instruction: "File the invoices under G-processed.",
      capabilities: ["keyword.add" as const],
    },
  ];
  await store.writeRules(rules);
  const read = await store.readRules();
  assert.ok(read, "the document is there after the write");
  assert.deepEqual(read.doc, rules);
  assert.ok(
    read.state.length > 0,
    "the read carries the state a write can be conditioned on",
  );
});

test("the notebook round-trips through the group's own app folder", async () => {
  await store.writeNotebook(
    [
      {
        id: "f1",
        text: "Ada's invoices are filed under the client.",
        addedAt: "2026-09-12T10:00:00.000Z",
        addedBy: "demo@example.com",
      },
    ],
    "demo@example.com",
  );
  const read = await store.readNotebook();
  assert.ok(read, "the document is there after the write");
  assert.equal(read.doc.facts.length, 1);
  assert.equal(read.doc.facts[0]?.text, "Ada's invoices are filed under the client.");
  assert.equal(read.doc.updatedBy, "demo@example.com");
  assert.ok(
    read.state.length > 0,
    "the read carries the state a write can be conditioned on",
  );
});

test("a job document is addressed by id and lists with the others", async () => {
  const job = newJob({
    id: "job-1",
    accountId: store.accountId,
    rule: { id: "r1", version: 1 },
    trigger: { on: "email", emailId: "e1", at: "2026-09-10T08:00:00Z" },
  });
  await store.writeJob(job);
  const read = await store.readJob("job-1");
  assert.equal(read?.doc.id, "job-1");
  assert.equal(read?.doc.state, "pending");

  await store.writeJob({ ...job, state: "done" });
  const updated = await store.readJob("job-1");
  assert.equal(updated?.doc.state, "done");

  const all = await store.listJobs();
  assert.deepEqual(
    all.map((j) => j.doc.id),
    ["job-1"],
  );

  await store.destroyJob("job-1");
  assert.equal(await store.readJob("job-1"), null);
});

test("the audit appends to the month's document instead of replacing it", async () => {
  const entry = {
    at: "2026-09-10T08:00:00Z",
    jobId: "job-1",
    ruleId: "r1",
    ruleVersion: 1,
    outcome: "done" as const,
    actions: [{ do: "noop" as const }],
  };
  await store.appendAudit(entry);
  await store.appendAudit({ ...entry, jobId: "job-2" });
  const doc = await store.readAudit("2026-09");
  assert.ok(doc);
  assert.equal(doc.month, "2026-09");
  assert.deepEqual(
    doc.entries.map((e) => e.jobId),
    ["job-1", "job-2"],
  );
});

test("a claim carries the states its agent has reconciled up to", async () => {
  await store.writeClaim({
    v: 1,
    accountId: store.accountId,
    worker: "w1",
    leasedAt: "2026-09-10T08:00:00Z",
    heartbeatAt: "2026-09-10T08:00:00Z",
    states: { Email: "s1" },
  });
  const read = await store.readClaim();
  assert.equal(read?.doc.worker, "w1");
  assert.equal(read?.doc.states.Email, "s1");

  await store.writeClaim({ ...read!.doc, states: { Email: "s2", FileNode: "f2" } });
  const updated = await store.readClaim();
  assert.deepEqual(updated?.doc.states, { Email: "s2", FileNode: "f2" });
  assert.equal(updated?.doc.accountId, store.accountId);
});

test("the agent heartbeat is a document like any other", async () => {
  await store.writeWorker({
    v: 1,
    id: "w1",
    address: "gilbert@example.com",
    version: "test",
    startedAt: "2026-09-10T08:00:00Z",
    heartbeatAt: "2026-09-10T08:00:00Z",
  });
  const workers = await store.listWorkers();
  assert.equal(workers.length, 1);
  assert.equal(workers[0]?.address, "gilbert@example.com");
  await store.destroyWorker("w1");
  assert.deepEqual(await store.listWorkers(), []);
});

test("a conditional write is refused when the document moved under it", async () => {
  // This is the whole coordination model in one assertion: the state a reader
  // saw is what makes its write safe, and a server that ignored `ifInState`
  // would make every lease a guess.
  const first = await store.readRules();
  assert.ok(first);
  await store.writeRules([...(first.doc ?? []), { ...first.doc[0]!, id: "r2" }]);
  await assert.rejects(
    () => store.writeRules(first.doc, { ifInState: first.state }),
    (err: unknown) => /state/i.test((err as Error).message),
  );
});

test("an audit document that is there but unreadable is loud, not empty", async () => {
  // The trail is what an agent's work is answered from: a month nobody can
  // read must not present itself as a month where nothing happened. The writer
  // refuses to overwrite it; the reader refuses to call it empty.
  await writeAppFileAt(ctx, store.accountId, "agent/audit/2026-11.json", {
    nope: "not an audit document",
  });

  await assert.rejects(
    () => store.readAudit("2026-11"),
    /does not read as an audit/,
    'reading an unreadable month throws instead of answering "nothing happened"',
  );
  await assert.rejects(
    () =>
      store.appendAudit(
        {
          at: "2026-11-10T08:00:00Z",
          jobId: "job-x",
          ruleId: "r1",
          ruleVersion: 1,
          outcome: "done",
          actions: [],
        },
        new Date("2026-11-10T08:00:00Z"),
      ),
    /refusing to write over it/,
    "appending must not replace the unreadable document with a single entry",
  );
});

test("rules that are there but unreadable are loud, not no automation", async () => {
  // One malformed rule invalidates the whole document, and a reader that
  // answered `null` for it would report a group with automations as a group with
  // none: every rule of the group stops, and nothing in the trail or the chat
  // says why. Missing really is an empty account; unreadable is loud, which is
  // the line the audit document already holds.
  await writeAppFileAt(ctx, store.accountId, "agent/rules.json", {
    v: 1,
    rules: [{ v: 1, id: "r1", version: 1, name: "Half a rule" }],
  });

  await assert.rejects(
    () => store.readRules(),
    /there but does not read as a rules document/,
    'a rules document nobody can read is not "no rules"',
  );

  // The document is left exactly as it was found: reading never writes, so the
  // same read meets the same answer, and a person is who fixes it.
  await assert.rejects(() => store.readRules(), UnreadableDocumentError);
  await store.writeRules([]);
});

test("a claim that is there but unreadable is not a free unit", async () => {
  // `claimAccount` takes a missing claim as its own to create, so a claim read
  // as absent is a unit written over at `epoch: 0` — and every fence of the run
  // that holds it stops agreeing with it. Present-but-unreadable is the other
  // answer, and it is raised, not returned.
  await writeAppFileAt(ctx, store.accountId, "agent/claim.json", {
    worker: "w1",
    heartbeatAt: "2026-09-10T08:00:00Z",
  });

  await assert.rejects(
    () => store.readClaim(),
    /there but does not read as a claim/,
    "an unreadable claim is not a unit nobody holds",
  );

  await store.destroyClaim();
  assert.equal(await store.readClaim(), null);
});
