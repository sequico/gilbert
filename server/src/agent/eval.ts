/**
 * The eval set of ADR 0038, run against the installation's own provider.
 *
 * Not a test and not part of the gate: a measure a person runs on purpose, on
 * the mock, against a real model. `npm test` never pays for it, and a CI run
 * cannot need a provider key.
 *
 *   npx tsx src/agent/eval.ts
 *   GILBERT_EVAL_PROVIDER=/path/to/provider.json npx tsx src/agent/eval.ts
 *
 * The provider file is the installation's `agent.provider` block, unchanged:
 * `{provider, model, baseUrl, apiKey}`. **The provider is put to the product's
 * own probe** (`probeModel`, the one the administration runs when the block is
 * written) before anything is measured: a provider the product would refuse is
 * a measure of nothing, and a relaxed check here would hide exactly the failure
 * the eval exists to catch.
 *
 * The tasks are documents under `tasks/`, one file each with the message that
 * arrives, the data it arrives into and the outcome a person would accept. What
 * is printed is `pass@1` — the tasks answered whole on the **first** attempt —
 * and what the day's work cost in tokens and model calls.
 *
 * The bootstrap is here rather than imported from `loop.test.ts` because that
 * file registers its tests when it is imported: a measure cannot be a side
 * effect of a suite.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { freePort, waitForPort } from "../testkit.js";

const PROVIDER_FILE =
  process.env.GILBERT_EVAL_PROVIDER ??
  `${homedir()}/.local/state/gilbert-eval-corpus/taildrop/gilbert-provider.json`;

interface ProviderBlock {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

const provider = JSON.parse(readFileSync(PROVIDER_FILE, "utf8")) as ProviderBlock;
if (!provider.baseUrl || !provider.model || !provider.apiKey)
  throw new Error(`${PROVIDER_FILE} does not hold the installation's provider block`);

const MOCK_PORT = await freePort();
process.env.MOCK_PORT = String(MOCK_PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.APP_SECRET = "an-eval-secret-long-enough-to-seal-a-session-with";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const {
  filesAccountId,
  findFolderPath,
  readAppFileAt,
  destroyAppNode,
  readVisibleFileBytes,
  writeAppFileAt,
} = await import("../appFolder.js");
const { clientOf } = await import("../util.js");
const { CAPABILITIES } = await import("../shared/capabilities.js");
const { isGroupAccountRecord } = await import("../shared/sessionAccount.js");
const { parseInstallationDocumentDetailed } = await import("../shared/installation.js");

import type { AreaName } from "../shared/areas.js";
import type { EvalTask, Harness, RunMeasure } from "./eval/task.js";
import { refusedAndRecovered } from "./eval/task.js";

const { probeModel, requireModelAccess } = await import("./model.js");
const { postChatMessage, findChatMessages } = await import("../groupChat.js");
const { AgentLoop } = await import("./loop.js");
const { AGENT_SWITCH_FILE, writeAgentSwitch } = await import("./switch.js");
const { INSTRUCTION_FILE, INSTRUCTION_VERSION } = await import("./instruction.js");
const { CURSOR_FILE, NOTICE_CURSOR_FILE } = await import("./cursors.js");
const { PENDING_FILE } = await import("./queue.js");
const { CASES_FOLDER } = await import("./case.js");
const { listRuns, runPath } = await import("./runs.js");
const { TASKS } = await import("./eval/tasks/index.js");

const BASE = `http://127.0.0.1:${MOCK_PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

/** The installation under measure, with the provider the deployment carries. */
const parsed = parseInstallationDocumentDetailed(
  JSON.stringify({
    agent: { provider },
    secret: "an-eval-installation-secret-long-enough-to-seal-with",
  }),
);
if (!("doc" in parsed))
  throw new Error(`the installation is unreadable: ${parsed.problem}`);
/*
 * The answers this measure receives can be written down
 * (`GILBERT_EVAL_RECORD=src/agent/eval/recordings/<date>.jsonl`), and
 * `agent/replay.test.ts` reads them through today's parsers: that is the
 * regression that runs without a key (ADR 0038, *Owed*).
 */
if (process.env.GILBERT_EVAL_RECORD) {
  const { installRecording } = await import("./eval/replay.js");
  installRecording(process.env.GILBERT_EVAL_RECORD);
}
/** The product's own door to a ready model, and its refusal when there is none. */
const access = requireModelAccess(parsed.doc, false);

