import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Ctx } from "./appFolder.js";
import { freePort, jsonCall } from "./testkit.js";

/**
 * The administration surface of the installation's agent, end to end against the
 * mock (ADR 0031, 0034, 0036, 0037): where the agent is, the runs a group has
 * worked, and the facts an administrator reads, corrects and removes.
 *
 * The three documents live in three accounts and the door reaches all of them as
 * the installation, so the suite signs in as the demo administrator (the one
 * holding the admin marker) and writes its fixtures the way the agent does: as the
 * Master, with its own credential, in the Master's `memory/` folder and in the
 * group's `runs/` folder. That is what makes the read assertions honest — the
 * routes reach those accounts by impersonation, not by handing themselves a
 * session.
 *
 * Three mechanisms are pinned, each with the mutation that reddens it:
 *
 * - **the runs are drawn as the record carries them**, and a document of a
 *   version this build does not read is **said** beside the ones it can read
 *   rather than dropped or drawn blank (remove the `problem` branch and the
 *   unreadable run disappears; draw it as an empty run and the listing lies);
 * - **a fact an administrator corrects is saved through the admin door** — in the
 *   Master's own account, with the correcting person stamped on it, and the
 *   agent's own write refused against it afterwards (answer the route `ok`
 *   without writing and the store still holds the old sentence);
 * - **a lapsed claim is no claim**, because the instant ADR 0036 gives it means
 *   one thing.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-the-agent-surface";

const DEMO = "demo@example.com";
const MASTER = "gilbert@example.com";
const TEAM = "team@example.org";
const LEGAL = "legal@example.org";

const mock = await import("./mock/index.js");
const { config } = await import("./config.js");
const { createApp } = await import("./app.js");
const { fetchUpstreamSession } = await import("./upstream.js");
const { filesAccountId, writeAppFileAt } = await import("./appFolder.js");
const { releaseClaim, takeClaim } = await import("./agent/claim.js");
const { correctFactByPerson, forgetFact, listFacts, rememberFact } = await import(
  "./agent/memory.js"
);
const { runPath } = await import("./agent/runs.js");
const { appendStep, recordStep, RUN_VERSION, startRun } = await import("./shared/run.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };
const call = jsonCall(app, HEADERS);

const BASE = `http://127.0.0.1:${PORT}`;
const MASTER_AUTH = `Basic ${Buffer.from(`${MASTER}:gilbert-password`).toString("base64")}`;
const DEMO_AUTH = `Basic ${Buffer.from(`${DEMO}:demo-password`).toString("base64")}`;

/** The Master as the agent itself signs in — the door the store is written by. */
let master: Ctx;
let memoryAccount: string;
/** The group account the runs are written into, as the demo session holds it. */
let teamAccount: string;

before(async () => {
  // The installation's agent: impersonated from the administrator's session, so
  // the routes reach the Master's account without a deployment credential.
  config.agent.address = MASTER;
  config.agent.password = "";
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: "demo-password" }),
  });
  assert.equal(res.status, 200, "login should succeed against the mock");

  master = {
    authorization: MASTER_AUTH,
    session: await fetchUpstreamSession(MASTER_AUTH, BASE),
    username: MASTER,
  };
  memoryAccount = filesAccountId(master);
  assert.ok(memoryAccount, "the Master owns Files, where its memory lives");

  const demo = {
    authorization: DEMO_AUTH,
    session: await fetchUpstreamSession(DEMO_AUTH, BASE),
    username: DEMO,
  };
  const team = Object.entries(demo.session.accounts).find(
    ([, account]) => (account as { name?: unknown }).name === TEAM,
  );
  assert.ok(team, "the demo session is a member of the group whose runs are read");
  teamAccount = team[0];
});

after(async () => {
  await releaseClaim(master, HOLDER).catch(() => undefined);
  (mock as { server?: { close(): void } }).server?.close();
});

const HOLDER = "the-surface-test";

test("where the agent is: no claim is held, and the pass interval is the supervisor's", async () => {
  const res = await call("/api/admin/agent");
  assert.equal(res.status, 200);
  const { agent } = res.body as { agent: { claim: unknown; passSeconds: number } };
  assert.equal(agent.claim, null, "nothing holds the installation's claim yet");
  assert.equal(agent.passSeconds, 10, "and the pass is asked for every ten seconds");
});

test("the claim is answered while it is believed, and not once it has lapsed", async () => {
  const taken = await takeClaim(master, HOLDER, new Date());
  assert.ok(taken, "the Master takes its own installation's claim");

  const held = await call("/api/admin/agent");
  assert.equal(
    (held.body as { agent: { claim: { holder: string } | null } }).agent.claim?.holder,
    HOLDER,
    "the holder is named while the claim is inside its instant",
  );

  // The same document, read after its instant: the holder is not believed any
  // more (ADR 0036), so a surface must not show an agent that is not working.
  const lapsed = await takeClaim(
    master,
    HOLDER,
    new Date(Date.parse(taken.expires) + 1_000),
  );
  assert.ok(lapsed, "a lapsed claim is free, and this holder takes it over");
  assert.ok(
    Date.parse(lapsed.expires) > Date.now(),
    "the claim the holder takes over is a fresh one, inside its own instant",
  );
});

test("a claim nobody holds again is not answered as one", async () => {
  await releaseClaim(master, HOLDER);
  const res = await call("/api/admin/agent");
  assert.equal((res.body as { agent: { claim: unknown } }).agent.claim, null);
});

