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
 * `{provider, model, baseUrl, apiKey}`. The tasks and the outcome a person would
 * accept live in the plan of the branch (`tasks.md` beside the corpus); each task
 * below carries the same sentence in its `expect`.
 *
 * The bootstrap is here rather than imported from `loop.test.ts` because that
 * file registers fifty-eight tests when it is imported: a measure cannot be a
 * side effect of a suite. The duplication is confined to starting the mock and
 * picking the group account.
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
const { filesAccountId, readAppFileAt, destroyAppNode, writeAppFileAt } = await import(
  "../appFolder.js"
);
const { clientOf } = await import("../util.js");
const { CAPABILITIES } = await import("../shared/capabilities.js");
const { isGroupAccountRecord } = await import("../shared/sessionAccount.js");
const { parseInstallationDocumentDetailed } = await import("../shared/installation.js");

import type { InstallationModel } from "../shared/installation.js";

const { modelAccess } = await import("./model.js");
const { postChatMessage, findChatMessages } = await import("../groupChat.js");
const { AgentLoop } = await import("./loop.js");
const { INSTRUCTION_FILE, INSTRUCTION_VERSION } = await import("./instruction.js");
const { CURSOR_FILE } = await import("./cursors.js");
const { listRuns, runPath } = await import("./runs.js");

const BASE = `http://127.0.0.1:${MOCK_PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

/** The installation under measure, with the provider the deployment carries. */
const installation = parseInstallationDocumentDetailed(
  JSON.stringify({
    agent: { provider },
    secret: "an-eval-installation-secret-long-enough-to-seal-with",
  }),
);
if (!("doc" in installation))
  throw new Error(`the installation is unreadable: ${installation.problem}`);
const chosen = modelAccess(installation.doc, false)?.model;
if (!chosen) throw new Error("the installation chose no model");
const model: InstallationModel = chosen;

await waitForPort(BASE, AUTH);
const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const memoryAccountId = filesAccountId(ctx);
if (!memoryAccountId) throw new Error("the Master's session owns no Files");

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

/** A group's instruction: the prose it wrote and the areas it declared. */
async function writeInstruction(prose: string, areas: string[]): Promise<void> {
  await writeAppFileAt(ctx, accountId, INSTRUCTION_FILE, {
    v: INSTRUCTION_VERSION,
    instruction: prose,
    areas,
    surfaces: {
      chat: "watch",
      mail: "ondemand",
      files: "ondemand",
      knowledge: "ondemand",
      workorder: "ondemand",
      calendar: "ondemand",
    },
    sends: false,
  });
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

async function deliver(subject: string, body = ""): Promise<string> {
  const inbox = await inboxOf(accountId);
  const answer = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        c: {
          subject,
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
  return id;
}

/** A clean account between tasks: the cursor, the runs, the instruction. */
async function clean(): Promise<void> {
  for (const id of [CURSOR_FILE, INSTRUCTION_FILE]) {
    const found = await readAppFileAt(ctx, accountId, id);
    if (typeof found?.file.id === "string")
      await destroyAppNode(ctx, accountId, found.file.id);
  }
  for (const { run } of await listRuns(ctx, accountId)) {
    const found = await readAppFileAt(ctx, accountId, runPath(run.id));
    if (typeof found?.file.id === "string")
      await destroyAppNode(ctx, accountId, found.file.id);
  }
}

interface Measured {
  ending: string | null;
  steps: number;
  calls: number;
  refused: number;
  said: string | null;
}

/** The last run the pass left, measured as the corpus measures a run. */
async function measured(): Promise<Measured> {
  const records = await listRuns(ctx, accountId);
  const last = records[records.length - 1]?.run;
  if (!last) return { ending: "no-run", steps: 0, calls: 0, refused: 0, said: null };
  return {
    ending: last.state,
    steps: last.spent.steps,
    calls: last.spent.calls,
    refused: last.plan.filter((step) => step.state === "failed").length,
    said: last.ended?.why ?? null,
  };
}

function loop(holder = "eval"): InstanceType<typeof AgentLoop> {
  return new AgentLoop(ctx, {
    holder,
    accounts: async () => [accountId],
    access: { model, allowPrivateProvider: false },
    log: (line: string) => console.error(line),
  });
}

interface Task {
  name: string;
  /** The outcome a person would accept, written before the measure. */
  expect: string;
  pass: (got: Measured) => boolean | Promise<boolean>;
  run: (agent: InstanceType<typeof AgentLoop>) => Promise<void>;
}

const tasks: Task[] = [
  {
    name: "a mention in a group with no instruction is answered, without a run",
    expect: "one message in the thread, no run, no model call",
    pass: async (got) => {
      if (got.ending !== "no-run") return false;
      const noticed = await findChatMessages(ctx, accountId, "no instruction", 5);
      return noticed.length === 1;
    },
    run: async (agent) => {
      await agent.start();
      const said = await postChatMessage(
        ctx,
        accountId,
        "sam@example.org",
        "@demo are you up?",
      );
      if (!said) throw new Error("the mention was not posted");
    },
  },
  {
    name: "a mail in an area the instruction does not declare opens no run",
    expect: "no run, and no message for it",
    pass: (got) => got.ending === "no-run",
    run: async (agent) => {
      await agent.start();
      await writeInstruction("Keep the calendar in order.", ["calendar"]);
      await deliver("a booking confirmation", "the booking reference is BK-42");
    },
  },
  {
    name: "a mail in the mail area is read and answered",
    expect: "a run that ends done, no argument refusal, at most about seven calls",
    pass: (got) => got.ending === "done" && got.refused === 0 && got.calls <= 9,
    run: async (agent) => {
      await agent.start();
      await writeInstruction("File what the shippers send, and report what is missing.", [
        "mail",
        "files",
      ]);
      await deliver("a booking confirmation", "the booking reference is BK-42");
    },
  },
];

await clean();
const results: Array<{ task: Task; got: Measured; passed: boolean; passes: number }> = [];
for (const task of tasks) {
  await clean();
  const agent = loop();
  await task.run(agent);
  /*
   * A run still working after a pass is what the service sees too: the next pass
   * picks it up. The measure follows it to an ending under a ceiling of its own,
   * so "never settles" is a result rather than a hung script.
   */
  const began = Date.now();
  let passes = 0;
  for (; passes < 6; passes++) {
    const summary = await agent.pass(new Date(began + passes * 61_000));
    for (const gap of summary.gaps) console.error(`gap: ${gap}`);
    /*
     * A gap is the account being left unworked — the provider answered nothing,
     * the instruction could not be read — and the change is still there for the
     * next pass. The measure follows it, because what a person sees is a run
     * that never opened and a pass that says why, not a verdict on one attempt.
     */
    if ((await measured()).ending !== "running" && !summary.gaps.length) break;
  }
  const got = await measured();
  results.push({ task, got, passed: await task.pass(got), passes });
}

for (const { task, got, passed, passes } of results)
  console.log(
    [
      passed ? "PASS" : "FAIL",
      task.name,
      `ending=${got.ending}`,
      `passes=${passes}`,
      `steps=${got.steps}`,
      `calls=${got.calls}`,
      `refused=${got.refused}`,
      got.said ? `said=${JSON.stringify(got.said)}` : "",
      passed ? "" : `expected: ${task.expect}`,
    ]
      .filter(Boolean)
      .join(" | "),
  );

const failed = results.filter((one) => !one.passed).length;
console.log(`${results.length - failed}/${results.length} tasks passed`);
(mock as { server?: { close(): void } }).server?.close();
process.exitCode = failed ? 1 : 0;