const probe = await probeModel(access);
if (!probe.ok) {
  console.error(`the provider is not one the product would use: ${probe.reason}`);
  (mock as { server?: { close(): void } }).server?.close();
  process.exit(1);
}
console.error(
  `provider ${probe.identity}: ${probe.structured} structured output, ` +
    `${probe.outputTokens ?? "no declared"} output tokens`,
);

await waitForPort(BASE, AUTH);
const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const memoryAccountId = filesAccountId(ctx);
if (!memoryAccountId) throw new Error("the Master's session owns no Files");

/** The groups the Master works, and the one account this measure works in. */
const groups = Object.keys(session.accounts).filter((id) =>
  isGroupAccountRecord(session.accounts[id] as { name?: unknown; isPersonal?: unknown }),
);
let accountId = "";
for (const id of groups) {
  const boxes = await clientOf(ctx)
    .call<{ list?: unknown[] }>(
      "Mailbox/get",
      { accountId: id, ids: null, properties: ["id", "role"] },
      [CAPABILITIES.mail],
    )
    .catch(() => ({ list: [] }));
  if ((boxes.list ?? []).length) {
    accountId = id;
    break;
  }
}
if (!accountId) throw new Error("the Master's session holds no group mailbox to work");

/**
 * A folder the account is expected to have, made when the mock's group account
 * does not carry it.
 *
 * A group's account always holds Drafts and Archive in Stalwart, and the mock's
 * group starts with the three it is given. A task that measures drafting must
 * find the folder a real account has, rather than measure the fixture's gap.
 */
async function ensureFolder(name: string, role?: string): Promise<void> {
  const held = (await mailboxes()).find((one) =>
    role ? one.role === role : one.name.toLowerCase() === name.toLowerCase(),
  );
  if (held) return;
  await clientOf(ctx).call(
    "Mailbox/set",
    {
      accountId,
      create: { f: { name, isSubscribed: true, ...(role ? { role } : {}) } },
    },
    [CAPABILITIES.mail],
  );
}

await ensureFolder("Drafts", "drafts");
await ensureFolder("Archive");

/**
 * A group's instruction: the prose it wrote and the areas it declared.
 *
 * The wake row follows the areas, because that is the only pairing a measure can
 * assume: a group that works mail is woken by a mail, and one that keeps only its
 * calendar is not — the second is what `mail-outside-the-area` measures.
 */
async function writeInstruction(prose: string, areas: AreaName[]): Promise<void> {
  await writeAppFileAt(ctx, accountId, INSTRUCTION_FILE, {
    v: INSTRUCTION_VERSION,
    instruction: prose,
    areas,
    surfaces: {
      chat: "watch",
      mail: areas.includes("mail") ? "watch" : "ondemand",
      files: "ondemand",
      knowledge: "ondemand",
      workorder: "ondemand",
      calendar: "ondemand",
    },
  });
}

/** Every mail folder of the account, by id and name. */
async function mailboxes(): Promise<Array<{ id: string; name: string; role: string }>> {
  const boxes = await clientOf(ctx).call<{
    list?: Array<{ id?: string; name?: string; role?: string }>;
  }>("Mailbox/get", { accountId, ids: null, properties: ["id", "name", "role"] }, [
    CAPABILITIES.mail,
  ]);
  return (boxes.list ?? []).flatMap((box) =>
    typeof box.id === "string"
      ? [{ id: box.id, name: box.name ?? "", role: box.role ?? "" }]
      : [],
  );
}

async function inboxOf(account: string): Promise<string> {
  const boxes = await clientOf(ctx).call<{
    list?: Array<{ id?: string; role?: string }>;
  }>("Mailbox/get", { accountId: account, ids: null, properties: ["id", "role"] }, [
    CAPABILITIES.mail,
  ]);
  const inbox = (boxes.list ?? []).find((box) => box.role === "inbox")?.id;
  if (!inbox) throw new Error(`the account ${account} has no inbox`);
  return inbox;
}

/** The messages this measure delivered, so the next task starts without them. */
const delivered: string[] = [];

