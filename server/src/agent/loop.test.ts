/**
 * The loop that works a run, against the mock Stalwart and a stub model
 * (ADR 0027, 0030, 0031, 0032).
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
 * - a wave asks the server for at most four calls at once;
 * - a refused answer or a refused call spends a step, so the budget is what
 *   stops a run — never a counter the record cannot show;
 * - a run says how it ended in the conversation, and a question or a stop does
 *   not repeat itself as a notice;
 * - a step that waits on an earlier one runs the branch that step's outcome
 *   names and is left unrun when no branch does, and the record says which step
 *   and which outcome left it;
 * - an answer whose plan cannot be read is refused whole, recorded, and asked
 *   again;
 * - a step that asks a person parks the run on the answer it left;
 * - **the plan is on the run before the first act of the answer runs**, and each
 *   outcome on the same document after it;
 * - a run whose wait has come due is picked up again, which is what a restart
 *   loses nothing to; a question's own deadline is one of those dates.
 * - a restart resumes from the cursor the last process left, so a change that
 *   arrived while the agent was down is still worked.
 * - a mention opens one run even when the decision names none, and a mention no
 *   rule covers is answered rather than ignored.
 * - a pass leaves what it did, and the last run it ended, in a document a person
 *   reads.
 * - a fact one run learned is handed to the next change's call, and the run's
 *   record names what it recalled — while a change the memory holds nothing
 *   about is worked exactly as it was before the memory existed;
 * - every call is told the installation's line and the group's standing
 *   instruction, in the record's order, above the rule's own;
 * - two `memory.remember` calls in one answer leave one sheet for the subject:
 *   the writes of one process are chained, so neither is a refused step.
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
const {
  filesAccountId,
  destroyAppNode,
  readAppFileAt,
  removeAppFile,
  writeAppFileAt,
  writeBytesIntoVisibleFolder,
} = await import("../appFolder.js");
const { clientOf } = await import("../util.js");
const { CAPABILITIES } = await import("../shared/capabilities.js");
const { finishRun, QUESTION_TTL_MS, startRun, spendRun, waitUntil } = await import(
  "../shared/run.js"
);
const { parseInstallationDocumentDetailed } = await import("../shared/installation.js");

import type { InstallationModel } from "../shared/installation.js";

const { modelAccess } = await import("./model.js");
const { findChatMessages, postChatMessage } = await import("../groupChat.js");
const { AGENT_LABEL } = await import("../shared/labels.js");
const { createRule, deleteRule, rulePath } = await import("./rules.js");
const { factPath, listFacts } = await import("./memory.js");
const { isGroupAccountRecord } = await import("../shared/sessionAccount.js");
const { sameSubject } = await import("../shared/memory.js");
const { createRun, listRuns, readRun, replaceRun, runPath } = await import("./runs.js");
const { INSTRUCTION_FILE, INSTRUCTION_VERSION, readInstruction } = await import(
  "./instruction.js"
);
const { takeClaim, releaseClaim } = await import("./claim.js");
const { CURSOR_FILE } = await import("./cursors.js");
const { isPassStatusDoc, PASS_STATUS_FILE } = await import("../shared/agent.js");
const { RULE_VERSION } = await import("./rule.js");
const { defineTool, TOOLS } = await import("./tools.js");
const { administratorAt, AgentLoop, RUN_STEPS_MAX } = await import("./loop.js");
const { writeAgentSwitch } = await import("./switch.js");
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

let failingCalls = 0;
const PROVIDER_PORT = await freePort();
const stub = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const raw = await readBody(req);
  const body = JSON.parse(raw) as { messages?: Array<{ content?: string }> };
  const system = body.messages?.[0]?.content ?? "";
  const user = body.messages?.[1]?.content ?? "";
  seen.push({ system, user });
  if (failingCalls > 0) {
    failingCalls -= 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "the provider failed" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  const content = onCall
    ? JSON.stringify(onCall(system, user))
    : (answers.shift() ?? "{}");
  res.end(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }),
  );
});

/** Fail the next model call as an unreachable provider would. */
function failNextModelCall(): void {
  failingCalls += 1;
}

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
 * The account the loop works: a **group** of the Master's session, with a
 * mailbox.
 *
 * The installation's memory lives in the Master's **own** account (ADR 0033)
 * and the runs and rules of a worked change live in the group's, and the two are
 * never one account — a group is a shared account (`isPersonal: false`) while
 * the Master's own is personal, which is what the classifier reads. The pass
 * reads the memory once and writes a fact against that reading's token, so a
 * fixture that made one account hold both would have the run documents it writes
 * invalidate the memory's token before the fact is written.
 *
 * A candidate whose `Mailbox/get` answers no tree is not a group the product
 * would work — the folder share is listed as a non-personal account too — so the
 * harness asks the server the same question the classifier does before it picks
 * one.
 */
let accountId: string;
/** The Master's own account: the installation's memory lives here (ADR 0033). */
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
  /*
   * The candidate the pass will actually work: the session lists a folder share
   * as a non-personal account too, and the product's own classifier asks the
   * server for a mailbox tree before it calls one a group
   * (`groupAccountsDetailed` → `probeMailStore`). A harness that skipped that
   * question worked an account with no mail — where a delivered message was
   * stored nowhere and could not be read back.
   */
  let group = "";
  for (const id of groups) {
    const boxes = await clientOf(ctx)
      .call<{ list?: unknown[] }>(
        "Mailbox/get",
        { accountId: id, ids: null, properties: ["id", "role"] },
        [CAPABILITIES.mail],
      )
      .catch(() => ({ list: [] }));
    if ((boxes.list ?? []).length) {
      group = id;
      break;
    }
  }
  assert.ok(group, "the Master's session holds a group mailbox to work");
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
  /*
   * Each test is a process meeting an account it has not read: the cursor is a
   * document now (ADR 0037), so the one a previous test wrote is taken out
   * before this one's first pass — otherwise this test reads the last test's
   * changes instead of its own.
   */
  const cursor = await readAppFileAt(ctx, accountId, CURSOR_FILE);
  if (typeof cursor?.file.id === "string")
    await destroyAppNode(ctx, accountId, cursor.file.id, {});
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

/** A surface list a test asks a rule to watch. */
type WatchList = Array<keyof RuleDoc["surfaces"]>;

/** A rule this build writes, watching one surface, removed with its test. */
async function putRule(id: string, watches: WatchList = ["mail"]): Promise<void> {
  await createRule(ctx, accountId, rule(id, watches));
  written.push(id);
}

