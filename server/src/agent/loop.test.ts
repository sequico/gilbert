/**
 * The loop that works a run, against the mock Stalwart and a stub model
 * (ADR 0031, 0034, 0035, 0036).
 *
 * What is pinned here is one mechanism per test, and each of them is a mechanism
 * rather than a run of the code:
 *
 * - a change a rule watches opens a run, and the record shows the change, the
 *   rule, the step the model chose and the ending;
 * - **every** rule that fits one change opens its own run, each naming its own
 *   rule and the change it answered;
 * - the same rule and the same change are one run, continued from its document
 *   rather than opened a second time;
 * - a change no rule watches costs no model call and no step at all;
 * - the accounts the pass works are asked for on **every** pass, so a group the
 *   Master is added to is worked by the next one;
 * - a claim another process holds stops the pass before it works anything;
 * - the budget ends a run that cannot finish, and the record says so;
 * - the authority guard refuses an act the run carries no authority for, and the
 *   refusal is a failed step on the run — the act itself does not run;
 * - the model choosing the same step twice is a stall the record shows, not an
 *   endless turn;
 * - a turn's plan is executed together — three independent calls are three steps,
 *   a refused call leaves its siblings' steps beside it, the ready calls run at
 *   once, and a wait is honoured after them;
 * - a step that waits on an earlier one runs the branch that step's outcome
 *   names and is left unrun when no branch does, and the record says which step
 *   and which outcome left it;
 * - an answer whose plan cannot be read is refused whole, recorded, and asked
 *   again;
 * - a step that asks a person parks the run on the answer it left;
 * - **the plan is on the run before the first act of the answer runs**, and each
 *   outcome on the same document after it;
 * - a run whose wait has come due is picked up again, which is what a restart
 *   loses nothing to.
 * - a fact one run learned is handed to the next change's call, and the run's
 *   record names what it recalled — while a change the memory holds nothing
 *   about is worked exactly as it was before the memory existed;
 * - every call is told the installation's line and the group's standing
 *   instruction, in the record's order, above the rule's own;
 * - two `memory.remember` calls in one answer leave one sheet for the subject:
 *   the call that lost the compare-and-set reads the memory again and updates
 *   the sheet, so neither is a refused step.
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
const { groupMembers } = await import("../groupAccess.js");
const { filesAccountId, destroyAppNode, readAppFileAt, writeAppFileAt } = await import(
  "../appFolder.js"
);
const { clientOf } = await import("../util.js");
const { CAPABILITIES } = await import("../shared/capabilities.js");
const { finishRun, startRun, waitUntil } = await import("../shared/run.js");
const { parseInstallationDocumentDetailed } = await import("../shared/installation.js");

import type { InstallationModel } from "../shared/installation.js";

const { modelAccess } = await import("./model.js");
const { postChatMessage } = await import("../groupChat.js");
const { createRule, rulePath } = await import("./rules.js");
const { factPath, listFacts } = await import("./memory.js");
const { isGroupAccountRecord } = await import("../shared/sessionAccount.js");
const { sameSubject } = await import("../shared/memory.js");
const { createRun, listRuns, readRun } = await import("./runs.js");
const { INSTRUCTION_FILE, INSTRUCTION_VERSION, readInstruction } = await import(
  "./instruction.js"
);
const { takeClaim, releaseClaim } = await import("./claim.js");
const { RULE_VERSION } = await import("./rule.js");
const { defineTool, TOOLS } = await import("./tools.js");
const { administratorAt, AgentLoop, RUN_STEPS_MAX } = await import("./loop.js");
const { config } = await import("../config.js");

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

/** Whether the call is the one that reads a person's answer for what it authorises. */
function isAuthorisation(system: string): boolean {
  return system.includes("their own words authorise");
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
/**
 * The account the loop works: a **group** of the Master's session.
 *
 * The installation's memory lives in the Master's **own** account (ADR 0037)
 * and the runs and rules of a worked change live in the group's, and the two are
 * never one account — a group is a shared account (`isPersonal: false`) while
 * the Master's own is personal, which is what the classifier reads. The pass
 * reads the memory once and writes a fact against that reading's token, so a
 * fixture that made one account hold both would have the run documents it writes
 * invalidate the memory's token before the fact is written.
 */
let accountId: string;
/** The Master's own account: the installation's memory lives here (ADR 0037). */
let memoryAccountId: string;

before(async () => {
  await new Promise<void>((resolve) => stub.listen(PROVIDER_PORT, "127.0.0.1", resolve));
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  memoryAccountId = filesAccountId(ctx);
  assert.ok(memoryAccountId, "the Master's session owns Files");
  const groups = Object.keys(session.accounts).filter((id) =>
    isGroupAccountRecord(
      session.accounts[id] as { name?: unknown; isPersonal?: unknown },
    ),
  );
  const group = groups[0];
  assert.ok(group, "the Master's session holds a group to work");
  accountId = group;
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
/** The facts this test's runs wrote into the installation's memory. */
const remembered: string[] = [];

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
 * with the test that wrote it. The same goes for the facts a run remembered —
 * the memory is one store for the whole installation, so a fact left behind
 * would be recalled by every later test's calls.
 */
afterEach(async () => {
  for (const id of written.splice(0)) {
    const found = await readAppFileAt(ctx, accountId, rulePath(id));
    const nodeId = found?.file.id;
    if (typeof nodeId === "string") await destroyAppNode(ctx, accountId, nodeId, {});
  }
  for (const id of remembered.splice(0)) {
    const found = await readAppFileAt(ctx, memoryAccountId, factPath(id));
    const nodeId = found?.file.id;
    if (typeof nodeId === "string")
      await destroyAppNode(ctx, memoryAccountId, nodeId, {});
  }
  // A group's standing instruction outlives the test too, and every later call
  // of this account would carry it.
  const instruction = await readAppFileAt(ctx, accountId, INSTRUCTION_FILE);
  if (typeof instruction?.file.id === "string")
    await destroyAppNode(ctx, accountId, instruction.file.id, {});
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
    accounts: async () => [accountId],
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

  answerWith({ rules: [id], facts: { shipper: "Maersk" } });
  answerWith({
    calls: [{ name: "chat.say", arguments: { text: "filed with the booking" } }],
  });
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

test("two changes of one address open one run, not two", async () => {
  const id = "intake-fused";
  await putRule(id, ["workorder"]);
  const agent = loop();
  await agent.start();

  // A node written twice in one batch — created and then written again through
  // the update path — is two changes for one document. The rule answers one
  // document with one run: two would let the agent answer it twice.
  onCall = (system) =>
    isDecision(system) ? { rules: [id], facts: {} } : { done: "noted" };
  await writeAppFileAt(ctx, accountId, "workorders/wo-fused.json", {
    v: 1,
    uid: "wo-fused",
  });
  await writeAppFileAt(ctx, accountId, "workorders/wo-fused.json", {
    v: 1,
    uid: "wo-fused",
    name: "written again",
  });
  const summary = await agent.pass();

  assert.equal(
    summary.runs,
    1,
    "one document opened one run, however many changes it made",
  );
  const runs = (await listRuns(ctx, accountId)).filter(
    (record) => record.run.startedBy.rule === id,
  );
  assert.equal(runs.length, 1, "and only one run for it is in the account");
});

test("every rule that fits one change opens its own run", async () => {
  // Two rules a group wrote over the same surface. Both are its decision, so
  // neither is set aside for the other: the change is put to the decision turn
  // once, and every rule it names gets a run of its own (ADR 0035).
  const first = "intake-bookings";
  const second = "intake-containers";
  await putRule(first);
  await putRule(second);
  const agent = loop();
  await agent.start();

  onCall = (system) =>
    isDecision(system)
      ? { rules: [first, second], facts: { shipper: "Maersk" } }
      : { done: "answered it" };
  const message = await deliver("a message both rules cover");
  const summary = await agent.pass();

  assert.equal(summary.runs, 2, "two rules over one change are two runs");
  const a = await runOf(first);
  const b = await runOf(second);
  assert.notEqual(a.id, b.id, "each run is its own document");
  assert.equal(a.startedBy.rule, first, "each run names the rule that started it");
  assert.equal(b.startedBy.rule, second);
  assert.equal(
    a.startedBy.woke,
    `mail created: ${message}`,
    "and each carries the change that woke it",
  );
  assert.equal(b.startedBy.woke, `mail created: ${message}`);
  assert.equal(a.state, "done", "and both were worked to their ending");
  assert.equal(b.state, "done");
  assert.equal(
    seen.filter((call) => isDecision(call.system)).length,
    1,
    "the change is put to the decision turn once, not once per rule",
  );
  for (const call of seen.filter((one) => !isDecision(one.system)))
    assert.match(
      call.user,
      /shipper: Maersk/,
      "and every run's turn is told what the change was found to be about",
    );
});

test("the same rule and the same change continue one run rather than open a second", async () => {
  /*
   * A pass re-reads a change whose batch it did not finish — the cursor only
   * moves once the whole read is answered — and the same rule must not answer
   * the same change twice. What says the change has been answered is the
   * account's own record: a run whose `startedBy` names this rule and this
   * change. One still running is continued from its document; one that ended is
   * the answer it already has.
   */
  const id = "intake-once";
  await putRule(id);
  const agent = loop();
  await agent.start();

  const message = await deliver("a booking confirmation");
  await createRun(
    ctx,
    accountId,
    startRun({
      id: "already-open",
      startedBy: { rule: id, instruction: null, woke: `mail created: ${message}` },
      plan: ["chat.say the first half"],
    }),
  );
  onCall = (system) =>
    isDecision(system) ? { rules: [id], facts: {} } : { done: "the rest is done" };
  const summary = await agent.pass();

  assert.equal(summary.runs, 0, "no second run was opened for this rule and this change");
  const runs = (await listRuns(ctx, accountId)).filter(
    (record) => record.run.startedBy.rule === id,
  );
  assert.equal(runs.length, 1, "the account holds the one run for that change");
  assert.equal(runs[0]?.run.id, "already-open", "and it is the one already there");
  assert.equal(
    runs[0]?.run.plan.length,
    1,
    "which kept the plan it had rather than being replaced by a fresh run",
  );
  assert.equal(
    runs[0]?.run.ended?.why,
    "the rest is done",
    "and was worked to its ending",
  );
  assert.match(
    seen.find((call) => !isDecision(call.system))?.user ?? "",
    /chat\.say the first half/,
    "the choosing turn was told where that run's own document had left it",
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
  answerWith({ rules: [id], facts: {} });
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

test("a group added between two passes is worked by the pass that follows", async () => {
  const id = "intake-joined";
  await putRule(id);
  /*
   * The Master works no group at first: the passes before the grant resolve no
   * account, so nothing in this one is read at all — and the reading of a group
   * that appears anchors where the account stands then, so what it did before
   * the Master held it is not replayed (`events.ts`).
   */
  let accounts: string[] = [];
  const agent = loop(HOLDER, { accounts: async () => accounts });
  await agent.start();
  assert.equal(
    (await agent.pass()).accounts,
    0,
    "a Master in no group has nothing worked for it",
  );

  // The Master is added to the group, between two passes.
  accounts = [accountId];
  await agent.pass();
  answerWith({ rules: [id], facts: {} });
  answerWith({ done: "the shipper's message is filed" });
  const message = await deliver("a booking confirmation");
  const summary = await agent.pass();

  assert.equal(summary.accounts, 1, "the pass that follows works the group");
  assert.equal(summary.runs, 1, "and answers the change it finds there");
  const run = await runOf(id);
  assert.equal(
    run.startedBy.woke,
    `mail created: ${message}`,
    "with the change that woke it, as any other pass would",
  );
});

test("the budget ends a run that cannot finish, and the record says so", async () => {
  const id = "intake-forever";
  await putRule(id);
  const agent = loop();
  await agent.start();

  // A model that keeps taking steps and never says it is done.
  onCall = (system) => {
    if (isDecision(system)) return { rules: [id], facts: {} };
    return {
      calls: [{ name: "mail.folder", arguments: { name: `folder-${seen.length}` } }],
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

  answerWith({ rules: [id], facts: {} });
  answerWith({ calls: [{ name: "mail.remove", arguments: { id: "m-1" } }] });
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
  answerWith({ rules: [id], facts: {} });
  answerWith({ calls: [{ name: "mail.folders", arguments: {} }] });
  answerWith({ calls: [{ name: "mail.folders", arguments: {} }] });
  await deliver("a change that stalls");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(run.plan.length, 2, "the step was taken once, not twice over");
  assert.equal(run.plan[0]?.state, "done");
  assert.equal(run.plan[1]?.state, "failed", "the repeat is on the run as a failure");
  assert.match(run.plan[1]?.outcome ?? "", /same calls were chosen twice/);
  assert.equal(run.state, "out-of-budget", "and the run stopped rather than turning");
  assert.match(run.ended?.why ?? "", /same calls twice/);
});

test("a step that asks a person parks the run on the answer it left", async () => {
  const id = "intake-ask";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [{ name: "chat.ask", arguments: { text: "which booking is this?" } }],
  });
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

test("a person's answer continues the run that asked for it", async () => {
  /*
   * A run parked on a person has no alarm and no due date, so the answer is the
   * only thing that can pick it up — and it arrives in the chat as a message of
   * its own, which the change log reports at a path of its own, so nothing about
   * the change names the run. What ties the two together is the question: the
   * message replies to the sentence the run recorded as its wait, and somebody
   * other than the agent wrote it (ADR 0033, 0034).
   */
  const id = "intake-answer";
  // The question, and the run that parked on it, are both there before the loop
  // starts reading: the answer below is then the only change the pass finds.
  const asked = await postChatMessage(
    ctx,
    accountId,
    ctx.username,
    "which booking is this?",
  );
  await createRun(
    ctx,
    accountId,
    finishRun(
      waitUntil(
        startRun({
          id: "parked-on-a-person",
          startedBy: {
            rule: id,
            instruction: null,
            woke: "chat created: gilbert/chat/q.json",
          },
        }),
        {
          what: "which booking is this?",
          asked: { channel: "chat", id: asked },
          until: null,
        },
      ),
      "blocked",
      {
        at: new Date().toISOString(),
        why: "waiting on a person: which booking is this?",
      },
    ),
  );
  await putRule(id, ["chat"]);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: { booking: "BK-1" } });
  // What the answer authorises is read before the run goes on (ADR 0032): the
  // sentence only says which booking it is, so it authorises no act.
  answerWith({ authorisations: [] });
  answerWith({ done: "the booking is filed under BK-1" });
  const reply = await postChatMessage(ctx, accountId, "sam@example.org", "it is BK-1", {
    replyTo: asked,
  });
  const summary = await agent.pass();

  assert.equal(summary.runs, 0, "the answer opened no run of its own");
  assert.equal(summary.due, 1, "and picked the parked run up again");
  const record = await readRun(ctx, accountId, "parked-on-a-person");
  const answered = record?.run;
  assert.equal(answered?.state, "done", "the run that asked was worked to its ending");
  assert.equal(answered?.ended?.why, "the booking is filed under BK-1");
  assert.equal(answered?.waiting, null, "and it waits for nothing any more");
  const step = answered?.plan.at(-1);
  assert.match(
    step?.what ?? "",
    new RegExp(`the answer in chat ${reply}`),
    "and the record names the message the answer came in",
  );
  assert.equal(step?.outcome, "it is BK-1", "with what the person said");
  assert.deepEqual(
    answered?.authorisations,
    [],
    "and a sentence that authorises no act records none",
  );
});

test("an answer is worked once, whatever the decision names beside it", async () => {
  /*
   * One person's reply continues the run that asked, and it is worked once
   * (ADR 0033). The decision turn may name more than one rule for the message —
   * two rules watching chat both fit a reply — and working the same answer once
   * per rule, from the document as it stood before the first working, rewrites
   * the steps the first one recorded. The record is the product (ADR 0034), so
   * the step the answer wrote is on it exactly once.
   */
  const id = "answer-once";
  const beside = "answer-once-beside";
  const asked = await postChatMessage(
    ctx,
    accountId,
    ctx.username,
    "which booking is this?",
  );
  await createRun(
    ctx,
    accountId,
    finishRun(
      waitUntil(
        startRun({
          id: "parked-once",
          startedBy: {
            rule: id,
            instruction: null,
            woke: "chat created: gilbert/chat/q.json",
          },
        }),
        {
          what: "which booking is this?",
          asked: { channel: "chat", id: asked },
          until: null,
        },
      ),
      "blocked",
      { at: new Date().toISOString(), why: "waiting on a person" },
    ),
  );
  await putRule(id, ["chat"]);
  await putRule(beside, ["chat"]);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id, beside], facts: {} });
  answerWith({ authorisations: [] });
  answerWith({ done: "it is BK-1" });
  const reply = await postChatMessage(ctx, accountId, "sam@example.org", "it is BK-1", {
    replyTo: asked,
  });
  const summary = await agent.pass();

  assert.equal(summary.runs, 0, "the answer opened no run of its own");
  assert.equal(summary.due, 1, "and the run it answered was worked once");
  const answered = (await readRun(ctx, accountId, "parked-once"))?.run;
  assert.equal(answered?.state, "done", "to its ending");
  assert.equal(
    answered?.plan.filter((step) => step.what === `the answer in chat ${reply}`).length,
    1,
    "and the answer is on the record once, not once per rule the decision named",
  );
});

test("a person's answer is the word an outward act asks for, recorded for that act", async () => {
  /*
   * The path ADR 0032 leaves open (owner decision 2026-10-18): the sentence that
   * answers a run's question can also be the word a class asks for. The reading is
   * a call, and what bounds it is the act: the authorisation names one act, and
   * the guard compares that act exactly, so what is recorded here licenses the step
   * whose act it matches and nothing else.
   */
  const id = "intake-authorised";
  const asked = await postChatMessage(
    ctx,
    accountId,
    ctx.username,
    "shall I send the reply to the shipper?",
  );
  await createRun(
    ctx,
    accountId,
    finishRun(
      waitUntil(
        startRun({
          id: "parked-for-a-word",
          startedBy: {
            rule: id,
            instruction: null,
            woke: "chat created: gilbert/chat/word.json",
          },
        }),
        {
          what: "shall I send the reply to the shipper?",
          asked: { channel: "chat", id: asked },
          until: null,
        },
      ),
      "blocked",
      {
        at: new Date().toISOString(),
        why: "waiting on a person: shall I send the reply to the shipper?",
      },
    ),
  );
  await putRule(id, ["chat"]);

  /* The act a person is asked for, as a stand-in: the mail channel's send is not
     in the catalogue (ADR 0033), and what is under test is the word and the guard. */
  const sent: string[] = [];
  const sendOut = defineTool<{ to: string; text: string }>({
    name: "test.send",
    description:
      "Send one message outward — the stand-in for the act a person authorises.",
    authority: "outward",
    writes: true,
    spend: { steps: 1 },
    act: (args: { to: string; text: string }) => ({
      target: args.to,
      content: args.text,
    }),
    parse: (raw: unknown) => {
      const one = raw as { to?: unknown; text?: unknown };
      return { to: String(one.to ?? ""), text: String(one.text ?? "") };
    },
    run: async (_call, args: { to: string }) => {
      sent.push(args.to);
      return { sentTo: args.to };
    },
  });
  const agent = loop(HOLDER, { catalogue: [...TOOLS, sendOut] });
  await agent.start();

  const words = "yes, send it: the booked slot is Thursday";
  onCall = (system) =>
    isAuthorisation(system)
      ? {
          authorisations: [
            {
              authority: "outward",
              target: "ops@shipper.example",
              content: "the booked slot is Thursday",
            },
          ],
        }
      : isDecision(system)
        ? { rules: [id], facts: {} }
        : {
            calls: [
              {
                name: "test.send",
                arguments: {
                  to: "ops@shipper.example",
                  text: "the booked slot is Thursday",
                },
              },
            ],
          };
  const reply = await postChatMessage(ctx, accountId, "sam@example.org", words, {
    replyTo: asked,
  });
  const summary = await agent.pass();
  assert.equal(summary.due, 1, "the answer picked the parked run up");

  const record = await readRun(ctx, accountId, "parked-for-a-word");
  const answered = record?.run;
  assert.deepEqual(
    answered?.authorisations.map((one) => ({
      authority: one.authority,
      act: one.act,
      by: one.by,
      from: one.from.id,
      what: one.what,
    })),
    [
      {
        authority: "outward",
        act: { target: "ops@shipper.example", content: "the booked slot is Thursday" },
        by: "sam@example.org",
        from: reply,
        what: words,
      },
    ],
    "the person's own words, the act they name, the address and the message",
  );
  assert.deepEqual(
    sent,
    ["ops@shipper.example"],
    "and the act the word was for is the act that ran",
  );
});

test("a question asked by mail parks the run, and a reply on its thread continues it", async () => {
  /*
   * The conversation's other half (ADR 0033). The question leaves from the group's
   * own identity to a principal with access, the run waits with no date, and the
   * answer is the message whose thread names the question — mail's own
   * correlation, and the same bound as chat: the sender is never the group itself.
   *
   * The account is chosen for its **mail**: the shared account these tests work by
   * default carries none in the mock, so a message created there is a change with
   * no message behind it.
   */
  let mailAccount = "";
  for (const id of Object.keys(ctx.session.accounts)) {
    const list = await clientOf(ctx).call<{ list?: unknown[] }>(
      "Email/get",
      { accountId: id, ids: null },
      [CAPABILITIES.mail],
    );
    if ((list.list ?? []).length) {
      mailAccount = id;
      break;
    }
  }
  assert.ok(mailAccount, "the mock has an account with mail");
  const members = await groupMembers(ctx, mailAccount);
  assert.ok(members?.length, "the directory says who has access to it");
  // A person who is not the agent: its own address is its own mail, and an
  // echo is never an answer (the trust reading refuses it by name).
  const answerer = members.find((address) => address !== ctx.username);
  assert.ok(answerer, "somebody other than the agent can answer");

  const id = "intake-by-mail";
  const ruleFor = rule(id, ["mail"]);
  await createRule(ctx, mailAccount, ruleFor);
  const agent = loop(HOLDER, { accounts: async () => [mailAccount] });
  await agent.start();

  const question = "which booking is this?";
  /* Answered by kind: the question is itself a change on the mail rail, so a later
     pass makes more calls than the reply alone accounts for. */
  let planned = false;
  onCall = (system) => {
    if (isAuthorisation(system)) return { authorisations: [] };
    if (isDecision(system)) return { rules: [id], facts: {} };
    if (!planned) {
      planned = true;
      return {
        calls: [
          {
            name: "mail.ask",
            arguments: { to: members[0], subject: "a question", text: question },
          },
        ],
      };
    }
    return { done: "the booking is BK-2" };
  };
  await clientOf(ctx).call(
    "Email/set",
    {
      accountId: mailAccount,
      create: {
        c: { subject: "a booking needing an answer", mailboxIds: { inbox: true } },
      },
    },
    [CAPABILITIES.mail],
  );
  await agent.pass();

  const parked = (await listRuns(ctx, mailAccount)).find(
    (record) => record.run.startedBy.rule === id && record.run.state === "blocked",
  )?.run;
  assert.ok(parked, "the pass opened a run");
  assert.equal(parked.state, "blocked", "and the question parked it on a person");
  assert.equal(parked.waiting?.asked?.channel, "mail", "waiting on a mail answer");
  const askedId = parked.waiting?.asked?.id;
  assert.ok(askedId, "the question's own message is what the wait names");

  const sent = await clientOf(ctx).call<{ list?: Array<{ messageId?: string[] }> }>(
    "Email/get",
    { accountId: mailAccount, ids: [askedId], properties: ["messageId"] },
    [CAPABILITIES.mail],
  );
  const messageId = sent.list?.[0]?.messageId?.[0];
  assert.ok(messageId, "and the sent question names itself in the account");

  const delivered = await clientOf(ctx).call<{ created?: { r?: { id?: string } } }>(
    "Email/set",
    {
      accountId: mailAccount,
      create: {
        r: {
          subject: "Re: a question",
          from: [{ email: answerer }],
          to: [{ email: "demo@example.com" }],
          inReplyTo: [messageId],
          references: [messageId],
          mailboxIds: { inbox: true },
          bodyStructure: { partId: "text", type: "text/plain" },
          bodyValues: { text: { value: "it is BK-2" } },
          // A message created here stands in for a delivered one, and the
          // reading takes an answer only on the server's record of the
          // submission: the account that authenticated is the sender (ADR 0033).
          "header:Received:asText:all": [
            `from [10.0.0.9] (localhost [127.0.0.1]) by mx.example.org with ESMTPSA id x1 (Authenticated sender: ${answerer})`,
          ],
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const reply = delivered.created?.r?.id;
  assert.ok(reply, "the reply is in the account");
  const summary = await agent.pass();
  assert.ok(summary.due >= 1, "the reply picked the parked run up");
  const answered = (await readRun(ctx, mailAccount, parked.id))?.run;
  assert.equal(answered?.state, "done", "the run that asked was worked to its ending");
  const step = answered?.plan.at(-1);
  assert.match(
    step?.what ?? "",
    new RegExp(`the answer in mail ${reply}`),
    "and the record names the message the answer came in",
  );
  assert.equal(step?.outcome, "it is BK-2", "with what the person said");

  const found = await readAppFileAt(ctx, mailAccount, rulePath(id));
  if (typeof found?.file.id === "string")
    await destroyAppNode(ctx, mailAccount, found.file.id, {});
});

test("only the directory can say a sender is an administrator", async () => {
  /*
   * Owner decision (2026-10-18): an override is an administrator's, and the
   * proof is the server's own answer about the person's account. What the
   * reading does with that answer is `model.test.ts`; this is the half that
   * decides it, and it must fail closed when the directory will not say.
   */
  const ctx = {
    authorization: `Basic ${Buffer.from("agent@example.com:secret").toString("base64")}`,
    username: "agent@example.com",
  };
  const admin = async () => ({ permissions: [config.adminPermissionMarker] }) as never;
  const plain = async () => ({ permissions: [] }) as never;
  const silent = async () => {
    throw new Error("the directory did not answer");
  };

  assert.equal(await administratorAt(ctx, "sam@example.org", admin), true);
  assert.equal(await administratorAt(ctx, "sam@example.org", plain), false);
  assert.equal(
    await administratorAt(ctx, "sam@example.org", silent),
    false,
    "a directory that will not answer is a no",
  );
});

test("a change that answers nothing of ours opens a run of its own", async () => {
  // The same message, with no question of ours behind it: a change a rule watches
  // is a change the rule answers, and the answer-continuation is not a way for a
  // chat message to be swallowed.
  const id = "intake-answer-elsewhere";
  await putRule(id, ["chat"]);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({ done: "noted it" });
  await postChatMessage(ctx, accountId, "sam@example.org", "a message about the berth");
  const summary = await agent.pass();

  assert.equal(summary.runs, 1, "a chat change nothing of ours asked for opens a run");
  assert.equal(summary.due, 0, "and picks up no parked run");
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

test("the independent calls of one answer are executed, each its own step", async () => {
  const id = "intake-batch";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [
      { name: "chat.say", arguments: { text: "filed the message" } },
      { name: "chat.say", arguments: { text: "the attachment is saved" } },
      { name: "chat.say", arguments: { text: "asking about the next step" } },
    ],
  });
  answerWith({ done: "three things said" });
  await deliver("a message that needs three things");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(run.plan.length, 3, "every call of the answer is its own step");
  for (const step of run.plan) {
    assert.equal(step.state, "done", "and each one ran");
    assert.match(step.what, /^chat\.say /, "the record says which tool each was");
    assert.match(step.outcome, /"id"/, "and what it answered");
  }
  assert.equal(
    new Set(run.plan.map((step) => step.outcome)).size,
    3,
    "the three calls were executed, not one call recorded three times",
  );
});

test("the steps of one answer that are ready run together, not one after another", async () => {
  const id = "intake-parallel";
  await putRule(id);
  // A tool that is in flight for a moment: two of them overlap only if the loop
  // makes them at once.
  const inFlight = { now: 0, most: 0 };
  const hold = defineTool({
    name: "probe.hold",
    description: "a call that is in flight for a moment, so two can overlap",
    authority: "reversible",
    writes: false,
    parse: () => ({}),
    run: async () => {
      inFlight.now += 1;
      inFlight.most = Math.max(inFlight.most, inFlight.now);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight.now -= 1;
      return { held: true };
    },
  });
  const agent = loop(HOLDER, { catalogue: [...TOOLS, hold] });
  await agent.start();

  onCall = (system) =>
    isDecision(system)
      ? { rules: [id], facts: {} }
      : {
          calls: [
            { name: "probe.hold", arguments: {} },
            { name: "probe.hold", arguments: {} },
          ],
        };
  await deliver("a change that wants two calls at once");
  await agent.pass();

  assert.equal(
    inFlight.most,
    2,
    "both calls of one answer were in flight at once; a loop that ran them one after another would reach 1",
  );
});

test("a refused call in a wave leaves its siblings' steps on the record", async () => {
  const id = "intake-partial";
  await putRule(id);
  const ran: string[] = [];
  // One act a person must authorise, beside an act the agent may take alone.
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
  const agent = loop(HOLDER, { catalogue: [...TOOLS, remove] });
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [
      { name: "mail.remove", arguments: { id: "m-1" } },
      { name: "chat.say", arguments: { text: "I could not remove it, so I left it" } },
    ],
  });
  answerWith({ done: "left it where it is" });
  await deliver("do not destroy me");
  await agent.pass();

  assert.deepEqual(ran, [], "the act the run carries no authority for did not run");
  const run = await runOf(id);
  assert.equal(run.plan.length, 2, "both calls of the answer are on the record");
  assert.equal(run.plan[0]?.state, "failed", "the refused call is a failed step");
  assert.match(
    run.plan[0]?.outcome ?? "",
    /needs_authority|not the agent's to decide/,
    "which says what the run could not do",
  );
  assert.equal(run.plan[1]?.state, "done", "and its sibling ran and is a done step");
  assert.match(run.plan[1]?.what ?? "", /^chat\.say /);
});

test("a wait in an answer is honoured after it, with the other calls on the record", async () => {
  const id = "intake-batch-wait";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [
      { name: "chat.say", arguments: { text: "I filed the message" } },
      { name: "chat.ask", arguments: { text: "which folder should this go in?" } },
    ],
  });
  await deliver("a message with a question of its own");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(run.plan.length, 2, "the write and the question both ran");
  assert.equal(run.plan[0]?.state, "done", "the report was said");
  assert.match(run.plan[0]?.outcome ?? "", /"id"/, "with what it answered");
  assert.equal(run.plan[1]?.state, "done", "and the question was asked");
  assert.equal(
    run.state,
    "blocked",
    "the run parks on the person's answer after the answer is worked out",
  );
  assert.equal(run.waiting?.what, "which folder should this go in?");
  assert.equal(run.waiting?.until, null, "with no date: a person answers when they do");
  assert.equal(run.waiting?.asked.channel, "chat", "and where it asked");
});

test("a step that waits on an earlier one runs the branch that step's outcome names", async () => {
  /*
   * The model writes the order and the conditions (ADR 0034): the later steps of
   * the plan both wait on the first, one for each outcome it can have, so the
   * same plan takes whichever branch the outcome names — and the branch that did
   * not come is left unrun on the record, with which step and which outcome left
   * it. Two runs, because the two outcomes are two facts.
   */
  const id = "intake-branches";
  await putRule(id);
  const ran: string[] = [];
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
  const agent = loop(HOLDER, { catalogue: [...TOOLS, remove] });
  await agent.start();

  // Run one: the first step lands, so the branch for "done" runs.
  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [
      { id: "first", name: "chat.say", arguments: { text: "the first act" } },
      {
        name: "chat.say",
        arguments: { text: "it worked" },
        needs: { step: "first", when: "done" },
      },
      {
        name: "chat.say",
        arguments: { text: "it did not work" },
        needs: { step: "first", when: "failed" },
      },
    ],
  });
  answerWith({ done: "the branch that came was taken" });
  const landed = await deliver("a change whose first step lands");
  await agent.pass();

  // Run two: the first step is refused, so the branch for "failed" is the one.
  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [
      { id: "first", name: "mail.remove", arguments: { id: "m-1" } },
      {
        name: "chat.say",
        arguments: { text: "it worked" },
        needs: { step: "first", when: "done" },
      },
      {
        name: "chat.say",
        arguments: { text: "it did not work" },
        needs: { step: "first", when: "failed" },
      },
    ],
  });
  answerWith({ done: "the other branch was taken" });
  const refused = await deliver("a change whose first step is refused");
  await agent.pass();

  const runs = (await listRuns(ctx, accountId)).filter(
    (record) => record.run.startedBy.rule === id,
  );
  const woke = (message: string): string => `mail created: ${message}`;
  const of = (message: string) => {
    const found = runs.find((record) => record.run.startedBy.woke === woke(message));
    assert.ok(found, `a run for ${message} should be in the account`);
    return found.run;
  };

  const tookDone = of(landed);
  assert.deepEqual(
    tookDone.plan.map((step) => step.state),
    ["done", "done", "skipped"],
    "the first step landed, so that branch ran and the other was left unrun",
  );
  assert.deepEqual(
    tookDone.plan[2]?.needs,
    { step: 0, when: "failed" },
    "and the record says what the step that did not run waited for",
  );
  assert.match(
    tookDone.plan[2]?.outcome ?? "",
    /left unrun: it waits on step 1 ending failed, and that step ended done/,
    "naming the step and the outcome that left it, so a reader can say why it did not run",
  );

  const tookFailed = of(refused);
  assert.deepEqual(
    tookFailed.plan.map((step) => step.state),
    ["failed", "skipped", "done"],
    "with the first step refused, the other branch is the one that ran",
  );
  assert.match(
    tookFailed.plan[1]?.outcome ?? "",
    /left unrun: it waits on step 1 ending done, and that step ended failed/,
    "and its record names the step and the outcome that left it too",
  );
  assert.deepEqual(
    ran,
    [],
    "the destructive act the run carries no authority for never ran",
  );
});

test("a step whose dependency was left unrun is left unrun too, and the record says so", async () => {
  const id = "intake-skipped-chain";
  await putRule(id);
  const remove = defineTool({
    name: "mail.remove",
    description: "Destroy a message; a person must authorise it.",
    authority: "destructive",
    writes: true,
    spend: { steps: 1 },
    act: (args: { id: string }) => ({ target: args.id, content: null }),
    parse: (raw: unknown) => raw as { id: string },
    run: async (_call, args: { id: string }) => ({ id: args.id }),
  });
  const agent = loop(HOLDER, { catalogue: [...TOOLS, remove] });
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [
      { id: "destroy", name: "mail.remove", arguments: { id: "m-1" } },
      {
        id: "report",
        name: "chat.say",
        arguments: { text: "it was destroyed" },
        needs: { step: "destroy", when: "done" },
      },
      {
        name: "chat.say",
        arguments: { text: "after the report" },
        needs: { step: "report", when: "done" },
      },
    ],
  });
  answerWith({ done: "nothing of the plan could be taken" });
  await deliver("do not destroy me");
  await agent.pass();

  const run = await runOf(id);
  assert.deepEqual(
    run.plan.map((step) => step.state),
    ["failed", "skipped", "skipped"],
    "the refused act leaves the step that waited on it, and the one after that, unrun",
  );
  assert.match(
    run.plan[1]?.outcome ?? "",
    /left unrun: it waits on step 1 ending done, and that step ended failed/,
  );
  assert.match(
    run.plan[2]?.outcome ?? "",
    /left unrun: it waits on step 2, which was itself left unrun/,
    "and a step waiting on one that was itself left unrun says that much",
  );
});

