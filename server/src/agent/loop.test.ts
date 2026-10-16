/**
 * The loop that works a run, against the mock Stalwart and a stub model
 * (ADR 0031, 0034, 0035, 0036).
 *
 * What is pinned here is one mechanism per test, and each of them is a mechanism
 * rather than a run of the code:
 *
 * - a change a rule watches opens a run, and the record shows the change, the
 *   rule, the step the model chose and the ending;
 * - a change no rule watches costs no model call and no step at all;
 * - a claim another process holds stops the pass before it works anything;
 * - the budget ends a run that cannot finish, and the record says so;
 * - the authority guard refuses an act the run carries no authority for, and the
 *   refusal is a failed step on the run — the act itself does not run;
 * - the model choosing the same step twice is a stall the record shows, not an
 *   endless turn;
 * - a step that asks a person parks the run on the answer it left;
 * - a run whose wait has come due is picked up again, which is what a restart
 *   loses nothing to.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";
import type { AgentLoopOptions } from "./loop.js";
import type { RuleDoc } from "./rule.js";

const MOCK_PORT = await freePort();
process.env.MOCK_PORT = String(MOCK_PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
// The demo traffic writes into the account on an interval; a loop that measures
// an account's changes reads one nothing else is writing to.
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.APP_SECRET = "test-secret-for-loop";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId, destroyAppNode, readAppFileAt } = await import("../appFolder.js");
const { clientOf } = await import("../util.js");
const { CAPABILITIES } = await import("../shared/capabilities.js");
const { startRun, waitUntil } = await import("../shared/run.js");
const { parseInstallationDocumentDetailed } = await import("../shared/installation.js");

import type { InstallationModel } from "../shared/installation.js";

const { modelAccess } = await import("./model.js");
const { createRule, rulePath } = await import("./rules.js");
const { createRun, listRuns, readRun } = await import("./runs.js");
const { takeClaim, releaseClaim } = await import("./claim.js");
const { RULE_VERSION } = await import("./rule.js");
const { defineTool, TOOLS } = await import("./tools.js");
const { AgentLoop, RUN_STEPS_MAX } = await import("./loop.js");

const BASE = `http://127.0.0.1:${MOCK_PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

/* ------------------------------------------------------------------ */
/* The stub provider                                                   */
/* ------------------------------------------------------------------ */

interface Seen {
  system: string;
  user: string;
}

let seen: Seen[] = [];
let answers: string[] = [];
/**
 * A provider that answers from the call itself rather than a queue, for the
 * tests that need more turns than it is worth writing out.
 */
let onCall: ((system: string, user: string) => unknown) | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const PROVIDER_PORT = await freePort();
const stub = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const raw = await readBody(req);
  const body = JSON.parse(raw) as { messages?: Array<{ content?: string }> };
  const system = body.messages?.[0]?.content ?? "";
  const user = body.messages?.[1]?.content ?? "";
  seen.push({ system, user });
  res.writeHead(200, { "content-type": "application/json" });
  const content = onCall
    ? JSON.stringify(onCall(system, user))
    : (answers.shift() ?? "{}");
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});

/** Answer the next call with this content, as a chat completion carries it. */
function answerWith(value: unknown): void {
  answers.push(JSON.stringify(value));
}

/** Whether the call is the decision turn rather than a choosing one. */
function isDecision(system: string): boolean {
  return system.includes("the rules the group wrote for it");
}

const installation = parseInstallationDocumentDetailed(
  JSON.stringify({
    agent: {
      provider: {
        provider: "ollama",
        model: "a-small-model",
        baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
        apiKey: "sk-a-key",
      },
    },
    secret: "an-installation-secret-long-enough-to-seal-a-session-with",
  }),
);
assert.ok("doc" in installation, "the installation document under test is readable");
const chosen = modelAccess(installation.doc, true)?.model;
assert.ok(chosen, "the document chose a model");
const model: InstallationModel = chosen;