async function deliver(subject: string, body = ""): Promise<string> {
  const inbox = await inboxOf(accountId);
  const answer = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        c: {
          subject,
          from: [{ email: "ops@shipper.example", name: "Shipper Ops" }],
          mailboxIds: { [inbox]: true },
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
  if (!id) throw new Error("the delivered message has no id");
  delivered.push(id);
  return id;
}

/** The messages one mail folder holds, as their subjects. */
async function subjectsIn(folder: string): Promise<string[]> {
  const box = (await mailboxes()).find(
    (one) => one.name.toLowerCase() === folder.toLowerCase(),
  );
  if (!box) return [];
  const found = await clientOf(ctx).call<{ ids?: string[] }>(
    "Email/query",
    { accountId, filter: { inMailbox: box.id }, limit: 50 },
    [CAPABILITIES.mail],
  );
  const ids = found.ids ?? [];
  if (!ids.length) return [];
  const held = await clientOf(ctx).call<{ list?: Array<{ subject?: string }> }>(
    "Email/get",
    { accountId, ids, properties: ["subject"] },
    [CAPABILITIES.mail],
  );
  return (held.list ?? []).flatMap((one) =>
    typeof one.subject === "string" ? [one.subject] : [],
  );
}

/** The drafts the account holds: their id, subject and the message each answers. */
async function draftRows(): Promise<
  Array<{ id: string; subject: string; inReplyTo: string[] }>
> {
  const box = (await mailboxes()).find((one) => one.role === "drafts");
  if (!box) return [];
  const found = await clientOf(ctx).call<{ ids?: string[] }>(
    "Email/query",
    { accountId, filter: { inMailbox: box.id }, limit: 50 },
    [CAPABILITIES.mail],
  );
  const ids = found.ids ?? [];
  if (!ids.length) return [];
  const held = await clientOf(ctx).call<{
    list?: Array<{ id?: string; subject?: string; inReplyTo?: string[] }>;
  }>("Email/get", { accountId, ids, properties: ["subject", "inReplyTo"] }, [
    CAPABILITIES.mail,
  ]);
  return (held.list ?? []).flatMap((one) =>
    typeof one.id === "string"
      ? [{ id: one.id, subject: one.subject ?? "", inReplyTo: one.inReplyTo ?? [] }]
      : [],
  );
}

/** The drafts the account holds: their subject and the message each answers. */
async function drafts(): Promise<Array<{ subject: string; inReplyTo: string[] }>> {
  return (await draftRows()).map(({ subject, inReplyTo }) => ({ subject, inReplyTo }));
}

/** One document of the account's Files as text, or null when it is not there. */
async function fileText(path: string): Promise<string | null> {
  const found = await readVisibleFileBytes(ctx, accountId, path);
  return found ? new TextDecoder().decode(found.bytes) : null;
}

/** The account's calendar events, by id and title. */
async function eventRows(): Promise<Array<{ id: string; title: string }>> {
  const found = await clientOf(ctx).call<{ ids?: string[] }>(
    "CalendarEvent/query",
    { accountId, limit: 50 },
    [CAPABILITIES.calendars],
  );
  const ids = found.ids ?? [];
  if (!ids.length) return [];
  const held = await clientOf(ctx).call<{
    list?: Array<{ id?: string; title?: string }>;
  }>("CalendarEvent/get", { accountId, ids, properties: ["title"] }, [
    CAPABILITIES.calendars,
  ]);
  return (held.list ?? []).flatMap((one) =>
    typeof one.id === "string" ? [{ id: one.id, title: one.title ?? "" }] : [],
  );
}

/** The account's calendar events, as the titles a task can check. */
async function events(): Promise<Array<{ title: string }>> {
  return (await eventRows()).map(({ title }) => ({ title }));
}

const harness: Harness = {
  agent: ctx.username,
  instruct: writeInstruction,
  deliver,
  post: async (from, text, replyTo) => {
    const id = await postChatMessage(ctx, accountId, from, text, { replyTo });
    if (!id) throw new Error("the mention was not posted");
    return id;
  },
  chat: (limit = 10) => findChatMessages(ctx, accountId, "", limit),
  drafts,
  subjectsIn,
  fileText,
  events,
  switchOff: () => writeAgentSwitch(ctx, memoryAccountId, false),
};

/** The events the account held before the measure: no task's clean removes one. */
const heldEvents = new Set((await eventRows()).map((event) => event.id));

/**
 * A clean account between tasks: the cursor, the runs, the instruction, the
 * switch, the drop queue, the case notes, the conversation, the mail this
 * measure delivered, the drafts an attempt wrote, and any event the account did
 * not hold when the measure started.
 *
 * Everything a task reads back is emptied, or the retry of a failed task would
 * be graded on the first attempt's leavings. A drop the previous task left in the
 * queue would wake the next pass on its own, and a case note left in `cases/`
 * would be a case the next task's turn already recognises. What the account held
 * before the measure is left alone, and so is the installation's memory: it is
 * what the installation knows, not a task's leavings.
 */
async function clean(): Promise<void> {
  for (const id of [CURSOR_FILE, NOTICE_CURSOR_FILE, INSTRUCTION_FILE, PENDING_FILE]) {
    const found = await readAppFileAt(ctx, accountId, id);
    if (typeof found?.file.id === "string")
      await destroyAppNode(ctx, accountId, found.file.id);
  }
  // The notes one case keeps, and the folder they sit in: a case the next task
  // was never given must not already be on file.
  const cases = await findFolderPath(ctx, accountId, CASES_FOLDER);
  if (cases) await destroyAppNode(ctx, accountId, cases, { removeChildren: true });
  // The switch lives in the Master's own Files, where the loop reads it.
  const held = await readAppFileAt(ctx, memoryAccountId, AGENT_SWITCH_FILE);
  if (typeof held?.file.id === "string")
    await destroyAppNode(ctx, memoryAccountId, held.file.id);
  for (const { run } of await listRuns(ctx, accountId)) {
    const found = await readAppFileAt(ctx, accountId, runPath(run.id));
    if (typeof found?.file.id === "string")
      await destroyAppNode(ctx, accountId, found.file.id);
  }
  for (const message of await findChatMessages(ctx, accountId, "", 200))
    await destroyAppNode(ctx, accountId, message.id);
  if (delivered.length) {
    await clientOf(ctx).call("Email/set", { accountId, destroy: delivered.splice(0) }, [
      CAPABILITIES.mail,
    ]);
  }
  const written = (await draftRows()).map((draft) => draft.id);
  if (written.length)
    await clientOf(ctx).call("Email/set", { accountId, destroy: written }, [
      CAPABILITIES.mail,
    ]);
  const added = (await eventRows()).filter((event) => !heldEvents.has(event.id));
  if (added.length)
    await clientOf(ctx).call(
      "CalendarEvent/set",
      { accountId, destroy: added.map((event) => event.id) },
      [CAPABILITIES.calendars],
    );
}

/** The last run the pass left, measured as the corpus measures a run. */
async function measure(only?: string): Promise<RunMeasure> {
  const records = await listRuns(ctx, accountId);
  const last = only
    ? records.find((record) => record.run.id === only)?.run
    : records[records.length - 1]?.run;
  if (!last)
    return {
      run: null,
      ending: "no-run",
      steps: 0,
      calls: 0,
      refused: 0,
      recovered: 0,
      said: null,
      tokens: 0,
      cachedTokens: 0,
      ms: 0,
    };
  for (const step of last.plan)
    console.error(
      `  step ${step.state}: ${step.what} -> ${step.outcome.replace(/\s+/g, " ").slice(0, 220)}`,
    );
  const counted = refusedAndRecovered(last.plan);
  return {
    run: last.id,
    ending: last.state,
    steps: last.spent.steps,
    calls: last.spent.calls,
    refused: counted.refused,
    recovered: counted.recovered,
    said: last.ended?.why ?? null,
    tokens: (last.spent.promptTokens ?? 0) + (last.spent.completionTokens ?? 0),
    cachedTokens: last.spent.cachedPromptTokens ?? 0,
    ms: last.spent.ms,
  };
}

function loop(holder = "eval"): InstanceType<typeof AgentLoop> {
  return new AgentLoop(ctx, {
    holder,
    accounts: async () => [accountId],
    access,
    log: (line: string) => console.error(line),
  });
}

/**
 * Follow a run to an ending under the loop's own ceiling.
 *
 * A run still working after a pass is what the service sees too: the next pass
 * picks it up. The measure follows it, so "never settles" is a result rather
 * than a hung script. A gap is the account being left unworked — the provider
 * answered nothing, the instruction could not be read — and the change is still
 * there for the next pass.
 */
async function follow(
  agent: InstanceType<typeof AgentLoop>,
  only?: string,
): Promise<void> {
  const began = Date.now();
  for (let passes = 0; passes < 6; passes++) {
    const summary = await agent.pass(new Date(began + passes * 61_000));
    console.error(
      `pass ${passes + 1}: ${summary.changes} change(s), ${summary.runs} run(s), ${summary.due} due`,
    );
    for (const gap of summary.gaps) console.error(`gap: ${gap}`);
    if ((await measure(only)).ending !== "running" && !summary.gaps.length) break;
  }
}

/**
 * One attempt at one task: the change is put in the account, the agent is
 * followed to an ending under its own ceiling, and the run is measured.
 *
 * A task that carries an `answer` has a second half: a person replies to the
 * question the run asked, the run is followed again, and the second measure is
 * what `grade` reads as `after` (ADR 0029, 0030).
 */
async function attempt(
  task: EvalTask,
): Promise<{ got: RunMeasure; after?: RunMeasure; score: number }> {
  await clean();
  // The account as a boot meets it, then the pass that anchors the reading, and
  // only then the message: a change created before the anchor was not a wake.
  await task.prepare?.(harness);
  const agent = loop();
  await agent.start();
  await task.arrive?.(harness);
  await follow(agent);
  const got = await measure();
  let after: RunMeasure | undefined;
  if (task.answer) {
    await task.answer(harness);
    await follow(agent, got.run ?? undefined);
    // The run the first measure read, not whatever the account holds last: the
    // person's answer is a change of its own, and a run opened beside it is not
    // the one this task follows.
    after = await measure(got.run ?? undefined);
  }
  return { got, after, score: await task.grade(harness, got, after) };
}

/*
 * Every task is tried once, and a task that did not score whole is tried **once
 * more** (ADR 0038): non-determinism is met cheaply, and one that passes only
 * the second time is `unstable`, not passed. What is printed is the first
 * attempt's verdict, which is `pass@1`.
 *
 * A word on the command line runs the tasks whose name holds it, which is how a
 * failing task is read on its own without paying for the other nine.
 */
if (TASKS.filter((task) => task.live).length < 6)
  throw new Error("the eval holds fewer than six tasks that drive the model");
const only = (process.argv[2] ?? "").toLowerCase();
const tasks = only
  ? TASKS.filter((task) => task.name.toLowerCase().includes(only))
  : TASKS;
if (!tasks.length) throw new Error(`no task's name holds "${only}"`);

await clean();
let firstPassed = 0;
let unstable = 0;
let failed = 0;
let total = 0;
let tokens = 0;
let cached = 0;
let calls = 0;
let ms = 0;
for (const task of tasks) {
  const attempts = [await attempt(task)];
  total += 1;
  let score = attempts[0]?.score ?? 0;
  let verdict = score === 1 ? "PASS" : "FAIL";
  if (score === 1) firstPassed += 1;
  else {
    attempts.push(await attempt(task));
    const retry = attempts[1]?.score ?? 0;
    score = Math.max(score, retry);
    if (retry === 1) verdict = "UNSTABLE";
  }
  if (verdict === "UNSTABLE") unstable += 1;
  if (verdict === "FAIL") failed += 1;
  const spent = attempts.reduce(
    (sum, one) => ({
      calls: sum.calls + one.got.calls,
      tokens: sum.tokens + one.got.tokens,
      cached: sum.cached + one.got.cachedTokens,
      ms: sum.ms + one.got.ms,
    }),
    { calls: 0, tokens: 0, cached: 0, ms: 0 },
  );
  tokens += spent.tokens;
  cached += spent.cached;
  calls += spent.calls;
  ms += spent.ms;
  const last = attempts[attempts.length - 1];
  const refused = (last?.got.refused ?? 0) + (last?.after?.refused ?? 0);
  const recovered = (last?.got.recovered ?? 0) + (last?.after?.recovered ?? 0);
  console.log(
    [
      verdict,
      `score=${score.toFixed(2)}`,
      task.name,
      // Each attempt's ending, first then retry: one number would hide the one
      // the retry answered after the first did not. A task with an `answer`
      // shows the ending the person's reply took the run to.
      `ending=${attempts
        .map((one) =>
          one.after ? `${one.got.ending}->${one.after.ending}` : one.got.ending,
        )
        .join(" -> ")}`,
      `steps=${last?.got.steps ?? 0}`,
      `calls=${spent.calls}`,
      `refused=${refused}`,
      `recovered=${recovered}`,
      `tokens=${spent.tokens}`,
      // The share the provider served from its own cache: the one number an
      // append-only turn is judged by, printed per task and not only as a total.
      `cached=${spent.tokens ? Math.round((spent.cached / spent.tokens) * 100) : 0}%`,
      last?.got.said ? `said=${JSON.stringify(last.got.said)}` : "",
      verdict === "PASS" ? "" : `expected: ${task.reference}`,
    ]
      .filter(Boolean)
      .join(" | "),
  );
}

console.log(
  `pass@1 ${firstPassed}/${total} | unstable ${unstable} | ` +
    `cost ${tokens} tokens (${cached} from the provider's cache, ` +
    `${tokens ? Math.round((cached / tokens) * 100) : 0}%), ` +
    `${calls} model calls, ${Math.round(ms / 1000)} s`,
);
(mock as { server?: { close(): void } }).server?.close();
process.exitCode = failed ? 1 : 0;