test("an answer whose plan cannot be read is refused whole, recorded, and asked again", async () => {
  const id = "intake-refused-plan";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  // A step waiting on a step the answer does not carry: a plan cannot cycle.
  answerWith({
    calls: [
      {
        name: "chat.say",
        arguments: { text: "the only step" },
        needs: { step: "nowhere", when: "done" },
      },
    ],
  });
  answerWith({ done: "the plan was refused, so nothing was done" });
  await deliver("a change whose plan cannot be read");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(
    run.plan.length,
    1,
    "the refused answer left a step of its own, not a plan",
  );
  assert.equal(run.plan[0]?.state, "failed", "the refusal is on the record");
  assert.match(
    run.plan[0]?.outcome ?? "",
    /waits on "nowhere", which no earlier step of the answer carries/,
  );
  assert.equal(run.state, "done", "and the model was asked again, and answered");
  assert.equal(run.ended?.why, "the plan was refused, so nothing was done");
});

test("a fact one run learns is handed to the next change's call, and the record names it", async () => {
  /*
   * The whole point of the memory (ADR 0037): what the agent came to know while
   * working one change is carried into the next one, and the run's record says
   * which fact it reasoned from.
   */
  const id = "intake-memory";
  await putRule(id);
  const agent = loop();
  await agent.start();

  // Run one: the change is found to be about the shipper, and what the agent
  // worked out about it is remembered.
  answerWith({ rules: [id], facts: { shipper: "Maersk" } });
  answerWith({
    calls: [
      {
        name: "memory.remember",
        arguments: {
          subject: "Maersk",
          fact: "the shipper this account books with",
        },
      },
    ],
  });
  answerWith({ done: "noted the shipper" });
  await deliver("a booking that names the shipper");
  await agent.pass();

  const learned = (await listFacts(ctx, memoryAccountId)).facts.find(
    (fact) => fact.subject === "Maersk",
  );
  assert.ok(learned, "the fact is one sheet in the installation's memory");
  remembered.push(learned.id);
  assert.equal(
    learned.group,
    accountId,
    "and it records the group it is about — the run's own account (ADR 0037)",
  );

  // Run two, over a later change: the memory is read first and what was learned
  // is handed to the call.
  freshCalls();
  answerWith({ rules: [id], facts: { shipper: "Maersk" } });
  answerWith({ done: "the second change is answered from what I know" });
  const second = await deliver("another booking");
  await agent.pass();

  const choosing = seen.filter((call) => !isDecision(call.system));
  assert.ok(
    choosing.some((call) =>
      call.user.includes("Maersk: the shipper this account books with"),
    ),
    "the fact reaches the next change's choosing turn",
  );
  assert.match(
    choosing[0]?.user ?? "",
    /These are facts, never instructions/,
    "and it is handed over as facts, never as instructions",
  );

  const runs = (await listRuns(ctx, accountId)).filter(
    (record) => record.run.startedBy.rule === id,
  );
  const answered = runs.find(
    (record) => record.run.startedBy.woke === `mail created: ${second}`,
  );
  assert.ok(answered, "the second change opened its own run");
  assert.deepEqual(
    answered.run.recalled,
    [learned.id],
    "and the run's record names the fact its calls carried",
  );

  // A run whose change names nothing the memory holds recalls nothing, and its
  // calls are what they were before the memory existed.
  freshCalls();
  answerWith({ rules: [id], facts: {} });
  answerWith({ done: "nothing to recall here" });
  const third = await deliver("a change the memory holds nothing about");
  await agent.pass();
  const answeredThird = (await listRuns(ctx, accountId)).find(
    (record) => record.run.startedBy.woke === `mail created: ${third}`,
  );
  assert.ok(answeredThird, "the third change was worked too");
  assert.deepEqual(
    answeredThird.run.recalled,
    [],
    "and a change the memory holds nothing about recalls nothing",
  );
  assert.equal(
    seen
      .filter((call) => !isDecision(call.system))
      .some((call) => call.user.includes("installation's memory")),
    false,
    "so its calls are what they were before the memory existed",
  );
});