let ctx: Ctx;
let accountId: string;

before(async () => {
  await new Promise<void>((resolve) => stub.listen(PROVIDER_PORT, "127.0.0.1", resolve));
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the demo account owns Files");
});

after(() => {
  stub.close();
  (mock as { server?: { close(): void } }).server?.close();
});

/** The holder every test but the claim's uses. */
const HOLDER = "process-a";
/** Every holder a test takes the claim for, so each one starts free. */
const HOLDERS = [HOLDER, "process-peer"];
/** The rules this test wrote, taken back out when it is over. */
const written: string[] = [];

/**
 * Each test starts with no call seen, no answer queued, and the installation's
 * claim free — the claim is one document for the whole account, so a test that
 * left it held would stop the next one working.
 */
beforeEach(async () => {
  freshCalls();
  for (const holder of HOLDERS) await releaseClaim(ctx, holder);
});

/**
 * A rule lives in the account and outlives the test that wrote it, and every
 * rule watching a surface answers a later test's change: each one is removed
 * with the test that wrote it.
 */
afterEach(async () => {
  for (const id of written.splice(0)) {
    const found = await readAppFileAt(ctx, accountId, rulePath(id));
    const nodeId = found?.file.id;
    if (typeof nodeId === "string") await destroyAppNode(ctx, accountId, nodeId, {});
  }
});

/** Every test starts with no call seen and no answer queued. */
function freshCalls(): void {
  seen = [];
  answers = [];
  onCall = null;
}

/** A rule this build writes, watching one surface, removed with its test. */
async function putRule(
  id: string,
  watches: RuleDoc["watches"] = ["mail"],
): Promise<void> {
  await createRule(ctx, accountId, rule(id, watches));
  written.push(id);
}

/** A rule this build writes, watching one surface. */
function rule(id: string, watches: RuleDoc["watches"] = ["mail"]): RuleDoc {
  return {
    v: RULE_VERSION,
    id,
    watches,
    instruction: "Answer the shipper within the day.",
    sends: false,
  };
}

/** One message delivered into the account: a create in its own Email log. */
async function deliver(subject: string): Promise<string> {
  const answer = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    { accountId, create: { c: { subject, mailboxIds: { inbox: true } } } },
    [CAPABILITIES.mail],
  );
  const id = answer.created?.c?.id;
  assert.ok(id, "the mock created the message");
  return id;
}

/** A loop for this account, with the product's own catalogue. */
function loop(
  holder: string = HOLDER,
  extra: Partial<AgentLoopOptions> = {},
): InstanceType<typeof AgentLoop> {
  freshCalls();
  return new AgentLoop(ctx, {
    holder,
    accounts: [accountId],
    access: { model, allowPrivateProvider: true },
    ...extra,
  });
}

/** The run a rule started, or a failure naming what is missing. */
async function runOf(ruleId: string) {
  const records = await listRuns(ctx, accountId);
  const found = records.find((record) => record.run.startedBy.rule === ruleId);
  assert.ok(found, `a run started by "${ruleId}" should be in the account`);
  return found.run;
}

/* ------------------------------------------------------------------ */