/** A rule this build writes, watching the surfaces named and on demand elsewhere. */
function rule(id: string, watches: WatchList = ["mail"]): RuleDoc {
  const surfaces: RuleDoc["surfaces"] = {
    chat: "watch",
    mail: "ondemand",
    files: "ondemand",
    knowledge: "ondemand",
    workorder: "ondemand",
    calendar: "ondemand",
  };
  for (const surface of watches) surfaces[surface] = "watch";
  surfaces.chat = "watch";
  return {
    v: RULE_VERSION,
    id,
    surfaces,
    instruction: "Answer the shipper within the day.",
    sends: false,
  };
}

/** The inbox id of an account, read from the server: mailbox ids are its own. */
async function inboxOf(account: string): Promise<string> {
  const boxes = await clientOf(ctx).call<{
    list?: Array<{ id?: string; role?: string }>;
  }>("Mailbox/get", { accountId: account, ids: null, properties: ["id", "role"] }, [
    CAPABILITIES.mail,
  ]);
  const inbox = (boxes.list ?? []).find((box) => box.role === "inbox")?.id;
  assert.ok(inbox, `the account ${account} has an inbox`);
  return inbox;
}

async function deliver(subject: string, into = accountId, body = ""): Promise<string> {
  const inbox = await inboxOf(into);
  const answer = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId: into,
      create: {
        c: {
          subject,
          mailboxIds: { [inbox]: true },
          // A message with words of its own, for the turns that are told them.
          ...(body
            ? {
                bodyValues: { "1": { value: body } },
                bodyStructure: { partId: "1", type: "text/plain" },
              }
            : {}),
        },
      },
    },
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
  const spentRun = await runOf(id);
  assert.ok(
    (spentRun.spent.promptTokens ?? 0) > 0 && (spentRun.spent.completionTokens ?? 0) > 0,
    "the provider's token counts are on the run's tally",
  );

  const run = await runOf(id);
  assert.equal(
    run.startedBy.woke,
    `mail created: ${message}`,
    "the run says which change woke the rule",
  );
  assert.equal(
    run.startedBy.surfaces?.mail,
    "watch",
    "and carries the matrix the rule had at that instant (ADR 0031)",
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

/**
 * The calendar is a surface like any other (ADR 0031): an event written in the
 * group's account wakes a rule that watches it, and the run it opens names the
 * event by the id `calendar.read` takes.
 */
test("a calendar event written in the group's account wakes a rule that watches it", async () => {
  const id = "intake-calendar";
  await putRule(id, ["calendar"]);
  const agent = loop();
  await agent.start();

  const created = await clientOf(ctx).call<{ created?: { e?: { id?: string } } }>(
    "CalendarEvent/set",
    {
      accountId,
      create: {
        e: {
          "@type": "Event",
          start: "2026-10-22T09:00:00",
          timeZone: "Europe/Rome",
          duration: "PT1H",
          title: "Container 12 arrives",
        },
      },
    },
    [CAPABILITIES.calendars],
  );
  const event = created.created?.e?.id;
  assert.ok(event, "the event is in the account's calendar");

  answerWith({ rules: [id], facts: { event } });
  answerWith({ done: "noted" });
  const summary = await agent.pass();

  assert.equal(summary.runs, 1, "the event is a change the rule answers");
  const run = await runOf(id);
  assert.equal(
    run.startedBy.woke,
    `calendar created: ${event}`,
    "and the run says which event woke it, by the id calendar.read takes",
  );
  assert.equal(run.state, "done");
});

/**
 * A mail change is decided by one call over what the process already holds.
 *
 * The words of the message are read before the turn (`changes.ts`), so the turn
 * that decides a mail does not spend a lookup — a whole model call — on the same
 * message: it is told them, fenced as data.
 */
test("a mail change is read before the decision turn, so the turn spends no lookup on it", async () => {
  const id = "intake-mail-words";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({ done: "the words are known" });
  await deliver("a booking confirmation", accountId, "the booking reference is BK-42");
  await agent.pass();

  const decisions = seen.filter((one) => isDecision(one.system));
  assert.equal(decisions.length, 1, "one decision turn, and no lookup round before it");
  assert.match(
    decisions[0]?.user ?? "",
    /The message itself, so it need not be looked up again:/,
    "the turn is told the message it decides",
  );
  assert.match(decisions[0]?.user ?? "", /BK-42/, "with the sender's own words");
  assert.ok(
    !(decisions[0]?.user ?? "").includes("What mail.read answered"),
    "and spends no lookup on it",
  );
});

test("a drop of files is one run and one report, after the folder is quiet", async () => {
  /*
   * The live failure this pins: a mail's attachments saved into one folder
   * became seven file events, seven runs and thirteen chat messages in a
   * morning, one per file. A file landing is one file of a drop, and the drop
   * is answered once, when the folder has stopped receiving.
   */
  const id = "intake-files";
  await putRule(id, ["files"]);
  const agent = loop();
  await agent.start();
  const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 20, 8, minutes, 0));
  const folder = "MS2/279726936";
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    folder,
    "DOC201026.pdf",
    new TextEncoder().encode("weighbridge"),
    "application/pdf",
  );
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    folder,
    "WhatsApp 09.31.57.jpeg",
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    "application/octet-stream",
  );

  const quiet = await agent.pass(at(0));
  assert.equal(quiet.runs, 0, "a file landing is a drop still being written");
  assert.equal(seen.length, 0, "and it costs no model call at all");

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [{ name: "chat.say", arguments: { text: "one drop, two files" } }],
  });
  answerWith({ done: "reported" });
  const reported = await agent.pass(at(6));
  assert.equal(reported.runs, 1, "the drop is one run, not one per file");
  const run = await runOf(id);
  assert.match(
    run.startedBy.woke ?? "",
    /\(2 files, /,
    "and the run says the drop it answers and how big it was",
  );
  const said = await findChatMessages(ctx, accountId, "one drop", 10);
  assert.equal(said.length, 1, "one report for the drop");
  assert.match(
    seen[1]?.user ?? "",
    /DOC201026\.pdf/,
    "the run is told the files the drop brought, not only the folder",
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

test("no mark on a message is activity a rule answers, its own or a person's", async (t) => {
  /*
   * A run files a message and marks it G-processed, and the server reports those
   * writes as changes of that same message. A change of a message is not an
   * event — only an arrival is (ADR 0031) — so the next pass opens no second run
   * over the mail the run has just handled, and a person's later mark wakes
   * nothing either: one message, one answer.
   *
   * The account this file's other tests work is the shared mailbox the mock
   * keeps empty of mail, so this one works the demo's group (`a3`): a message
   * there can be marked for real, and the mark is what the server reports.
   */
  const group = "a3";
  const id = "intake-own-write";
  await createRule(ctx, group, rule(id));
  t.after(async () => {
    const found = await readAppFileAt(ctx, group, rulePath(id));
    if (typeof found?.file.id === "string")
      await destroyAppNode(ctx, group, found.file.id, {});
  });
  const agent = new AgentLoop(ctx, {
    holder: HOLDER,
    accounts: async () => [group],
    access: { model, allowPrivateProvider: true },
  });
  await agent.start();

  const message = await deliver("a booking confirmation", group);
  let turn = 0;
  onCall = (system) => {
    if (isDecision(system)) return { rules: [id], facts: {} };
    turn += 1;
    return turn === 1
      ? {
          calls: [
            {
              name: "mail.keyword",
              arguments: { id: message, keyword: AGENT_LABEL.processed, on: true },
            },
          ],
        }
      : { done: "filed and marked" };
  };
  const first = await agent.pass();
  assert.equal(first.runs, 1, "the arrival opens one run");
  const run = (await listRuns(ctx, group)).find(
    (record) => record.run.startedBy.rule === id,
  );
  assert.equal(run?.run.plan[0]?.state, "done", "the agent marked the message");

  const second = await agent.pass();
  assert.equal(second.runs, 0, "the agent's own mark wakes no rule");
  const runs = (await listRuns(ctx, group)).filter(
    (record) => record.run.startedBy.rule === id,
  );
  assert.equal(runs.length, 1, "one message, one run");

  // A person's later mark on the same message is a change of that message, not
  // an arrival: reading, marking and filing wake no rule at all (ADR 0031).
  await clientOf(ctx).call(
    "Email/set",
    { accountId: group, update: { [message]: { "keywords/$flagged": true } } },
    [CAPABILITIES.mail],
  );
  const third = await agent.pass();
  assert.equal(third.runs, 0, "a person's mark on it wakes nothing either");
});

test("a wave asks the server for at most four calls at once", async () => {
  /*
   * A live answer listed the same folder thirteen times and the thirteen calls
   * went to Stalwart together; it answered `400` — "The request exceeds the
   * maximum number of concurrent requests" — and the run paid a failed step for
   * each. The wave is a burst of independent calls, so it is bounded here, and
   * every step still runs.
   */
  const id = "intake-wave";
  await putRule(id);
  let inFlight = 0;
  let peak = 0;
  const slow = defineTool<{ path: string }>({
    name: "files.list",
    description: "A listing slow enough to see how many of them run together.",
    authority: "reversible",
    writes: false,
    surface: "files",
    spend: { steps: 1 },
    keys: ["path"],
    args: { path: { type: "text" } },
    parse: (raw: unknown) => raw as { path: string },
    run: async (_call, args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { path: args.path };
    },
  });
  const agent = loop(HOLDER, { catalogue: [...TOOLS, slow] });
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: Array.from({ length: 9 }, (_, at) => ({
      name: "files.list",
      arguments: { path: `MS2/${at}` },
    })),
  });
  answerWith({ done: "nine listings, and never more than four at once" });
  await deliver("nine folders to list");
  await agent.pass();

  assert.equal(peak, 4, "the wave is bounded, and the bound is the server's ceiling");
  const run = await runOf(id);
  assert.equal(run.state, "done");
  assert.equal(
    run.plan.filter((step) => step.state === "done").length,
    9,
    "and bounding the burst did not lose a step of the answer",
  );
});