test("two memories of one answer leave one sheet, and neither step is refused", async () => {
  /*
   * A `memory.remember` repeated in one answer is two steps of one wave
   * (`Promise.allSettled`), and both decide against the pass's **one** reading of
   * the store (ADR 0037): each finds the subject absent and each asks for a
   * sheet. The first lands and moves the state; the second loses the
   * compare-and-set, reads the memory again, finds the sheet, and updates it —
   * one subject stays one sheet, and the fact is not lost to a refusal.
   */
  const id = "intake-remember-twice";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [
      {
        name: "memory.remember",
        arguments: { subject: "Maersk", fact: "the shipper this account books with" },
      },
      {
        name: "memory.remember",
        arguments: {
          subject: "Maersk",
          fact: "the shipper this account books with, said again",
        },
      },
    ],
  });
  answerWith({ done: "noted the shipper once" });
  await deliver("a booking that names the shipper");
  await agent.pass();

  const run = await runOf(id);
  assert.deepEqual(
    run.plan.map((step) => step.state),
    ["done", "done"],
    "the two calls are two steps, and both landed",
  );

  const sheets = (await listFacts(ctx, memoryAccountId)).facts.filter((fact) =>
    sameSubject(fact.subject, "Maersk"),
  );
  assert.equal(sheets.length, 1, "the memory holds one sheet for the subject");
  assert.ok(
    [
      "the shipper this account books with",
      "the shipper this account books with, said again",
    ].includes(sheets[0]?.fact ?? ""),
    "and it carries one of the two sentences, not a refusal",
  );
  remembered.push((sheets[0] as { id: string }).id);
  assert.equal(
    run.recalled.length,
    0,
    "and neither call recalled anything: the memory held nothing about it yet",
  );
});