test("a change a rule watches opens a run, and the record shows every step of it", async () => {
  const id = "intake-mail";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rule: id, facts: { shipper: "Maersk" } });
  answerWith({ tool: "chat.say", arguments: { text: "filed with the booking" } });
  answerWith({ done: "the shipper's message is filed" });

  const message = await deliver("a booking confirmation");
  const summary = await agent.pass();

  assert.equal(summary.claimed, true, "the pass holds the installation's claim");
  assert.ok(summary.changes >= 1, "the arrival is a change");
  assert.equal(summary.runs, 1, "and one run answers it");

  const run = await runOf(id);
  assert.equal(
    run.startedBy.woke,
    `mail created: ${message}`,
    "the run says which change woke the rule",
  );
  assert.equal(run.state, "done", "the model said the work was done");
  assert.equal(run.ended?.why, "the shipper's message is filed", "in its own words");
  assert.equal(run.plan.length, 1, "one step was taken");
  assert.match(run.plan[0]?.what ?? "", /^chat\.say /, "and the record says which");
  assert.equal(run.plan[0]?.state, "done");
  assert.match(run.plan[0]?.outcome ?? "", /"id"/, "with what it answered");
  assert.ok(run.spent.calls >= 2, "and what it spent: the turns it took");

  // The decision turn is asked first, and the choosing turn after it.
  assert.equal(isDecision(seen[0]?.system ?? ""), true, "the decision comes first");
  assert.equal(isDecision(seen[1]?.system ?? ""), false, "then the choosing turns");
  assert.match(
    seen[1]?.user ?? "",
    new RegExp(`mail created: ${message}`),
    "and the choosing turn is told the run's own change",
  );
});

test("a change no rule watches costs no model call and no step", async () => {
  const id = "intake-workorder";
  await putRule(id, ["workorder"]);
  const agent = loop();
  await agent.start();

  answerWith({ done: "impossible" });
  const message = await deliver("nobody watches this");
  const summary = await agent.pass();

  assert.ok(summary.changes >= 1, "the arrival is read");
  assert.equal(summary.runs, 0, "and opens nothing");
  assert.equal(seen.length, 0, "the model was never asked");
  assert.equal(answers.length, 1, "and no answer was spent on it");
  assert.equal(
    (await listRuns(ctx, accountId)).some(
      (record) => record.run.startedBy.woke === `mail created: ${message}`,
    ),
    false,
    "no run was opened for it",
  );
});

test("a claim another process holds stops the pass before it works anything", async () => {
  const id = "intake-claimed";
  await putRule(id);
  const peer = await takeClaim(ctx, "process-peer", new Date());
  assert.ok(peer, "the peer takes the installation's claim");
  const agent = loop();
  await agent.start();
  answerWith({ rule: id, facts: {} });
  await deliver("nobody should answer this");

  const summary = await agent.pass();
  assert.equal(summary.claimed, false, "this process does not hold the claim");
  assert.equal(summary.runs, 0, "so it works nothing");
  assert.equal(seen.length, 0, "and asks the model nothing");
  assert.equal(
    (await listRuns(ctx, accountId)).some((record) => record.run.startedBy.rule === id),
    false,
    "and opens no run",
  );
});

test("the budget ends a run that cannot finish, and the record says so", async () => {
  const id = "intake-forever";
  await putRule(id);
  const agent = loop();
  await agent.start();

  // A model that keeps taking steps and never says it is done.
  onCall = (system) => {
    if (isDecision(system)) return { rule: id, facts: {} };
    return {
      tool: "mail.folder",
      arguments: { name: `folder-${seen.length}` },
    };
  };
  await deliver("something to work");
  const summary = await agent.pass();
  assert.equal(summary.runs, 1);

  const run = await runOf(id);
  assert.equal(run.state, "out-of-budget", "the budget ended it, not the model");
  assert.equal(run.spent.steps, RUN_STEPS_MAX, "at the step it is allowed");
  assert.equal(run.plan.length, RUN_STEPS_MAX, "every step it took is on the run");
  assert.match(run.ended?.why ?? "", /budget ended the run/, "and the record says why");
  assert.match(run.ended?.why ?? "", new RegExp(`${RUN_STEPS_MAX} steps`));
});