test("a run says how it ended, unless the ending is already words between them", async () => {
  /*
   * The live run that closed this: a person's chat message was worked, its files
   * landed, and the run ended `out-of-budget` before it wrote a line — the
   * person saw nothing and the queue looked stuck (ADR 0030). Every ending
   * speaks; a question and a stop are already words, and a background run that
   * finished keeps its record.
   */
  const id = "intake-says";
  await putRule(id, ["chat", "mail"]);
  const agent = loop();
  await agent.start();

  // A person asks in the conversation and the run finishes: the ending is a
  // message in that conversation, in the thread they wrote in.
  const asked = await postChatMessage(
    ctx,
    accountId,
    "sam@example.org",
    "@gilbert file the booking, please",
  );
  onCall = (system) =>
    isDecision(system) ? { rules: [id], facts: {} } : { done: "the booking is filed" };
  await agent.pass();
  const said = await findChatMessages(ctx, accountId, "Done: the booking is filed", 5);
  assert.equal(said.length, 1, "the ending is said once, where the person wrote");
  assert.equal(said[0]?.replyTo, asked, "and it answers the message that woke the run");

  // A background run that finished says nothing: nobody asked it in the
  // conversation, and the record is where its ending is read.
  onCall = (system) =>
    isDecision(system) ? { rules: [id], facts: {} } : { done: "a background ending" };
  await deliver("a booking confirmation");
  await agent.pass();
  assert.equal(
    (await findChatMessages(ctx, accountId, "Done: a background ending", 5)).length,
    0,
    "a run woken by mail keeps its ending on the record",
  );

  // A run that could not finish speaks whatever woke it: a failure is news.
  onCall = null;
  answerWith({ rules: [id], facts: {} });
  answerWith({ calls: [{ name: "mail.folders", arguments: {} }] });
  answerWith({ calls: [{ name: "mail.folders", arguments: {} }] });
  await deliver("a message the agent stalls on");
  await agent.pass();
  const failed = await findChatMessages(ctx, accountId, "I could not finish this one", 5);
  assert.equal(failed.length, 1, "the failure is said, once");
  assert.match(failed[0]?.text ?? "", /the same calls twice/, "and it says why");
});

test("a restart resumes from the cursor the last process left", async () => {
  /*
   * A cursor held only in memory made a restart a fresh start: the process
   * anchored at the state the server held then, and a change that arrived while
   * it was down was never read and never named. A live chat message mentioned
   * the agent, produced no run, and nothing could say why. The second loop here
   * is that restart (ADR 0037).
   */
  const id = "intake-restart";
  await putRule(id);
  const first = loop(HOLDER);
  await first.start();
  assert.ok(
    (await readAppFileAt(ctx, accountId, CURSOR_FILE))?.file.id,
    "the first pass leaves the reading in the account",
  );

  const message = await deliver("a message that arrived while the agent was down");

  // A new process: no cursor in memory, so the document is its only memory.
  const second = loop(HOLDER);
  answerWith({ rules: [id], facts: {} });
  answerWith({ done: "worked the message that waited" });
  await second.start();

  const run = await runOf(id);
  assert.equal(
    run.startedBy.woke,
    `mail created: ${message}`,
    "the change that arrived while the process was down is worked after it restarts",
  );
  assert.equal(run.state, "done");
});