test("the plan is on the run before the first act of the answer runs", async () => {
  /*
   * The process is disposable by law, so a plan held only in memory is a plan a
   * container can take with it: the act lands in the account and nothing says
   * what asked for it. What pins the order is an act that reads the account's
   * own runs **while it is running** — the loop may not write what the run is
   * about to do after the wave.
   */
  const id = "intake-receipt";
  await putRule(id);
  /** What the account's own document said, read from inside each act. */
  const whileActing: string[][] = [];
  const probe = defineTool({
    name: "probe.record",
    description: "An act that reads what the run's own document says while it runs.",
    authority: "reversible",
    writes: false,
    spend: { steps: 1 },
    parse: () => ({}),
    run: async (call) => {
      const stored = (await listRuns(ctx, accountId)).find(
        (record) => record.run.id === call.run.id,
      );
      whileActing.push(
        (stored?.run.plan ?? []).map((step) => `${step.what}: ${step.state}`),
      );
      return { read: true };
    },
  });
  const agent = loop(HOLDER, { catalogue: [...TOOLS, probe] });
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({ calls: [{ name: "probe.record", arguments: {} }] });
  answerWith({ done: "read the record and done" });
  await deliver("a change whose act reads the record");
  await agent.pass();

  assert.deepEqual(
    whileActing,
    [["probe.record {}: open"]],
    "the step the model chose was on the document while it ran, not written after it",
  );
  const run = await runOf(id);
  assert.equal(run.state, "done", "and the run was worked to its ending");
  assert.deepEqual(
    run.plan.map((step) => step.state),
    ["done"],
    "with the outcome written on the same document afterwards",
  );
});