test("the runs a group worked are drawn as the record carries them", async () => {
  /*
   * A plan with an order and a branch (ADR 0034): the second step waits on the
   * first, one per outcome. The surface can only draw a dependency and a branch
   * if they are on the surface, so this is what the listing answers.
   */
  const run = recordStep(
    appendStep(
      startRun({
        id: "surface-run",
        startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
        plan: ["read the mail"],
      }),
      "file it, if the mail was read",
      { step: 0, when: "done" },
    ),
    0,
    { state: "done", outcome: "read one message" },
  );
  await writeAppFileAt(master, teamAccount, runPath(run.id), run);

  const res = await call(`/api/admin/groups/${encodeURIComponent(TEAM)}/runs`);
  assert.equal(res.status, 200);
  const { runs } = res.body as {
    runs: Array<{ id: string; run: typeof run | null; problem: string | null }>;
  };
  const listed = runs.find((row) => row.id === "surface-run");
  assert.ok(listed?.run, "the run the group worked is in the listing");
  assert.equal(
    listed.run.startedBy.woke,
    "mail created: m-1",
    "with the change that woke it",
  );
  assert.equal(listed.run.startedBy.rule, "intake", "and the rule that answered it");
  assert.deepEqual(
    listed.run.plan[1].needs,
    { step: 0, when: "done" },
    "and the dependency of the step that waits on the first",
  );
  assert.equal(
    listed.run.plan[0].outcome,
    "read one message",
    "with what the step answered",
  );
  assert.equal(listed.run.spent.calls, 0, "and the tally of what it spent");

  await writeAppFileAt(master, teamAccount, runPath("future-run"), {
    v: RUN_VERSION + 1,
    id: "future-run",
  });
  const after2 = await call(`/api/admin/groups/${encodeURIComponent(TEAM)}/runs`);
  const rows = (
    after2.body as { runs: Array<{ id: string; run: unknown; problem: string | null }> }
  ).runs;
  const unreadable = rows.find((row) => row.id === "future-run");
  assert.ok(
    unreadable,
    "a document this build cannot read is in the listing, not dropped",
  );
  assert.equal(unreadable.run, null, "and it is drawn as no run at all");
  assert.match(
    unreadable.problem ?? "",
    /runs\/future-run\.json/,
    "the reason names the path",
  );
  assert.ok(
    rows.some((row) => row.id === "surface-run"),
    "and the runs this build reads are still on the surface beside it",
  );
});

test("a group the installation is not granted on is refused with the section it asked for", async () => {
  const res = await call(`/api/admin/groups/${encodeURIComponent(LEGAL)}/runs`);
  assert.equal(res.status, 403);
  assert.deepEqual(
    res.body,
    { error: "group_not_accessible", need: "agent documents" },
    "the refusal is a code and the section, and the sentence is composed where it is read",
  );
});

test("the memory is read, corrected and removed through the administration door", async () => {
  const store = await listFacts(master, memoryAccount);
  const learned = await rememberFact(
    master,
    memoryAccount,
    {
      subject: "Maersk",
      fact: "the usual shipper",
      run: "surface-run",
      at: new Date().toISOString(),
      group: memoryAccount,
    },
    store,
  );

  const listed = await call("/api/admin/memory");
  assert.equal(listed.status, 200);
  const facts = (listed.body as { facts: Array<{ id: string; fact: string }> }).facts;
  const shown = facts.find((fact) => fact.id === learned.id);
  assert.ok(shown, "the fact the agent learned is on the surface");
  assert.equal(shown.fact, "the usual shipper");

  const corrected = await call(`/api/admin/memory/${learned.id}`, {
    method: "PUT",
    body: JSON.stringify({
      subject: "Maersk",
      fact: "the shipper for containers, and only them",
    }),
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));

  // Read back through the store, not through the answer that said it was written.
  const held = (await listFacts(master, memoryAccount)).facts.find(
    (fact) => fact.id === learned.id,
  );
  assert.equal(
    held?.fact,
    "the shipper for containers, and only them",
    "in the Master's memory",
  );
  assert.deepEqual(
    held?.origin,
    { by: "person", who: DEMO },
    "with the person who corrected it",
  );

  // And what the correction is for: the agent's own write is refused against it,
  // so the next pass reasons from the person's sentence rather than overwriting it.
  const afterCorrection = await listFacts(master, memoryAccount);
  await assert.rejects(
    () =>
      rememberFact(
        master,
        memoryAccount,
        {
          subject: "maersk",
          fact: "what the agent concluded instead",
          run: "surface-run",
          at: new Date().toISOString(),
          group: memoryAccount,
        },
        afterCorrection,
      ),
    (err: unknown) => (err as { code?: string }).code === "fact_in_force",
    "a person's fact is in force (ADR 0037)",
  );

  const removed = await call(`/api/admin/memory/${learned.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(
    (await listFacts(master, memoryAccount)).facts.some((fact) => fact.id === learned.id),
    false,
    "and the sheet is gone from the Master's memory",
  );

  const gone = await listFacts(master, memoryAccount);
  await assert.rejects(
    () =>
      correctFactByPerson(
        master,
        memoryAccount,
        {
          id: learned.id,
          subject: "Maersk",
          fact: "x",
          who: DEMO,
          at: new Date().toISOString(),
        },
        gone,
      ),
    (err: unknown) => (err as { code?: string }).code === "fact_not_found",
    "correcting a fact that is not there is refused, not a silent success",
  );
  await assert.rejects(
    () => forgetFact(master, memoryAccount, learned.id, gone.state),
    (err: unknown) => (err as { code?: string }).code === "fact_not_found",
    "and so is removing one twice",
  );
});