test("an act the run carries no authority for is refused, and the refusal is on the run", async () => {
  const id = "intake-destroy";
  await putRule(id);
  const ran: string[] = [];
  // The catalogue this loop works with holds one act a person must authorise:
  // what the guard refuses is asked through the same door the real tools use.
  const remove = defineTool({
    name: "mail.remove",
    description: "Destroy a message; a person must authorise it.",
    authority: "destructive",
    writes: true,
    spend: { steps: 1 },
    act: (args: { id: string }) => ({ target: args.id, content: null }),
    parse: (raw: unknown) => raw as { id: string },
    run: async (_call, args: { id: string }) => {
      ran.push(args.id);
      return { id: args.id };
    },
  });
  const agent = loop("process-a", { catalogue: [...TOOLS, remove] });
  await agent.start();

  answerWith({ rule: id, facts: {} });
  answerWith({ tool: "mail.remove", arguments: { id: "m-1" } });
  answerWith({ done: "I could not destroy it, so I left it" });
  await deliver("do not destroy me");

  await agent.pass();
  assert.deepEqual(ran, [], "the act did not run: the guard is the only door");

  const run = await runOf(id);
  assert.equal(run.plan[0]?.state, "failed", "and the refusal is a step, not a skip");
  assert.match(
    run.plan[0]?.outcome ?? "",
    /needs_authority|not the agent's to decide/,
    "which says what the run could not do",
  );
  assert.equal(
    run.ended?.why,
    "I could not destroy it, so I left it",
    "the model was told, and chose again",
  );
});

test("the model choosing the same step twice is a stall the record shows", async () => {
  const id = "intake-stall";
  await putRule(id);
  const agent = loop();
  await agent.start();

  // The same call, twice: it made no progress the first time and cannot the
  // second, and running it again is the endless turn this stops.
  answerWith({ rule: id, facts: {} });
  answerWith({ tool: "mail.folders", arguments: {} });
  answerWith({ tool: "mail.folders", arguments: {} });
  await deliver("a change that stalls");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(run.plan.length, 2, "the step was taken once, not twice over");
  assert.equal(run.plan[0]?.state, "done");
  assert.equal(run.plan[1]?.state, "failed", "the repeat is on the run as a failure");
  assert.match(run.plan[1]?.outcome ?? "", /same step was chosen twice/);
  assert.equal(run.state, "out-of-budget", "and the run stopped rather than turning");
  assert.match(run.ended?.why ?? "", /same step twice/);
});

test("a step that asks a person parks the run on the answer it left", async () => {
  const id = "intake-ask";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rule: id, facts: {} });
  answerWith({ tool: "chat.ask", arguments: { text: "which booking is this?" } });
  await deliver("a message with a question of its own");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(run.state, "blocked", "the run stopped on a person");
  assert.equal(run.waiting?.what, "which booking is this?", "keeping the question");
  assert.equal(run.waiting?.until, null, "with no date: a person answers when they do");
  assert.equal(run.waiting?.asked.channel, "chat", "and where it asked");
  assert.ok(run.waiting?.asked.id, "with the sentence's own id");
  assert.equal(run.plan[0]?.state, "done", "the question was delivered");
});

test("a run whose wait has come due is picked up again, from its document", async () => {
  const id = "intake-due";
  await putRule(id);
  // A run a process wrote and then lost, its wait already past.
  await createRun(
    ctx,
    accountId,
    waitUntil(
      startRun({
        id: "due-run",
        startedBy: { rule: id, instruction: null, woke: "mail created: m-old" },
        plan: ["chat.say the first half"],
      }),
      {
        what: "the booking window",
        asked: { channel: "chat", id: "c-1" },
        until: new Date(Date.now() - 60_000).toISOString(),
      },
    ),
  );

  const agent = loop();
  answerWith({ done: "the window has passed, so it is over" });
  const summary = await agent.start();

  assert.equal(summary.due, 1, "the overdue run is picked up on the first pass");
  const record = await readRun(ctx, accountId, "due-run");
  assert.equal(record?.run.state, "done", "and worked to its ending");
  assert.equal(
    record?.run.ended?.why,
    "the window has passed, so it is over",
    "from where its document left it",
  );
  assert.equal(
    isDecision(seen[0]?.system ?? ""),
    false,
    "a run that exists is not re-decided: the choosing turn is asked directly",
  );
});