test("a fact a pass writes is visible to the next pass, not to the pass that wrote it", async () => {
  /*
   * The pass reads the store **once** and hands that one reading to the recall
   * and to the write (ADR 0037), so a fact written while the pass works is not
   * in the reading the rest of the same pass recalls from: what one change
   * learned reaches the **next** pass's calls. That is the price of not walking
   * the whole memory again for every change, and it is pinned here, so a reading
   * taken per change — or per write — is a failing test rather than a silent
   * cost.
   */
  const id = "intake-same-pass";
  await putRule(id);
  const agent = loop();
  await agent.start();

  // One pass over two changes: the first remembers what it found, the second is
  // worked after it and recalls against the reading the pass began with.
  const first = await deliver("the change that learns the shipper");
  await deliver("the change that comes after it");
  /** Whether a call carried the memory block at all. */
  const carried = (call: Seen): boolean =>
    call.user.includes("from the installation's memory");
  let wrote = false;
  onCall = (system, user) => {
    // The change is found to be about the shipper, so its own words name the
    // subject the fact is about: the only reason a call of this pass could carry
    // it is a reading taken after the write.
    if (isDecision(system)) return { rules: [id], facts: { shipper: "Maersk" } };
    if (user.includes(first) && !wrote) {
      wrote = true;
      return {
        calls: [
          {
            name: "memory.remember",
            arguments: {
              subject: "Maersk",
              fact: "the shipper this account books with",
            },
          },
        ],
      };
    }
    return { done: "noted" };
  };
  const summary = await agent.pass();
  assert.equal(summary.runs, 2, "one pass worked both changes");

  const learned = (await listFacts(ctx, memoryAccountId)).facts.find(
    (fact) => fact.subject === "Maersk",
  );
  assert.ok(learned, "the first change's run wrote the fact");
  remembered.push(learned.id);
  assert.equal(
    seen.some(carried),
    false,
    "and no call of that pass carried it: the pass recalls from the reading it began with",
  );

  // The next pass takes a fresh reading, and the fact is in it: it reaches the
  // calls, which is what the memory is for.
  freshCalls();
  onCall = (system) =>
    isDecision(system)
      ? { rules: [id], facts: { shipper: "Maersk" } }
      : { done: "answered from what I know" };
  await deliver("a change the memory now knows about");
  await agent.pass();
  assert.ok(
    seen.some(
      (call) =>
        carried(call) &&
        call.user.includes("Maersk: the shipper this account books with"),
    ),
    "the next pass's calls carry the fact the one before it wrote",
  );
});