test("a mention opens one run even when the decision names no rule", async () => {
  /*
   * A person addressing the agent in the conversation is answered even when the
   * decision turn names no rule: the mention is the address, and the rule it
   * reaches is the first that watches the conversation — **one address is one
   * answer**, so a group with two chat rules does not answer the same sentence
   * twice. The live ending it replaces was a mention that opened no run and said
   * nothing.
   */
  const id = "intake-mentioned";
  const beside = "intake-mentioned-beside";
  await putRule(id, ["chat"]);
  await putRule(beside, ["chat"]);
  const agent = loop();
  await agent.start();

  onCall = (system) =>
    isDecision(system) ? { rules: [], facts: {} } : { done: "answered the mention" };
  await postChatMessage(
    ctx,
    accountId,
    "sam@example.org",
    "@gilbert what is the status?",
  );
  await agent.pass();

  const run = await runOf(id);
  assert.match(
    run.startedBy.woke ?? "",
    /^chat created: /,
    "the message is what woke it",
  );
  assert.equal(run.state, "done", "and the rule that watches the conversation worked it");
  assert.equal(
    (await listRuns(ctx, accountId)).filter(
      (record) => record.run.startedBy.rule === beside,
    ).length,
    0,
    "the second chat rule is not woken by the same sentence",
  );
  assert.equal(
    (await findChatMessages(ctx, accountId, "Done: answered the mention", 5)).length,
    1,
    "and the person hears the ending",
  );
});

test("a mention no rule covers is answered rather than left in silence", async () => {
  /*
   * A group whose rules say nothing about the conversation has no agent there —
   * but the person still addressed it, and silence is not an answer to a question
   * somebody typed.
   */
  const agent = loop();
  await agent.start();
  await postChatMessage(ctx, accountId, "sam@example.org", "@gilbert anybody there?");
  await agent.pass();

  const said = await findChatMessages(ctx, accountId, "no rule for the conversation", 5);
  assert.equal(said.length, 1, "the person is told why nothing happened");
  assert.ok(said[0]?.replyTo, "in the thread they wrote in");
});

test("a run that already answered in the conversation does not repeat its ending", async () => {
  /*
   * A run whose own report is on the conversation has been heard: saying the
   * ending beside it would be two messages for one piece of work. What a `done`
   * run must say is said when it said nothing.
   */
  const id = "intake-spoke";
  await putRule(id, ["chat"]);
  const agent = loop();
  await agent.start();

  onCall = (system) => {
    if (isDecision(system)) return { rules: [id], facts: {} };
    const turns = seen.filter((call) => !isDecision(call.system)).length;
    return turns < 2
      ? { calls: [{ name: "chat.say", arguments: { text: "the files are filed" } }] }
      : { done: "all filed" };
  };
  await postChatMessage(ctx, accountId, "sam@example.org", "@gilbert file them");
  await agent.pass();

  assert.equal(
    (await findChatMessages(ctx, accountId, "the files are filed", 5)).length,
    1,
    "the run's own report is the word",
  );
  assert.equal(
    (await findChatMessages(ctx, accountId, "Done: all filed", 5)).length,
    0,
    "and the ending is not said a second time",
  );
});