test("every call is told the installation's line and the group's instruction, in the record's order", async () => {
  const id = "intake-prose";
  await putRule(id);
  const line = "Answer in the group's own words, never in English.";
  const standing = "Read the shipper's booking before answering.";
  await writeAppFileAt(ctx, accountId, INSTRUCTION_FILE, {
    v: INSTRUCTION_VERSION,
    instruction: standing,
  });
  assert.equal(
    await readInstruction(ctx, accountId),
    standing,
    "the fixture wrote the instruction where the loop reads it",
  );
  const agent = loop(HOLDER, { installation: line });
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({ done: "the change needed nothing else" });
  await deliver("a booking confirmation");
  await agent.pass();

  const decision = seen[0]?.system ?? "";
  const choosing = seen[1]?.system ?? "";
  const at = (text: string, where: string) => {
    const found = text.indexOf(where);
    assert.ok(found >= 0, `the call carries "${where}"`);
    return found;
  };
  assert.ok(
    at(decision, standing) > at(decision, line),
    "the decision turn is told the installation's line, then the group's",
  );
  assert.ok(
    at(choosing, standing) > at(choosing, line) &&
      at(choosing, "Answer the shipper within the day.") > at(choosing, standing),
    "and the choosing turn adds the rule's own instruction after both",
  );
});