test("every rule that fits one change opens its own run", async () => {
  // Two rules a group wrote over the same surface. Both are its decision, so
  // neither is set aside for the other: the change is put to the decision turn
  // once, and every rule it names gets a run of its own (ADR 0031).
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

test("a stopped run is not proposed again for the same change", async () => {
  /*
   * Stopping a run marks it `cancelled` (POST /groups/:name/runs/:id/stop), and
   * the account's record is what says the change has been answered: a run whose
   * `startedBy` names this rule and this change, **whatever state it ended in**.
   * A stopped run therefore closes that change for the rule — a later pass that
   * re-reads an unfinished batch does not open a fresh one beside it.
   */
  const id = "intake-stopped";
  await putRule(id);
  const agent = loop();
  await agent.start();

  const message = await deliver("a booking confirmation");
  await createRun(
    ctx,
    accountId,
    finishRun(
      startRun({
        id: "stopped-by-a-person",
        startedBy: { rule: id, instruction: null, woke: `mail created: ${message}` },
      }),
      "cancelled",
      { at: new Date().toISOString(), why: "a person stopped it" },
    ),
  );

  onCall = (system) => (isDecision(system) ? { rules: [id], facts: {} } : { done: "no" });
  const summary = await agent.pass();

  assert.equal(summary.runs, 0, "no run is opened for a change whose run was stopped");
  const runs = (await listRuns(ctx, accountId)).filter(
    (record) => record.run.startedBy.rule === id,
  );
  assert.equal(runs.length, 1, "the stopped run is the answer the change already has");
  assert.equal(runs[0]?.run.state, "cancelled", "and it stays stopped");
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
    keys: ["id"],
    args: { id: { type: "text" } },
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
  assert.ok(run.waiting?.until, "carrying the deadline the question was given");
  assert.equal(run.waiting?.asked.channel, "chat", "and where it asked");
  assert.ok(run.waiting?.asked.id, "with the sentence's own id");
  assert.equal(run.plan[0]?.state, "done", "the question was delivered");
});

test("a person's answer continues the run that asked for it", async () => {
  /*
   * A run parked on a person is picked up by the answer, because the answer is
   * what it waits for — and it arrives in the chat as a message of its own,
   * which the change log reports at a path of its own, so nothing about the
   * change names the run. What ties the two together is the question: the
   * message replies to the sentence the run recorded as its wait, and somebody
   * other than the agent wrote it (ADR 0029, 0030). The deadline the question
   * carries is an alarm for a question nobody answers, never the thing that
   * picks it up.
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

  /*
   * An answer is correlated by the record, not decided: the run it continues is
   * found from the message it replies to, so no decision call is made. What the
   * answer authorises is read before the run goes on (ADR 0028): the sentence
   * only says which booking it is, so it authorises no act.
   */
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
   * (ADR 0029). The decision turn may name more than one rule for the message —
   * two rules watching chat both fit a reply — and working the same answer once
   * per rule, from the document as it stood before the first working, rewrites
   * the steps the first one recorded. The record is the product (ADR 0030), so
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

  answerWith({ authorisations: [] });
  answerWith({ done: "it is BK-1" });
  const reply = await postChatMessage(ctx, accountId, "sam@example.org", "it is BK-1", {
    replyTo: asked,
  });
  const summary = await agent.pass();

  assert.equal(summary.runs, 0, "the answer opened no run of its own");
  assert.equal(summary.due, 1, "and the run it answered was worked once");
  assert.ok(
    seen.every((call) => !isDecision(call.system)),
    "an answer is correlated by the record, so it costs no decision call",
  );
  const answered = (await readRun(ctx, accountId, "parked-once"))?.run;
  assert.equal(answered?.state, "done", "to its ending");
  assert.equal(
    answered?.plan.filter((step) => step.what === `the answer in chat ${reply}`).length,
    1,
    "and the answer is on the record once, not once per rule the decision named",
  );
});

test("an answer is worked even when no rule watches the surface it arrives on", async () => {
  /*
   * The question and the answer need not be on the same surface a rule watches.
   * A rule that watches mail can ask in chat, and the person answers where they
   * were asked. Correlating that answer is the record's job, not a rule's: if the
   * "no rule watches this" shortcut runs first, the run stays parked for ever.
   */
  const id = "answer-from-mail-rule";
  const asked = await postChatMessage(
    ctx,
    accountId,
    ctx.username,
    "is the booking confirmed?",
  );
  await createRun(
    ctx,
    accountId,
    finishRun(
      waitUntil(
        startRun({
          id: "parked-on-another-surface",
          startedBy: {
            rule: id,
            instruction: null,
            woke: "mail created: m-9",
          },
        }),
        {
          what: "is the booking confirmed?",
          asked: { channel: "chat", id: asked },
          until: null,
        },
      ),
      "blocked",
      { at: new Date().toISOString(), why: "waiting on a person" },
    ),
  );
  // The rule watches mail only: the chat answer is a surface it does not cover.
  await putRule(id, ["mail"]);
  const agent = loop();
  await agent.start();

  answerWith({ authorisations: [] });
  answerWith({ done: "confirmed" });
  await postChatMessage(ctx, accountId, "sam@example.org", "yes, confirmed", {
    replyTo: asked,
  });
  const summary = await agent.pass();

  assert.equal(summary.due, 1, "the answer picks the run up");
  const answered = (await readRun(ctx, accountId, "parked-on-another-surface"))?.run;
  assert.equal(answered?.state, "done");
  assert.ok(
    seen.every((call) => !isDecision(call.system)),
    "and it is correlated by the record, with no decision call",
  );
});

test("the agent's own chat message opens no run and costs no model call", async () => {
  const id = "own-message";
  await putRule(id, ["chat"]);
  const agent = loop();
  await agent.start();

  // The agent says something, as itself; the change log reports it like any other
  // chat message, and the loop must not read it as activity to answer.
  await postChatMessage(ctx, accountId, ctx.username, "working on it");
  const summary = await agent.pass();

  assert.equal(summary.runs, 0, "no run is opened over the agent's own words");
  assert.equal(seen.length, 0, "and no model call is paid to read them");
});

test("a chat message that answers nothing can be answered by the fast path", async () => {
  const id = "fast-reply";
  await putRule(id, ["chat"]);
  const agent = loop();
  await agent.start();

  answerWith({ reply: "Acknowledged, @sam — no harm done." });
  await postChatMessage(ctx, accountId, "sam@example.org", "no harm done");
  const summary = await agent.pass();

  assert.equal(summary.runs, 0, "the reply opens no run");
  const said = await findChatMessages(ctx, accountId, "Acknowledged", 5);
  assert.equal(said[0]?.text, "Acknowledged, @sam — no harm done.");
  assert.equal(seen.filter((call) => isDecision(call.system)).length, 1);
});

test("a run stopped while the agent works it is not overwritten, and no step follows", async () => {
  /*
   * The fourth ending is the person's (ADR 0030): the document they stopped is
   * left exactly as they put it. A step that was already in flight may have
   * landed before the stop; what must not happen is the agent writing its plan
   * over the ending and planning on from a run that is no longer its own.
   */
  const stopTool = defineTool<Record<string, never>>({
    name: "test.stop",
    description: "stop the run it is a step of, as a member of the group would",
    authority: "reversible",
    writes: true,
    spend: { steps: 1 },
    keys: [],
    args: {},
    parse: () => ({}),
    run: async ({ ctx: toolCtx, accountId: account, run }) => {
      const held = await readRun(toolCtx, account, run.id);
      if (!held) return "nothing to stop";
      await replaceRun(
        toolCtx,
        account,
        finishRun(held.run, "cancelled", {
          at: new Date().toISOString(),
          why: "stopped by a member of the group",
        }),
        { ifInState: held.state },
      );
      return "stopped by a member";
    },
  });
  const id = "stopped-mid-run";
  await putRule(id, ["chat"]);
  const agent = loop(HOLDER, { catalogue: [...TOOLS, stopTool] });
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [{ name: "test.stop", arguments: {} }],
  });
  await postChatMessage(ctx, accountId, "sam@example.org", "carry on");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(run.state, "cancelled", "the stop is the document that stays");
  assert.equal(run.ended?.why, "stopped by a member of the group");
  assert.equal(
    run.plan.at(-1)?.state,
    "open",
    "and the step the agent was in the middle of is not written as worked",
  );
  assert.equal(
    seen.filter((call) => isDecision(call.system)).length,
    1,
    "the agent did not go on planning after the stop",
  );
});

test("a person's answer is the word an outward act asks for, recorded for that act", async () => {
  /*
   * The path ADR 0028 leaves open (owner decision 2026-10-18): the sentence that
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
     in the catalogue (ADR 0029), and what is under test is the word and the guard. */
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
    keys: ["to", "text"],
    args: { to: { type: "text" }, text: { type: "text" } },
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

test("an account whose rules cannot be read is a gap, and the others are still worked", async () => {
  /*
   * One group's rule sheet is a document this build cannot parse. The pass must
   * not die on it: that group is left alone for this pass with the reason in the
   * gaps, the account after it is worked as usual, and the timers are armed —
   * a pass that threw here would throw every ten seconds for ever and take every
   * group with it.
   */
  let mailAccount = "";
  for (const id of Object.keys(ctx.session.accounts)) {
    // Another account than the one this harness works: the test needs two.
    if (id === accountId) continue;
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
  const id = "intake-after-a-broken-rule";
  try {
    await putRule(id);
    const agent = loop(HOLDER, { accounts: async () => [mailAccount, accountId] });
    /*
     * The first pass anchors the accounts' cursors. The broken rule is written
     * **after** that, so it is a change the next pass must answer — a quiet
     * account pays no rule listing (changes.ts), and an account with nothing to
     * apply rules to never reads them.
     */
    await agent.start();
    await writeAppFileAt(ctx, mailAccount, rulePath("broken"), { v: RULE_VERSION - 1 });

    answerWith({ rules: [id], facts: {} });
    answerWith({ done: "filed despite the other group's bad rule" });
    await deliver("a booking confirmation");
    /*
     * The account with the broken rule is worked too: a quiet account pays no
     * rule listing, and a folder that appears is not activity, so a document
     * only under gilbert/rules/ does not reach it. A message does, and the
     * broken rule is the gap that must not take the other account with it.
     */
    await deliver("a second confirmation", mailAccount);
    const summary = await agent.pass();

    assert.equal(summary.claimed, true, "the pass holds the installation's claim");
    assert.ok(
      summary.gaps.some(
        (gap) => gap.startsWith(`${mailAccount}:`) && gap.includes("not readable"),
      ),
      "the unreadable rule is the pass's gap, named by its account",
    );
    assert.equal(summary.runs, 1, "and the other account is still worked");
    assert.ok(await runOf(id), "its run answers the change");
  } finally {
    const broken = await readAppFileAt(ctx, mailAccount, rulePath("broken"));
    if (typeof broken?.file.id === "string")
      await destroyAppNode(ctx, mailAccount, broken.file.id, {});
  }
});

test("a question asked by mail parks the run, and a reply on its thread continues it", async () => {
  /*
   * The conversation's other half (ADR 0029). The question leaves from the group's
   * own identity to a principal with access, the run waits with no date, and the
   * answer is the message whose thread names the question — mail's own
   * correlation, and the same bound as chat: the sender is never the group itself.
   *
   * The account is the group the harness works: it carries a mailbox of its own
   * and a directory entry, which are the two things the question needs.
   */
  const mailAccount = accountId;
  const mailInbox = await inboxOf(mailAccount);
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
        c: { subject: "a booking needing an answer", mailboxIds: { [mailInbox]: true } },
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
          mailboxIds: { [mailInbox]: true },
          bodyStructure: { partId: "text", type: "text/plain" },
          bodyValues: { text: { value: "it is BK-2" } },
          // A message created here stands in for a delivered one, and the
          // reading takes an answer only on the server's record of the
          // submission: the account that authenticated is the sender (ADR 0029).
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

test("a question whose deadline has come sends the run on without the answer", async () => {
  /*
   * A run parked on a person is due when its question's deadline arrives — the
   * wait's own date (ADR 0029, 0030) — and the work goes on with a step that says
   * what did not come, instead of waiting for ever.
   */
  const asked = new Date(Date.now() - QUESTION_TTL_MS - 60_000);
  const deadline = new Date(asked.getTime() + QUESTION_TTL_MS).toISOString();
  await createRun(
    ctx,
    accountId,
    finishRun(
      waitUntil(
        startRun({
          id: "overdue-question",
          startedBy: {
            rule: "overdue",
            instruction: null,
            woke: "a question nobody answered",
          },
        }),
        {
          what: "shall I delete the duplicate?",
          asked: { channel: "chat", id: "fjt" },
          until: deadline,
        },
      ),
      "blocked",
      { at: asked.toISOString(), why: "waiting on a person: a duplicate" },
    ),
  );

  const agent = loop();
  answerWith({
    calls: [
      {
        name: "chat.say",
        arguments: { text: "nothing was deleted; the file is as it was" },
      },
    ],
  });
  answerWith({ done: "carried on without the answer" });
  const summary = await agent.pass(new Date(Date.parse(deadline) + 60_000));

  assert.equal(summary.due, 1, "the overdue question is due");
  const record = await readRun(ctx, accountId, "overdue-question");
  assert.equal(record?.run.state, "done", "and the run went on to its ending");
  assert.equal(record?.run.waiting, null, "the question is no longer waited on");
  assert.ok(
    record?.run.plan.some((step) =>
      /nobody answered it within the deadline/.test(step.outcome),
    ),
    "the record says the answer never came",
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
    keys: [],
    args: {},
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

test("a run whose document disappears is not written back by the closing step", async () => {
  /*
   * The store no longer recreates a document it cannot read: a run archived or
   * removed under a working pass stays gone, rather than coming back as a
   * second copy at the working path with the rest of its plan behind it.
   */
  const id = "vanishing-run";
  await putRule(id);
  const vanish = defineTool({
    name: "probe.vanish",
    description: "Remove this run's own document.",
    authority: "reversible",
    writes: true,
    spend: { steps: 1 },
    keys: [],
    args: {},
    parse: (raw: unknown) => raw as Record<string, never>,
    run: async (call) => {
      await removeAppFile(ctx, accountId, runPath(call.run.id));
      return { removed: true };
    },
  });
  const agent = loop(HOLDER, { catalogue: [...TOOLS, vanish] });
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({ calls: [{ name: "probe.vanish", arguments: {} }] });
  await deliver("a run that loses its own document");
  await agent.pass();

  assert.equal(
    await readRun(ctx, accountId, id),
    null,
    "the removed document is not put back by the step that closes the plan",
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
    keys: ["id"],
    args: { id: { type: "text" } },
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
   * The model writes the order and the conditions (ADR 0030): the later steps of
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
    keys: ["id"],
    args: { id: { type: "text" } },
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
    keys: ["id"],
    args: { id: { type: "text" } },
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

test("a malformed answer costs a step and is asked again, not the run", async () => {
  /*
   * A model stuck on one malformed answer repeats it, and every repeat is a
   * model call and a step that ended refused — so the run stops on the budget it
   * declares, not on a counter invisible in the record. A live run died after
   * three all-refused rounds with its budget untouched; the person heard nothing,
   * which is the ending this replaced.
   */
  const id = "intake-stuck-model";
  await putRule(id);
  const agent = loop();
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  const stuck = {
    calls: [
      {
        name: "chat.say",
        arguments: { text: "the same malformed answer" },
        needs: { step: "nowhere", when: "done" },
      },
    ],
  };
  answerWith(stuck);
  answerWith(stuck);
  answerWith({ done: "the model recovered and finished" });
  await deliver("a change the model fumbles twice");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(run.state, "done", "two refusals are not an ending");
  assert.equal(
    run.plan.filter((step) => step.state === "failed").length,
    2,
    "both refusals are on the record",
  );
  assert.equal(run.spent.steps, 2, "and each one spent a step of the budget");
  assert.equal(run.ended?.why, "the model recovered and finished");
});

test("a call the account refuses spends a step of the run's budget", async () => {
  /*
   * A reading tool declares no step, so a model that keeps proposing a call the
   * account refuses could grow the plan with its budget untouched — the live run
   * that appended 74 steps to a twenty-step ceiling. An attempt that ended
   * refused spends a step, so the ceiling is what stops it.
   */
  const id = "intake-refused-steps";
  await putRule(id);
  const broken = defineTool<{ n: number }>({
    name: "probe.broken",
    description: "A reading tool the account refuses every time.",
    authority: "reversible",
    writes: false,
    spend: { steps: 0 },
    keys: ["n"],
    args: { n: { type: "number" } },
    parse: (raw: unknown) => raw as { n: number },
    run: async () => {
      throw new Error("the account refused it");
    },
  });
  const agent = loop(HOLDER, { catalogue: [...TOOLS, broken] });
  await agent.start();

  let round = 0;
  onCall = (system) => {
    if (isDecision(system)) return { rules: [id], facts: {} };
    round += 1;
    return { calls: [{ name: "probe.broken", arguments: { n: round } }] };
  };
  await deliver("a change whose calls are refused");
  await agent.pass();

  const run = await runOf(id);
  assert.equal(run.state, "out-of-budget", "the ceiling ends it, not a counter");
  assert.equal(
    run.spent.steps,
    RUN_STEPS_MAX,
    "every refused attempt spent a step of the budget",
  );
  assert.match(run.ended?.why ?? "", new RegExp(`${RUN_STEPS_MAX} steps`));
  assert.ok(
    run.plan.every((step) => step.state === "failed"),
    "and every attempt is on the record as a refusal",
  );
});

test("a run left running without a wait is tried again on a minute, not every pass", async () => {
  /*
   * A run with no wait is the crash path: the document says running, nothing
   * says when to look again. The pass tries it at once, and a failure is not a
   * model call every ten seconds — the next attempt is a minute away.
   */
  const id = "stuck-run";
  const agent = loop();
  await agent.start();
  await createRun(
    ctx,
    accountId,
    startRun({
      id,
      startedBy: { rule: "stuck", instruction: null, woke: "a test change" },
    }),
  );
  const at = new Date("2026-10-19T12:00:00.000Z");
  failNextModelCall();
  const first = await agent.pass(at);
  assert.equal(first.due, 1, "the crash path is picked up on the first pass");
  assert.ok(
    first.gaps.some((gap) => gap.startsWith(`${accountId}:`)),
    "and its failure is said in the pass's gaps",
  );
  const failed = (await readRun(ctx, accountId, id))?.run;
  assert.equal(failed?.state, "running");
  assert.equal(
    failed?.spent.calls,
    1,
    "the call the provider did not answer is on the run's budget",
  );

  const second = await agent.pass(new Date(at.getTime() + 10_000));
  assert.equal(second.due, 0, "the next pass does not pay for the same failure");

  answerWith({ done: "finished after the pause" });
  const third = await agent.pass(new Date(at.getTime() + 61_000));
  assert.equal(third.due, 1, "a minute later the run is tried again");
  assert.equal((await readRun(ctx, accountId, id))?.run.state, "done");
});

test("an answer cannot run past the steps a run has left", async () => {
  /*
   * A plan is refused before any of it runs when it asks for more steps than
   * the run's remaining budget: the ceiling is not something a wave may exceed
   * and then be noticed on the next turn.
   */
  const id = "over-room";
  let ran = 0;
  const marker = defineTool({
    name: "probe.marker",
    description: "Take one step.",
    authority: "reversible",
    writes: false,
    spend: { steps: 1 },
    keys: [],
    args: {},
    parse: (raw: unknown) => raw as Record<string, never>,
    run: async () => {
      ran += 1;
      return { ok: true };
    },
  });
  const agent = loop(HOLDER, { catalogue: [...TOOLS, marker] });
  await agent.start();
  await createRun(
    ctx,
    accountId,
    spendRun(
      startRun({
        id,
        startedBy: { rule: "room", instruction: null, woke: "a test change" },
      }),
      { steps: 19 },
    ),
  );
  answerWith({
    calls: [
      { name: "probe.marker", arguments: {} },
      { name: "probe.marker", arguments: {} },
    ],
  });
  answerWith({ done: "stopped with the step it had" });
  await agent.pass();

  assert.equal(ran, 0, "no step ran beyond the ceiling");
  const held = (await readRun(ctx, accountId, id))?.run;
  assert.ok(held, "the run is still readable");
  assert.match(
    held.plan.map((step) => step.outcome).join(" "),
    /more steps than the run had left|left in the run's budget/,
    "and the refused answer is on the record",
  );
});

test("the groups are worked together, not one after another", async () => {
  /*
   * The pass hands each account its own work and lets them run at once. The
   * tool below returns `met: true` only when both groups reach it before the
   * other has finished — a sequential pass times the first one out.
   */
  let other = "";
  for (const id of Object.keys(ctx.session.accounts)) {
    if (id === accountId) continue;
    const list = await clientOf(ctx).call<{ list?: unknown[] }>(
      "Email/get",
      { accountId: id, ids: null },
      [CAPABILITIES.mail],
    );
    if ((list.list ?? []).length) {
      other = id;
      break;
    }
  }
  assert.ok(other, "the mock has a second account to work");

  const ids = ["parallel-a", "parallel-b"];
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const barrier = defineTool({
    name: "test.barrier",
    description: "Wait until the other group's run reaches the same point.",
    authority: "reversible",
    writes: false,
    spend: { steps: 1 },
    keys: [],
    args: {},
    parse: (raw: unknown) => raw as Record<string, never>,
    run: async () => {
      arrived += 1;
      if (arrived >= 2) {
        release();
        return { met: true };
      }
      const met = await Promise.race([
        both.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
      ]);
      return { met };
    },
  });
  const agent = loop(HOLDER, {
    accounts: async () => [accountId, other],
    catalogue: [...TOOLS, barrier],
  });
  await agent.start();
  for (const [index, account] of [accountId, other].entries()) {
    await createRun(
      ctx,
      account,
      startRun({
        id: ids[index]!,
        startedBy: { rule: "parallel", instruction: null, woke: "a test change" },
      }),
    );
  }
  answerWith({ calls: [{ name: "test.barrier", arguments: {} }] });
  answerWith({ calls: [{ name: "test.barrier", arguments: {} }] });
  answerWith({ done: "met" });
  answerWith({ done: "met" });
  const summary = await agent.pass();

  assert.equal(
    summary.due,
    2,
    `both accounts' runs were due in the same pass: ${JSON.stringify(summary)} other=${other}`,
  );
  for (const [index, account] of [accountId, other].entries()) {
    const run = (await readRun(ctx, account, ids[index]!))?.run;
    assert.ok(run, "each run is still in its account");
    const line = run.plan.map((step) => `${step.state}:${step.outcome}`).join(" ");
    assert.match(
      line,
      /"met":true/,
      `neither group waited for the other to finish (arrived=${arrived}, ${account}=${line})`,
    );
  }
});

test("the agent's own send is not a change a rule watching mail wakes on", async () => {
  /*
   * A send creates an Email in the group's Sent folder. Leaving it as group
   * activity would let a rule watching mail answer the agent's own reply, and
   * every answer begets another: the loop the chat's own-message skip prevents.
   */
  const id = "own-send";
  const group = "a3"; // the mock's group mailbox with its own sending identity
  await createRule(ctx, group, { ...rule(id), sends: true });
  const agent = loop(HOLDER, { accounts: async () => [group] });
  await agent.start();

  answerWith({ rules: [id], facts: {} });
  answerWith({
    calls: [
      {
        name: "mail.send",
        arguments: {
          to: "ops@shipper.example",
          subject: "re: the booking",
          text: "filed with the booking",
        },
      },
    ],
  });
  answerWith({ done: "sent the answer" });
  await clientOf(ctx).call(
    "Email/set",
    {
      accountId: group,
      create: {
        c: {
          subject: "a booking to answer",
          from: [{ email: "ops@shipper.example" }],
          to: [{ email: "team@example.org" }],
          mailboxIds: { [await inboxOf(group)]: true },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  await agent.pass();
  const afterFirst = seen.length;

  await agent.pass();
  assert.equal(seen.length, afterFirst, "the Sent message does not buy a decision call");
  await deleteRule(ctx, group, id);
});

test("the switch off answers a mention and a mail that names the agent alone, with no model call", async () => {
  /*
   * The off state is not silence: a person who writes to the agent is told it is
   * off, with no model call. Chat answers a mention; mail answers a message the
   * agent was the only addressee of — a mail also sent to somebody else is not
   * the agent's conversation (owner decision 2026-10-19).
   */
  const master = filesAccountId(ctx);
  // The mock's "a3" is the group mailbox that carries its own sending identity;
  // the notice by mail is written as the group, so the test works that account.
  const group = "a3";
  await writeAgentSwitch(ctx, master, false);
  const agent = loop(HOLDER, { accounts: async () => [group] });
  await agent.start();
  // The first pass anchors the change reading where the account stands now.
  await agent.pass();
  freshCalls();

  await postChatMessage(ctx, group, "sam@example.org", "@demo are you there?", {
    mentions: [{ kind: "principal", id: ctx.username }],
  });
  const groupInbox = await inboxOf(group);
  const deliverTo = (subject: string, cc: boolean) =>
    clientOf(ctx).call<{ created?: { m?: { id?: string } } }>(
      "Email/set",
      {
        accountId: group,
        create: {
          m: {
            subject,
            from: [{ email: "ops@shipper.example" }],
            to: [{ email: ctx.username }],
            ...(cc ? { cc: [{ email: "colleague@shipper.example" }] } : {}),
            mailboxIds: { [groupInbox]: true },
          },
        },
      },
      [CAPABILITIES.mail],
    );
  await deliverTo("is the agent on?", false);
  await deliverTo("and the colleague?", true);
  /*
   * A person writing only to the agent's address delivers into the Master's
   * own mailbox, not into a group's. The off notice has to read it there.
   */
  await clientOf(ctx).call(
    "Email/set",
    {
      accountId: master,
      create: {
        m: {
          subject: "is the agent on, at its own address?",
          from: [{ email: "ops@shipper.example" }],
          to: [{ email: ctx.username }],
          mailboxIds: { inbox: true },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  await agent.pass();

  assert.equal(seen.length, 0, "the notice is written without a model call");
  const said = await findChatMessages(ctx, group, "AI agents are turned off", 5);
  assert.equal(said.length, 1, "the chat mention is answered once");
  const sent = await clientOf(ctx).call<{ ids?: string[] }>(
    "Email/query",
    {
      accountId: group,
      filter: { subject: "AI agents are turned off" },
    },
    [CAPABILITIES.mail],
  );
  assert.equal(
    sent.ids?.length,
    1,
    "the mail naming the agent alone is answered, and the one that also reached a colleague is not",
  );
  const atMaster = await clientOf(ctx).call<{ ids?: string[] }>(
    "Email/query",
    {
      accountId: master,
      filter: { subject: "AI agents are turned off" },
    },
    [CAPABILITIES.mail],
  );
  assert.ok(
    (atMaster.ids?.length ?? 0) >= 1,
    "and the same notice reaches a mail sent to the agent's own address",
  );
  await writeAgentSwitch(ctx, master, true);
});

test("a fact one run learns is handed to the next change's call, and the record names it", async () => {
  /*
   * The whole point of the memory (ADR 0033): what the agent came to know while
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
    "and it records the group it is about — the run's own account (ADR 0033)",
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
   * A `memory.remember` repeated in one answer is two steps of one wave, and
   * both decide against the pass's **one** reading of the store (ADR 0033): each
   * finds the subject absent and each asks for a sheet. The writes of one
   * process are chained, so the first lands and moves the state and the second
   * writes against that state — one subject stays one sheet, and the fact is not
   * lost to a refusal.
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
    keys: [],
    args: {},
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
   * and to the write (ADR 0033), so a fact written while the pass works is not
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

test("a pass leaves what it did, and the last run it ended, where a person reads it", async () => {
  /*
   * A pass is not an event and writes no log line, so an installation whose agent
   * is working and one whose agent has stopped looked the same. The last pass is a
   * document (`gilbert/agent/status.json`), and the last ending is on it, so a
   * reader does not open a group's list to answer "what was its last act".
   */
  const id = "intake-status";
  await putRule(id, ["chat"]);
  const agent = loop();
  await agent.start();

  onCall = (system) =>
    isDecision(system) ? { rules: [id], facts: {} } : { done: "worked it and said so" };
  await postChatMessage(ctx, accountId, "sam@example.org", "@gilbert file the booking");
  await agent.pass();

  const found = await readAppFileAt(ctx, memoryAccountId, PASS_STATUS_FILE);
  const doc = found ? (JSON.parse(found.text) as unknown) : null;
  assert.ok(isPassStatusDoc(doc), "the last pass is a document this build reads");
  assert.equal(doc.claimed, true, "it says the pass held the installation");
  assert.ok(doc.runs >= 1, "and how many runs it opened");
  const run = await runOf(id);
  assert.equal(doc.lastEnded?.id, run.id, "the last ending names the run");
  assert.equal(doc.lastEnded?.ending, "done", "and how it ended");
  assert.equal(doc.lastEnded?.why, "worked it and said so", "with its own sentence");
});
