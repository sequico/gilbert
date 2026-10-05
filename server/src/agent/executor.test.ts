import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { sleep } from "../shared/async.js";
import { blankPdf, freePort } from "../testkit.js";
import type {
  AgentGroupPolicyDoc,
  AgentJob,
  AgentRule,
  AgentTriggerOn,
} from "./documents.js";
import type { ScheduleGuard } from "./executor.js";

/**
 * The executor end to end against the mock (ADR 0003).
 *
 * The mock does not reproduce everything the real server does: its clock is not
 * injectable, `ifInState` is not enforced (so the compare-and-set *retry* path
 * is exercised only through the lease tests), and a submission records itself
 * without an MTA. What it does reproduce is the rail this executor lives on —
 * `Email/changes`, `Thread/get`, `Email/get`, `Email/set`, `EmailSubmission/set`
 * and the group's own Files — so the lifecycle, the review gate, the approval
 * arbiter and the loud failure are all driven for real here.
 *
 * This suite binds the mock's port, and the runner executes test files as
 * parallel child processes. It failed once under a full run and has not
 * reproduced since, in isolation or in a full sweep; the cause is not
 * established, so a failure here is worth re-running before it is believed.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
// The stub model this suite calls lives on loopback: the deployment says so,
// which is the operator's statement and never a document's.
process.env.GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER = "1";
// This installation's model reads no image, stated before the configuration is
// read: a deployment without vision hands no page over, and what its runs are
// told is asserted below.
process.env.GILBERT_AGENT_VISION = "0";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const {
  filesAccountId,
  FILENODE_CAP,
  findFolderPath,
  readAppJsonAt,
  writeAppFileAt,
  writeBytesIntoVisibleFolder,
} = await import("../appFolder.js");
const { JMAP_MAIL, JMAP_SUBMISSION, JmapClient } = await import("../jmap.js");
const { GROUP_LABELS_FILE } = await import("../shared/labels.js");
const {
  buildDraft,
  buildState,
  DRAFT_FILE,
  isKnowledgeDraft,
  isKnowledgeState,
  KNOWLEDGE_FOLDER,
  knowledgeFolderName,
  plainTextFromBlocks,
  REVISIONS_FOLDER,
  STATE_FILE,
} = await import("../shared/knowledge.js");
const { fetchEmailRecord, findMailboxByName, mailboxIdByRole } = await import(
  "./actions.js"
);
const { postMessage, readChat } = await import("./chat.js");
const { automationLabel, newDecision, newJob, AGENT_LOOKUP_ROUNDS } = await import(
  "./documents.js"
);
const { Executor, JOB_MAX_ATTEMPTS } = await import("./executor.js");
const { claimAccount, saveClaimStates } = await import("./lease.js");
const { AgentStore } = await import("./store.js");

const BASE = `http://127.0.0.1:${PORT}`;
/**
 * The model every run asks. There is one shape now and no tier that runs
 * without a model (ADR 0003), so a run reaches this stub or it does not run.
 *
 * The answer is keyed by the automation's label — which is its trigger
 * (`automationLabel`), and the one thing the prompt states about which
 * automation is being decided. With one enabled automation per trigger a group
 * holds at most four, so a test that needs a particular answer — a mail to
 * send, a malformed action — states it for the trigger its own rule stands on
 * instead of moving the answer for every other test.
 */
const MODEL_PORT = 18854;
const answers = new Map<string, unknown>();
/** Every automation a run has asked the model about, in order. */
const asked: string[] = [];

/** One call the stub received: the prompt, and the blocks the data arrived in. */
interface ModelCall {
  system: string;
  messages: Array<{ role?: string; content?: unknown }>;
}

/** Every call the stub received, in order, for the reader of the prompt. */
const calls: ModelCall[] = [];
const DEFAULT_ANSWER = {
  summary: "Labelled it.",
  confidence: 1,
  actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
};

function answerFor(label: string, value: unknown): void {
  answers.set(label, value);
}

/**
 * A sequence of answers one automation gives, consumed one call at a time.
 *
 * A run that looks something up is asked more than once (ADR 0020), so a test
 * about it states what the model answers the first time and what it answers
 * with the lookup's result in front of it. The last answer is repeated if the
 * run asks again, so a run that ignores the result and keeps looking is bounded
 * by the run rather than by the stub.
 */
const sequences = new Map<string, unknown[]>();

function answerSequence(label: string, values: unknown[]): void {
  sequences.set(label, [...values]);
}

/*
 * Two things a test changes and the next one must not inherit.
 *
 * The model's answers are keyed by the automation's label, which is its trigger:
 * within one test that identifies the run, across tests it does not — a
 * malformed answer stated to prove one refusal would otherwise be the answer
 * every later test's run received.
 *
 * And the group's policy is a document, like the rules: a test about who a run
 * stops for changes it, and the change outlives the test. Putting it back is
 * therefore done **only when a test moved it** — `policyMoved` is set by
 * `setPolicy` itself — because every test in this file shares one account, and
 * a write per test restores a document nobody touched while adding contention
 * to the very reads and writes the tests are about.
 */
let policyMoved = false;

/**
 * Put the shared policy document back, with no precondition.
 *
 * The restore is not the change anybody is racing: `setPolicy` states what a
 * test wants from the gate, and this puts back what every other test expects.
 * It is written unconditionally because the read-then-write form loses to
 * whatever the previous test left running in this account — a fixture write is
 * not the compare-and-set ADR 0012 is about, and a suite that flakes on its
 * own housekeeping reports on the suite rather than on the code.
 */
async function restorePolicy(): Promise<void> {
  await store.writePolicy({ review: "never", allowExternal: false }, "admin@example.com");
}

beforeEach(async () => {
  answers.clear();
  sequences.clear();
  asked.length = 0;
  if (policyMoved) await restorePolicy();
  policyMoved = false;
});

const modelStub = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let system = "";
  let messages: ModelCall["messages"] = [];
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    messages = body.messages ?? [];
    system = String(messages.find((message) => message.role === "system")?.content ?? "");
  } catch {
    system = "";
    messages = [];
  }
  const named = /automation "([^"]+)"/.exec(system)?.[1] ?? "";
  asked.push(named);
  calls.push({ system, messages });
  const sequence = sequences.get(named);
  const answer =
    sequence && sequence.length > 1
      ? sequence.shift()
      : (sequence?.[0] ?? answers.get(named) ?? DEFAULT_ANSWER);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(answer) } }],
      // A provider that reports what a call cost: the meter is only as good as
      // this, and a provider that says nothing leaves the counts null.
      usage: {
        prompt_cache_hit_tokens: 900,
        prompt_cache_miss_tokens: 30,
        completion_tokens: 7,
      },
    }),
  );
});
const GROUP = "a3";
const AGENT = "gilbert@example.com";
const ADA = "ada@example.org";
const WORKER = "w-executor-test";
const LEASE = 60_000;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const client = new JmapClient({ authorization: AUTH, session });
const store = new AgentStore(ctx, GROUP);

const logLines: string[] = [];
const executor = new Executor({
  ctx,
  client,
  address: AGENT,
  agentId: WORKER,
  now: () => new Date(),
  log: (line) => logLines.push(line),
});

async function createMessage(
  subject: string,
  text = "please handle this",
): Promise<string> {
  const created = await client.call<{
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, unknown>;
  }>(
    "Email/set",
    {
      accountId: GROUP,
      create: {
        m: {
          mailboxIds: { "g-inbox": true },
          keywords: {},
          subject,
          from: [{ name: "Ada Lovelace", email: ADA }],
          bodyStructure: { partId: "t", type: "text/plain" },
          bodyValues: { t: { value: text } },
        },
      },
    },
    [JMAP_MAIL],
  );
  const id = created.created?.m?.id;
  assert.ok(id, `the mock created the message: ${JSON.stringify(created.notCreated)}`);
  return id;
}

/**
 * One knowledge base article, seeded the way a writer's save leaves it: a
 * folder named by the title holding a `draft.json` and a `state.json`
 * (ADR 0024). The id is handed back so a test can name it in a lookup.
 */
async function seedKnowledgeArticle(
  id: string,
  title: string,
  text: string,
): Promise<void> {
  const folder = knowledgeFolderName(title);
  const at = new Date().toISOString();
  const path = `${KNOWLEDGE_FOLDER}/${folder}`;
  const draft = buildDraft({
    id,
    title,
    tags: ["iso"],
    blocks: [],
    text,
    by: AGENT,
    at,
  });
  const state = buildState({ id, title, tags: ["iso"], by: AGENT, at });
  await writeAppFileAt(ctx, GROUP, `${path}/${DRAFT_FILE}`, draft);
  await writeAppFileAt(ctx, GROUP, `${path}/${STATE_FILE}`, state);
}

function rule(overrides: Partial<AgentRule> = {}): AgentRule {
  return {
    v: 1,
    id: "file-invoices",
    version: 1,
    enabled: true,
    trigger: { on: "email" },
    instruction: "Label the invoice so the group can file it.",
    capabilities: ["keyword.add"],
    ...overrides,
  };
}

/**
 * The group's policy: who its runs stop for (ADR 0006).
 *
 * It is one document per group rather than a field on an automation, so a test
 * that cares about the gate states it here and every other test inherits the
 * suite's own — written once in `before` as "run unattended", which is what the
 * runs below are about.
 */
async function setPolicy(
  over: Partial<Pick<AgentGroupPolicyDoc, "review" | "allowExternal">> = {},
): Promise<void> {
  policyMoved = true;
  const found = await store.readPolicy();
  await store.writePolicy(
    { review: over.review ?? "never", allowExternal: over.allowExternal ?? false },
    "admin@example.com",
    found ? { ifInState: found.state } : {},
  );
}

async function claimFor() {
  // The claim is a fence taken once: `startedAt` is when the process asking
  // came up, and this one came up before the claim was written, which is what
  // makes a free unit free to take.
  const claim = await claimAccount(store, WORKER, {
    now: new Date(),
    startedAt: new Date(Date.now() - LEASE),
  });
  assert.ok(claim, "the agent holds the account");
  return claim;
}

/**
 * A claim that has already reconciled the account up to where it is now.
 *
 * A test that is about what a run's *own* effect wakes starts from "the state
 * the agent has reconciled up to" — the anchor that tells a change this run
 * caused from a change somebody else made after it (ADR 0003). That anchor is a
 * fact about the claim **document**, and a pass cannot be relied on to leave
 * one: a reconcile whose changes were all the agent's own bookkeeping
 * deliberately does not advance it (`onlyBookkeeping` — advancing it would be a
 * write that is itself the next change, for ever). And it is not only the
 * bookkeeping: this suite runs against one account, so a claim left where an
 * earlier test put it re-reads that test's records as changes of this pass.
 *
 * Stating both anchors is therefore what makes such a test about its own work:
 * the changes the passes below see are the ones this test made, and nothing
 * else. `claimFor()` is what a agent's own claim is; this is the same claim
 * with the reading it would have had after a reconcile of everything so far.
 */
async function claimAnchoredOnTheAccount(): Promise<AgentClaim> {
  const claim = await claimFor();
  const states: Record<string, string> = {};
  for (const type of ["Email", "FileNode"] as const) {
    const res = await client.call<{ state?: unknown }>(
      `${type}/get`,
      { accountId: GROUP, ids: [] },
      [type === "Email" ? JMAP_MAIL : FILENODE_CAP],
    );
    states[type] = typeof res.state === "string" ? res.state : "";
  }
  const at = new Date().toISOString();
  const saved = await saveClaimStates(store, claim, states, {
    Email: at,
    FileNode: at,
  });
  assert.ok(saved, "the anchors are written into the claim the agent holds");
  return saved;
}

async function jobsOf(ruleId: string): Promise<AgentJob[]> {
  return (await store.listJobs())
    .map((entry) => entry.doc)
    .filter((job) => job.ruleId === ruleId);
}

/**
 * The installation's configuration, written the way its own surface writes it.
 *
 * The agent's own account is where the executor reads it from, and a bound
 * written here is written as a document rather than through the admin route:
 * the route holds a value to the ceiling this build accepts, and the point of
 * `maxPages: 100` below is a document somebody wrote by hand.
 */
async function installConfig(
  over: { maxPages?: number; maxChainHops?: number } = {},
): Promise<void> {
  await new AgentStore(ctx, filesAccountId(ctx)).writeConfig({
    v: 1,
    address: AGENT,
    provider: {
      provider: "stub",
      model: "stub",
      baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`,
      apiKey: "stub-key",
    },
    // The installation's own bound on a chain, set here rather than left to the
    // deployment's default: what the account says is what a run is held to
    // (ADR 0003), and a build that read only the environment would run to five.
    maxChainHops: 2,
    ...over,
  });
}

/**
 * The last call a run of one trigger's automation made, as the stub received
 * it.
 *
 * The key is the trigger, because that is what names an automation: two rules
 * of this suite may share both their instruction and their answer, and the only
 * thing that tells their runs apart is what woke them.
 */
function lastCallFor(on: AgentTriggerOn): ModelCall {
  const label = automationLabel({ trigger: { on } });
  const call = [...calls]
    .reverse()
    .find((entry) => entry.system.includes(`automation "${label}"`));
  assert.ok(call, `the run of the ${label} asked the model`);
  return call;
}

/** The parts of the user message: the text, and any image the data carried. */
function userParts(call: ModelCall): Array<{ type?: string; text?: string }> {
  const user = call.messages.find((message) => message.role === "user")?.content;
  if (typeof user === "string") return [{ type: "text", text: user }];
  return Array.isArray(user) ? (user as Array<{ type?: string; text?: string }>) : [];
}

before(async () => {
  await new Promise<void>((resolve) =>
    modelStub.listen(MODEL_PORT, "127.0.0.1", resolve),
  );
  // The installation's model, in the agent's own account — the only place the
  // executor reads it from.
  await installConfig();
  await writeAppFileAt(ctx, GROUP, GROUP_LABELS_FILE, {
    labels: [
      { keyword: "G-processed", name: "Gilbert: processed", color: "#15803d" },
      { keyword: "G-needattention", name: "Gilbert: needs attention", color: "#b91c1c" },
      { keyword: "G-awaiting", name: "Gilbert: awaiting approval", color: "#b45309" },
      { keyword: "G-rejected", name: "Gilbert: rejected", color: "#475569" },
    ],
  });
  await client.call(
    "Mailbox/set",
    {
      accountId: GROUP,
      create: { d: { name: "Drafts", role: "drafts", parentId: null } },
    },
    [JMAP_MAIL],
  );
  /*
   * The group's policy, once for the suite. What most of these tests are about
   * is the run itself rather than the gate, so the group runs unattended here
   * and a test that is about who a run stops for states its own policy.
   */
  await setPolicy({ review: "never" });
  policyMoved = false;
});

after(() => {
  modelStub.close();
  (mock as { server?: { close(): void } }).server?.close();
});

test("a matching message is filed: the job runs, the audit records it, the claim advances", async () => {
  const rule_ = rule();
  await store.writeRules([rule_]);
  const emailId = await createMessage("Your invoice #4821 is ready");
  const claim = await claimFor();

  await executor.reconcile(GROUP, "Email", claim);

  const jobs = await jobsOf(rule_.id);
  assert.equal(jobs.length, 1, "one job per (record × rule)");
  const job = jobs[0]!;
  assert.equal(
    job.state,
    "done",
    "the model answered with confidence 1, so the threshold passes it",
  );
  assert.equal(job.ruleVersion, rule_.version);
  assert.equal(job.attempts, 1);
  assert.equal(job.trigger.emailId, emailId);
  assert.equal(job.trigger.by, ADA, "the trail records who caused the run");

  const audit = await store.readAuditAt(new Date());
  const entries = (audit?.entries ?? []).filter(
    (candidate) => candidate.jobId === job.id,
  );
  const entry = entries.at(-1);
  assert.ok(entry, "the run is in the month's audit document");
  assert.equal(entry.outcome, "done");
  assert.equal(entry.ruleId, rule_.id);
  assert.deepEqual(entry.actions, [
    { do: "keyword.add", with: { keyword: "G-processed" } },
  ]);
  // The intent line: the trail says what was about to run before it ran, so an
  // effect can never exist without a line that accounts for it.
  assert.equal(
    entries[0]?.outcome,
    "running",
    "the audit records the intent before the actions",
  );
  // The cost rides that entry, beside the work that spent it (ADR 0003), so the
  // meter is a reading of the trail rather than a second document to keep in
  // step — and the agent and the setting stay readable a month later.
  assert.equal(entries[0]?.agent, AGENT, "the entry names the agent that spent it");
  assert.equal(entries[0]?.reasoned, true, "and the thinking setting it ran under");
  assert.deepEqual(entries[0]?.usage, {
    inputHitTokens: 900,
    inputMissTokens: 30,
    outputTokens: 7,
  });

  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-processed"],
    true,
    "the rule's own action labeled the message",
  );

  const advanced = await store.readClaim("mail");
  assert.ok(
    advanced?.doc.states.Email,
    "the claim records the state it reconciled up to",
  );
});

test("every delivered message is one the mail automation reads", async () => {
  /*
   * An automation carries no filter, so the executor's own pre-filter is gone
   * with the field it belonged to (ADR 0006). What it reads of a message is its
   * identity — the run fetches the message itself, body included, when it builds
   * the context it decides on.
   *
   * A draft is the one exclusion, and it is the account's own bookkeeping rather
   * than a match: work in progress must not wake the run that prepares it.
   */
  const only = rule({ id: "everything" });
  await store.writeRules([only]);
  const delivered = await createMessage("A message nobody filtered for");
  // A draft, which is work in progress rather than delivered mail: it is the
  // one thing the reconcile leaves alone.
  const drafts = await mailboxIdByRole(client, GROUP, "drafts");
  assert.ok(drafts, "the suite's own setup gave the group a Drafts mailbox");
  const madeDraft = await client.call<{ created?: Record<string, { id: string }> }>(
    "Email/set",
    {
      accountId: GROUP,
      create: {
        d: {
          mailboxIds: { [drafts]: true },
          keywords: { $draft: true },
          subject: "A draft nobody should wake a run for",
          from: [{ email: ADA }],
          bodyStructure: { partId: "t", type: "text/plain" },
          bodyValues: { t: { value: "still writing" } },
        },
      },
    },
    [JMAP_MAIL],
  );
  const draftId = madeDraft.created?.d?.id;
  assert.ok(draftId, "the mock created the draft");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const jobs = await jobsOf("everything");
  assert.equal(
    jobs.filter((job) => job.trigger.emailId === delivered).length,
    1,
    "the delivered message opened a job",
  );
  assert.equal(
    jobs.filter((job) => job.trigger.emailId === draftId).length,
    0,
    "and the draft opened none",
  );
});

test("an automation that could do nothing fails loudly instead of never running", async () => {
  /*
   * The form refuses a rule with no grant; one that reached storage by another
   * road — written by hand, or restored from a backup — has to be refused when
   * it runs as well, or the refusal is a formality. The failure is loud: the
   * job fails with the reason, the group hears it, and nothing pretends an
   * automation that can do nothing did something.
   */
  const broken = rule({ id: "no-grant", capabilities: [] });
  await store.writeRules([broken]);
  const emailId = await createMessage("An invoice no automation can act on");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const jobs = (await jobsOf("no-grant")).filter(
    (job) => job.trigger.emailId === emailId,
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.state, "failed");
  assert.match(
    String(jobs[0]!.error),
    /needs at least one capability/,
    "and it refuses in the words the form uses, not in words of its own",
  );
  const audit = await store.readAuditAt(new Date());
  assert.ok(
    audit?.entries.some(
      (entry) => entry.jobId === jobs[0]!.id && entry.outcome === "failed",
    ),
  );
  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    chat.some((message) => message.text.includes("could not finish")),
    "the group is told which automation could not finish",
  );
});

test("a G- label the group's catalog does not define refuses the run before it acts", async () => {
  const bad = rule({
    id: "unknown-label",
    capabilities: ["keyword.add"],
  });
  answerFor("Mail automation", {
    summary: "Labelled it.",
    confidence: 1,
    actions: [{ do: "keyword.add", with: { keyword: "G-nobody-defined-this" } }],
  });
  await store.writeRules([bad]);
  const emailId = await createMessage("An invoice for the wrong label");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const job = (await jobsOf("unknown-label")).find(
    (candidate) => candidate.trigger.emailId === emailId,
  );
  assert.ok(job);
  assert.equal(job.state, "failed", "a refusal is not retried: the rule has to be fixed");
  assert.match(String(job.error), /does not define G-nobody-defined-this/);
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-nobody-defined-this"],
    undefined,
    "nothing ran",
  );
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-needattention"],
    true,
    "and the message is marked for a person",
  );
});

test("duplicate delivery is harmless: the same record never opens a second job", async () => {
  const once = rule({
    id: "once-only",
    capabilities: ["noop"],
  });
  answerFor("Mail automation", {
    summary: "Left it alone.",
    confidence: 1,
    actions: [{ do: "noop" }],
  });
  await store.writeRules([once]);
  const emailId = await createMessage("An invoice delivered twice");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });
  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const jobs = (await jobsOf("once-only")).filter(
    (job) => job.trigger.emailId === emailId,
  );
  assert.equal(
    jobs.length,
    1,
    "a replay is a signal, and the job document is the deduplication",
  );
  assert.equal(jobs[0]!.state, "done");
});

test("a job whose pinned rule version is gone refuses instead of running another", async () => {
  const pinned = rule({ id: "pinned", version: 1 });
  await store.writeRules([pinned]);
  const emailId = await createMessage("An invoice for a rule that moved on");
  const job = newJob({
    id: "pinned-job",
    accountId: GROUP,
    rule: { id: "pinned", version: 1 },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, { ...pinned, version: 2 });

  const stored = await store.readJob("pinned-job");
  assert.equal(stored?.doc.state, "failed");
  assert.match(String(stored?.doc.error), /pins rule version 1/);
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal((marked?.keywords as Record<string, unknown>)?.["G-processed"], undefined);
});

test("a run that must wait on a person pauses, and one conversational answer settles it", async () => {
  const waiting = rule({
    id: "ask-first",
  });
  await setPolicy({ review: "always" });
  // This test is about a run that stops for a person, so the group says so.
  await store.writeRules([waiting]);
  const emailId = await createMessage("An invoice needing approval");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const job = (await jobsOf("ask-first")).find(
    (candidate) => candidate.trigger.emailId === emailId,
  );
  assert.ok(job);
  assert.equal(job.state, "awaiting_approval");
  assert.ok(job.proposal, "the proposal is on the job, so a restart resumes from it");
  assert.ok(job.decisionId);
  const decision = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.ok(decision);
  assert.equal(decision.state, "pending");
  assert.ok(decision.chatId, "the proposal is a chat message a member can reply to");

  // An answer that is not a yes or a no gets one closed question back.
  await postAs(ADA, "hmm, maybe later", String(decision.chatId));
  await executor.answerDecisions(GROUP, await readChat(ctx, GROUP, client));
  const afterAsking = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.equal(afterAsking?.state, "pending", "an unclear answer decides nothing");
  const chat = await readChat(ctx, GROUP, client);
  assert.ok(chat.some((message) => message.text.includes('Answer "yes" to approve')));

  // The unambiguous answer settles it.
  await postAs(ADA, "yes please", String(decision.chatId));
  const answered = await executor.answerDecisions(
    GROUP,
    await readChat(ctx, GROUP, client),
  );
  assert.deepEqual(answered, [String(job.decisionId)]);

  const settled = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.equal(settled?.state, "approved");
  assert.equal(
    settled?.decidedBy,
    ADA,
    "any member may approve; this is never an admin check",
  );
  const closed = await store.readJob(String(job.id));
  assert.equal(closed?.doc.state, "done");
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal((marked?.keywords as Record<string, unknown>)?.["G-processed"], true);

  // The arbiter: a second caller finds a decision that is no longer pending and
  // changes nothing.
  await executor.resolveApproval(GROUP, decision, true, "grace@example.org");
  const stillSettled = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.equal(stillSettled?.decidedBy, ADA);
  const audit = await store.readAuditAt(new Date());
  assert.equal(
    audit?.entries.filter((entry) => entry.jobId === job.id && entry.outcome === "done")
      .length,
    1,
    "one approval, one recorded run",
  );
});

test("a malformed proposal fails loudly rather than pausing on nothing", async () => {
  const broken = rule({
    id: "no-action-params",
    capabilities: ["keyword.add"],
  });
  // The model answers with an action missing a parameter the catalogue
  // requires: the answer is refused before it can become an effect.
  answerFor("Mail automation", {
    summary: "Labelled it.",
    confidence: 1,
    actions: [{ do: "keyword.add", with: {} }],
  });
  await store.writeRules([broken]);
  await createMessage("An invoice for a broken rule");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const job = (await jobsOf("no-action-params")).at(-1);
  assert.ok(job);
  assert.equal(job.state, "pending", "a refused answer is retried, never executed");
  assert.match(String(job.error), /without keyword/);
});

test("a proposal that would send mail leaves the draft in Drafts, unread, and a person sending it settles the decision", async () => {
  const proposer = rule({
    id: "draft-and-send",
    capabilities: ["mail.draft", "mail.send"],
  });
  answerFor("Mail automation", {
    summary: "Replied to the invoice.",
    confidence: 1,
    actions: [
      {
        do: "mail.draft",
        with: { to: ADA, subject: "Re: invoice", text: "Filed, thank you." },
      },
      {
        do: "mail.send",
        with: { to: ADA },
      },
    ],
  });
  await setPolicy({ review: "always" });
  // This test is about a run that stops for a person, so the group says so.
  await store.writeRules([proposer]);
  const emailId = await createMessage("An invoice that wants a reply");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const job = (await jobsOf("draft-and-send")).find(
    (candidate) => candidate.trigger.emailId === emailId,
  );
  assert.ok(job);
  assert.equal(job.state, "awaiting_approval", String(job.error));
  const draft = job.proposal?.draft;
  assert.ok(draft, "the proposal left a draft a member can read and send");
  const decision = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.deepEqual(
    decision?.draft,
    draft,
    "the decision carries the same draft reference",
  );

  const draftMail = await fetchEmailRecord(client, GROUP, draft.emailId, {});
  const keywords = (draftMail?.keywords ?? {}) as Record<string, unknown>;
  assert.equal(keywords.$draft, true);
  assert.equal(keywords["G-awaiting"], true, "a pending draft says so on the message");
  assert.equal(keywords.$seen, undefined, "and stays unread, so a human sees it");
  assert.equal(draftMail?.mailboxIds?.[draft.mailboxId], true);

  const before = await submissionCount();
  // A member opens the draft and sends it: it leaves Drafts. Their message as
  // sent is the approval, and the executor must not send it a second time.
  await client.call(
    "Email/set",
    { accountId: GROUP, update: { [draft.emailId]: { mailboxIds: { "g-sent": true } } } },
    [JMAP_MAIL],
  );
  const swept = await executor.sweepDrafts(GROUP, [String(job.decisionId)]);
  assert.deepEqual(swept, [String(job.decisionId)]);

  const settled = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.equal(settled?.state, "approved");
  assert.equal(settled?.decidedBy, "draft");
  assert.equal((await store.readJob(String(job.id)))?.doc.state, "done");
  assert.equal(
    await submissionCount(),
    before,
    "the person sent it; the executor does not send it again",
  );
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal((marked?.keywords as Record<string, unknown>)?.["G-processed"], true);
});

test("a draft that vanished is not an approval", async () => {
  const proposer = rule({
    id: "vanishing-draft",
    capabilities: ["mail.draft", "mail.send"],
  });
  answerFor("Mail automation", {
    summary: "Replied to the invoice.",
    confidence: 1,
    actions: [
      { do: "mail.draft", with: { to: ADA, subject: "Re: gone", text: "Hello." } },
      { do: "mail.send", with: { to: ADA } },
    ],
  });
  await setPolicy({ review: "always" });
  // This test is about a run that stops for a person, so the group says so.
  await store.writeRules([proposer]);
  await createMessage("An invoice whose draft will vanish");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });
  const job = (await jobsOf("vanishing-draft")).at(-1);
  assert.ok(job?.proposal?.draft, String(job?.error));
  await client.call(
    "Email/set",
    { accountId: GROUP, destroy: [job.proposal.draft.emailId] },
    [JMAP_MAIL],
  );
  await executor.sweepDrafts(GROUP, [String(job.decisionId)]);
  const settled = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.equal(
    settled?.state,
    "expired",
    "nothing can be sent from a draft that is gone",
  );
  assert.equal((await store.readJob(String(job.id)))?.doc.state, "done");
});

test("a draft moved to Trash is a rejection, not a send", async () => {
  const madeTrash = await client.call<{ created?: Record<string, { id: string }> }>(
    "Mailbox/set",
    {
      accountId: GROUP,
      create: { t: { name: "Trash", role: "trash", parentId: null } },
    },
    [JMAP_MAIL],
  );
  const trashId = madeTrash.created?.t?.id;
  assert.ok(trashId, "the mock assigns the Trash mailbox its own id");
  const proposer = rule({
    id: "trashed-draft",
    capabilities: ["mail.draft", "mail.send"],
  });
  answerFor("Mail automation", {
    summary: "Replied to the invoice.",
    confidence: 1,
    actions: [
      { do: "mail.draft", with: { to: ADA, subject: "Re: no thanks", text: "Hello." } },
      { do: "mail.send", with: { to: ADA } },
    ],
  });
  await setPolicy({ review: "always" });
  // This test is about a run that stops for a person, so the group says so.
  await store.writeRules([proposer]);
  const emailId = await createMessage("An invoice whose reply will be rejected");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });
  const job = (await jobsOf("trashed-draft")).at(-1);
  assert.ok(job?.proposal?.draft, String(job?.error));

  const before = await submissionCount();
  // The most ordinary way a person rejects a proposal: they delete the draft,
  // which in JMAP is a move to Trash, not a destroy — the message still
  // exists. This must not be read as "a person sent it".
  await client.call(
    "Email/set",
    {
      accountId: GROUP,
      update: {
        [job.proposal.draft.emailId]: { mailboxIds: { [trashId as string]: true } },
      },
    },
    [JMAP_MAIL],
  );
  const swept = await executor.sweepDrafts(GROUP, [String(job.decisionId)]);
  assert.deepEqual(swept, [String(job.decisionId)]);

  const settled = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.equal(
    settled?.state,
    "expired",
    "a draft discarded to Trash was never sent, so the decision is not approved",
  );
  assert.equal((await store.readJob(String(job.id)))?.doc.state, "done");
  assert.equal(
    await submissionCount(),
    before,
    "nothing was ever submitted, so nothing is sent on the draft's behalf",
  );
  const original = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal(
    (original?.keywords as Record<string, unknown>)?.["G-processed"],
    undefined,
    "the rest of a rejected plan does not run either",
  );
});

test("a failure retries to a point and then dead-letters, telling the group", async () => {
  const flaky = rule({ id: "flaky" });
  await store.writeRules([flaky]);
  const emailId = await createMessage("An invoice for a flaky rule");
  const job = newJob({
    id: "flaky-job",
    accountId: GROUP,
    rule: { id: "flaky", version: 1 },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  await store.writeJob({ ...job, attempts: 1, state: "running" });

  await executor.failLoudly(
    store,
    { ...job, attempts: 1, state: "running" },
    flaky,
    "the provider was unreachable",
  );
  const afterFirst = await store.readJob("flaky-job");
  assert.equal(
    afterFirst?.doc.state,
    "pending",
    "a retry stays pending for a later pass",
  );
  assert.equal(afterFirst?.doc.error, "the provider was unreachable");
  const chatBefore = (await readChat(ctx, GROUP, client)).length;

  await executor.failLoudly(
    store,
    { ...afterFirst!.doc, attempts: 3 },
    flaky,
    "the provider was unreachable",
  );
  const dead = await store.readJob("flaky-job");
  assert.equal(dead?.doc.state, "failed", "the third attempt is the end of it");
  const chat = await readChat(ctx, GROUP, client);
  assert.ok(chat.length > chatBefore, "the group hears about a dead lettered automation");
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal((marked?.keywords as Record<string, unknown>)?.["G-needattention"], true);
});

test("the schedule fires what is due and moves the entry on", async () => {
  const scheduled = rule({
    id: "every-five",
    trigger: { on: "schedule", everyMinutes: 5 },
    capabilities: ["noop"],
  });
  answerFor("Scheduled automation", {
    summary: "Looked at the clock.",
    confidence: 1,
    actions: [{ do: "noop" }],
  });
  await setPolicy({ review: "never" });
  // The clock's own test: the run goes ahead unattended.
  await store.writeRules([scheduled]);
  await store.writeSchedule([
    { ruleId: scheduled.id, at: new Date(Date.now() - 60_000).toISOString() },
  ]);

  await claimFor();
  await executor.runDueSchedules(GROUP);

  const jobs = await jobsOf("every-five");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.state, "done");
  assert.equal(jobs[0]!.trigger.on, "schedule");
  const schedule = await store.readSchedule();
  const entry = schedule?.doc.find((candidate) => candidate.ruleId === scheduled.id);
  assert.ok(
    entry && Date.parse(entry.at) > Date.now(),
    "the entry moved into the future",
  );
});

/**
 * What a fire the account's lock defers does, and what runs it.
 *
 * A timer fires on its own clock, so it reaches the account through the same
 * lock a poll or a push does: when the account is busy the work does not run and
 * the lock says so. What must not follow is the arming. The entry is still due
 * in the document and the timer armed for it is spent, and a timer armed for an
 * instant that has already arrived fires in the tick it was armed, is deferred
 * again, and turns the schedule into a request loop against the account's own
 * documents. The reconcile that owns the account is what runs the entry, from
 * its own catch-up, and that catch-up is what arms the timers again.
 */
test("a fire the lock defers arms no timer, and the catch-up runs it", async () => {
  const scheduled = rule({
    id: "deferred-fire",
    trigger: { on: "schedule", everyMinutes: 5 },
    capabilities: ["noop"],
  });
  answerFor("Scheduled automation", {
    summary: "Looked at the clock.",
    confidence: 1,
    actions: [{ do: "noop" }],
  });
  await setPolicy({ review: "never" });
  // The clock's own test: the run goes ahead unattended.
  await store.writeRules([scheduled]);
  await claimFor();

  // The reads an arming makes, counted: a deferral that armed again would show
  // up here, whatever the timers around it then did.
  let rulesRead = 0;
  const realReadRules = AgentStore.prototype.readRules;
  AgentStore.prototype.readRules = async function (
    this: InstanceType<typeof AgentStore>,
  ) {
    rulesRead += 1;
    return realReadRules.call(this);
  };

  // The lock, as `withAccountLock` reports a busy account: the fire does not
  // run, and the caller is told which of the two happened.
  let attempts = 0;
  const guard: ScheduleGuard = async () => {
    attempts += 1;
    return "deferred";
  };
  // The clock the armer reads stands an hour past the plan's own: a agent plans
  // from the mail server's clock and arms its timers from this process's, so the
  // instant a plan was made against can have arrived by the time one is armed.
  const arming = { now: (): number => Date.now() + 60 * 60_000 };

  const dispose = await executor.armSchedule(GROUP, {
    maxDelayMs: 60_000,
    guard,
    timers: arming,
  });
  try {
    // The instant arrives while the account is busy: the entry is due in the
    // document, and nothing has moved it on — the fire that would have is the
    // one the lock defers.
    await store.writeSchedule([
      { ruleId: scheduled.id, at: new Date(Date.now() - 60_000).toISOString() },
    ]);
    const before = rulesRead;
    await sleep(400);
    assert.equal(attempts, 1, "the entry is fired once, and the lock defers it");
    assert.equal(rulesRead, before, "and the deferral arms nothing: nothing is read");
    assert.equal(
      (await jobsOf("deferred-fire")).length,
      0,
      "and no run happened: the entry is exactly where the deferral left it",
    );

    // The reconcile that owns the account is where the deferral leads, and its
    // catch-up reads the due runs back out of the document.
    const started = await executor.runDueSchedules(GROUP);
    assert.equal(started, 1, "the catch-up runs the fire the lock deferred");
    const jobs = await jobsOf("deferred-fire");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.state, "done");
    assert.equal(jobs[0]!.trigger.on, "schedule");
    const entry = (await store.readSchedule())?.doc.find(
      (candidate) => candidate.ruleId === scheduled.id,
    );
    assert.ok(
      entry && Date.parse(entry.at) > Date.now(),
      "and the entry it ran has moved on to its next occurrence",
    );

    // Back on the clock, and by that reconcile alone: the timer it armed fires,
    // the account is still busy, and it is deferred again — one attempt per
    // reconcile, not a loop.
    await sleep(400);
    assert.equal(attempts, 2, "the schedule is armed again, by the reconcile");
  } finally {
    dispose();
    AgentStore.prototype.readRules = realReadRules;
  }
});

test("pruning drops finished documents and keeps open ones", async () => {
  const open = rule({
    id: "still-open",
  });
  await setPolicy({ review: "always" });
  // This test is about a run that stops for a person, so the group says so.
  await store.writeRules([open]);
  await createMessage("An invoice that will wait for a person");
  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });
  const waiting = (await jobsOf("still-open"))[0];
  assert.equal(waiting?.state, "awaiting_approval");

  // The mock's clock is not injectable, so the cutoff is moved instead of the
  // documents: everything finished is older than a cutoff in the future.
  const removed = await executor.prune(GROUP, new Date(Date.now() + 60_000));
  assert.ok(removed > 0, "finished documents are dropped");
  const jobs = await store.listJobs();
  assert.ok(
    jobs.some((entry) => entry.doc.id === waiting!.id),
    "a job waiting on a person is not pruned",
  );
  const decisions = await store.listDecisions();
  assert.ok(
    decisions.every((entry) => entry.doc.state === "pending"),
    "only decided decisions go",
  );
});

async function postAs(from: string, text: string, replyTo: string): Promise<void> {
  await sleep(5);
  await postMessage(ctx, GROUP, from, text, replyTo);
}

async function submissionCount(): Promise<number> {
  const res = await client.call<{ total?: number }>(
    "EmailSubmission/query",
    { accountId: GROUP },
    [JMAP_SUBMISSION],
  );
  return res.total ?? 0;
}

test("an approval shows what the run would do, never why", async () => {
  /*
   * What a member answers in the group's chat (ADR 0003). The output is the
   * action and its parameters — the words it would post — and the model's
   * reasoning is not a thing the deciding call is asked for, so it is nowhere
   * in it.
   */
  const { proposalText } = await import("./executor.js");
  const rule = {
    v: 1,
    id: "r1",
    version: 1,
    enabled: true,
    trigger: { on: "chat" },
    instruction: "greet the group",
    capabilities: ["chat.post"],
  } as AgentRule;
  const job = {
    ...newJob({
      id: "j1",
      accountId: GROUP,
      rule: { id: "r1", version: 1 },
      trigger: { on: "chat", chatId: "c1", at: "2026-09-10T09:00:00Z" },
    }),
    proposal: {
      summary: "It would greet the group.",
      actions: [{ do: "chat.post", with: { text: "Hello all!" } }],
      confidence: 0.9,
    },
  } as AgentJob;
  const text = proposalText(rule, job);
  assert.match(text, /Hello all!/, "the words it would post are what is approved");
  assert.match(text, /Write in the chat/);
});

test("a run may look something up, and reads what it asked for", async () => {
  /*
   * ADR 0020. The deciding call answers with a lookup instead of actions, the
   * run reads the group's own mail and asks again: the answer that decides is
   * the second one, and the model that asked sees the messages it asked about
   * in front of it.
   */
  const starred = await createMessage("Starred invoice 42", "the invoice is unpaid");
  await client.call(
    "Email/set",
    { accountId: GROUP, update: { [starred]: { "keywords/$flagged": true } } },
    [JMAP_MAIL],
  );
  const heard = await createMessage("please label this one");
  const looker = rule({ id: "looker", capabilities: ["keyword.add"] });
  await store.writeRules([looker]);
  // The index first, then the one item it listed: a listing is cheap and a
  // read is bounded, so a broad question does not pay for every body.
  answerSequence("Mail automation", [
    { lookup: { kind: "mail", query: "is:starred" } },
    { lookup: { kind: "message", id: starred } },
    {
      summary: "Labelled it after reading the starred mail.",
      confidence: 1,
      actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
    },
  ]);
  const claim = await claimFor();
  const job = newJob({
    id: "lookup-job",
    accountId: GROUP,
    rule: { id: "looker", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, looker, claim);

  // The listing named the message and the read handed over its text: the last
  // call carries the body the run went and got.
  const followUp = calls[calls.length - 1];
  const user = JSON.stringify(followUp?.messages ?? []);
  assert.match(user, /Starred invoice 42/);
  assert.match(user, /the invoice is unpaid/);
  // And the answer that decided still ran.
  const after = await client.call<{
    list?: Array<{ keywords?: Record<string, boolean> }>;
  }>("Email/get", { accountId: GROUP, ids: [heard], properties: ["keywords"] }, [
    JMAP_MAIL,
  ]);
  assert.equal(after.list?.[0]?.keywords?.["G-processed"], true);
  // The job records what it read, so that is a question about a document.
  const written = await store.readJob("lookup-job");
  assert.deepEqual(written?.doc.lookups, [
    { kind: "mail", query: "is:starred" },
    { kind: "message", id: starred },
  ]);
});

test("a run reads the knowledge base through the knowledge lookup", async () => {
  /*
   * ADR 0024: the KB is a tail read like any other — a listing names the
   * articles, and one article's own text is read back by the id the listing
   * gave. It reads the group's own account and writes nothing.
   */
  await seedKnowledgeArticle(
    "k-quality",
    "Quality policy",
    "Measure twice and record every result.",
  );
  const heard = await createMessage("what does our quality policy say?");
  const looker = rule({ id: "kb-looker", capabilities: ["keyword.add"] });
  await store.writeRules([looker]);
  answerSequence("Mail automation", [
    { lookup: { kind: "knowledge", query: "quality" } },
    { lookup: { kind: "knowledge", id: "k-quality" } },
    {
      summary: "Read the quality policy.",
      confidence: 1,
      actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
    },
  ]);
  const claim = await claimFor();
  const job = newJob({
    id: "kb-lookup-job",
    accountId: GROUP,
    rule: { id: "kb-looker", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, looker, claim);

  const user = JSON.stringify(calls[calls.length - 1]?.messages ?? []);
  assert.match(user, /Quality policy/, "the listing named the article");
  assert.match(user, /k-quality/, "and the id the read names it by");
  assert.match(
    user,
    /Measure twice and record every result/,
    "and the read handed over the article's text",
  );
  const written = await store.readJob("kb-lookup-job");
  assert.deepEqual(written?.doc.lookups, [
    { kind: "knowledge", query: "quality" },
    { kind: "knowledge", id: "k-quality" },
  ]);
});

test("a run writes a knowledge base draft through knowledge.write", async () => {
  /*
   * ADR 0024 Q15/Q21: an agent drafts and never approves, so the action writes
   * the mutable `draft.json` and the article's `state.json` and leaves the
   * lifecycle untouched — no revision, no approval.
   */
  const heard = await createMessage("record the packing procedure");
  const writer = rule({ id: "kb-writer", capabilities: ["knowledge.write"] });
  await store.writeRules([writer]);
  answerSequence("Mail automation", [
    {
      summary: "Drafted the procedure.",
      confidence: 1,
      actions: [
        {
          do: "knowledge.write",
          with: {
            title: "Packing procedure",
            text: "Open the box and count the parts.",
          },
        },
      ],
    },
  ]);
  const claim = await claimFor();
  const job = newJob({
    id: "kb-write-job",
    accountId: GROUP,
    rule: { id: "kb-writer", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, writer, claim);

  const folder = knowledgeFolderName("Packing procedure");
  const draft = await readAppJsonAt(
    ctx,
    GROUP,
    `${KNOWLEDGE_FOLDER}/${folder}/${DRAFT_FILE}`,
  );
  if (!isKnowledgeDraft(draft)) assert.fail("the action created the article's draft");
  assert.equal(draft.title, "Packing procedure");
  assert.equal(draft.text, "Open the box and count the parts.");
  assert.equal(
    plainTextFromBlocks(draft.blocks),
    "Open the box and count the parts.",
    "the editor's blocks carry the text an agent wrote",
  );
  const state = await readAppJsonAt(
    ctx,
    GROUP,
    `${KNOWLEDGE_FOLDER}/${folder}/${STATE_FILE}`,
  );
  if (!isKnowledgeState(state)) assert.fail("the article's lifecycle pointer was minted");
  assert.equal(state.inForce, null, "the action drafts and never approves");
});

test("knowledge.write updates a draft without erasing its body or undoing an approval", async () => {
  /*
   * The data-loss edge ADR 0024 Q15/Q21 has to keep: an update by folder
   * rewrites the draft but preserves the article's identity and creation stamp,
   * mints the editor's blocks from the new text so the body is not emptied, and
   * carries the lifecycle over untouched — an agent never un-approves an issued
   * article, and never mints a revision.
   */
  const id = "k-issued";
  const title = "Issued procedure";
  const folder = knowledgeFolderName(title);
  const at = new Date().toISOString();
  const path = `${KNOWLEDGE_FOLDER}/${folder}`;
  const issued = {
    revision: "r-1",
    effectiveAt: at,
    approvedBy: "demo@example.com",
    approvedAt: at,
    rev: 1,
    title,
    tags: ["iso"],
  };
  await writeAppFileAt(
    ctx,
    GROUP,
    `${path}/${DRAFT_FILE}`,
    buildDraft({
      id,
      title,
      tags: ["iso"],
      blocks: [],
      text: "old body",
      by: AGENT,
      at,
    }),
  );
  await writeAppFileAt(
    ctx,
    GROUP,
    `${path}/${STATE_FILE}`,
    buildState({ id, title, tags: ["iso"], by: AGENT, at, inForce: issued }),
  );

  const heard = await createMessage("update the issued procedure");
  const writer = rule({ id: "kb-updater", capabilities: ["knowledge.write"] });
  await store.writeRules([writer]);
  answerSequence("Mail automation", [
    {
      summary: "Updated the procedure.",
      confidence: 1,
      actions: [{ do: "knowledge.write", with: { folder, title, text: "new body" } }],
    },
  ]);
  const claim = await claimFor();
  const job = newJob({
    id: "kb-update-job",
    accountId: GROUP,
    rule: { id: "kb-updater", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, writer, claim);

  const draft = await readAppJsonAt(ctx, GROUP, `${path}/${DRAFT_FILE}`);
  if (!isKnowledgeDraft(draft)) assert.fail("the draft survived the update");
  assert.equal(draft.id, id, "the article keeps its identity");
  assert.equal(draft.created.at, at, "and its creation stamp");
  assert.equal(draft.text, "new body");
  assert.equal(
    plainTextFromBlocks(draft.blocks),
    "new body",
    "the update replaced the body rather than emptying it",
  );
  const state = await readAppJsonAt(ctx, GROUP, `${path}/${STATE_FILE}`);
  if (!isKnowledgeState(state)) assert.fail("the lifecycle survived the update");
  assert.deepEqual(
    state.inForce,
    issued,
    "the approval is not undone by an agent's write",
  );
  assert.equal(
    await findFolderPath(ctx, GROUP, `${path}/${REVISIONS_FOLDER}`),
    null,
    "the action never creates a revision",
  );
});

test("a multi-page change is applied as a plan and a review is kept on the job", async () => {
  /*
   * ADR 0024 Q23: a multi-document change and a consistency check are the
   * fleet's, and their record lives on the run's own job — one entry per page
   * with its outcome, and the review's prose. Nothing is written to the KB by
   * the review.
   */
  const heard = await createMessage("align the two procedures");
  const writer = rule({
    id: "kb-planner",
    capabilities: ["knowledge.write", "knowledge.review"],
  });
  await store.writeRules([writer]);
  answerSequence("Mail automation", [
    {
      summary: "Aligned two pages and recorded a review.",
      confidence: 1,
      actions: [
        { do: "knowledge.write", with: { title: "Procedure A", text: "body A" } },
        { do: "knowledge.write", with: { title: "Procedure B", text: "body B" } },
        {
          do: "knowledge.review",
          with: { findings: "A and B disagree on the retention period." },
        },
      ],
    },
  ]);
  const claim = await claimFor();
  const job = newJob({
    id: "kb-plan-job",
    accountId: GROUP,
    rule: { id: "kb-planner", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, writer, claim);

  const written = await store.readJob("kb-plan-job");
  const pages = written?.doc.plan?.pages ?? [];
  assert.equal(pages.length, 2, "the plan recorded one entry per page");
  assert.deepEqual(
    pages.map((p) => p.outcome),
    ["created", "created"],
    "and each page's outcome",
  );
  assert.match(
    String(written?.doc.findings?.[0] ?? ""),
    /retention period/,
    "the review's findings are on the job",
  );
});

test("a page that moved since the plan was read is refused, not overwritten", async () => {
  // The plan names the draft it was built from; a page edited since is refused,
  // and the outcome says which one and why (ADR 0024).
  await seedKnowledgeArticle("k-moving", "Moving target", "original");
  const heard = await createMessage("update the moving target");
  const writer = rule({ id: "kb-mover", capabilities: ["knowledge.write"] });
  await store.writeRules([writer]);
  answerSequence("Mail automation", [
    {
      summary: "Update it.",
      confidence: 1,
      actions: [
        {
          do: "knowledge.write",
          with: {
            folder: knowledgeFolderName("Moving target"),
            title: "Moving target",
            text: "new body",
            basedOn: "2000-01-01T00:00:00.000Z",
          },
        },
      ],
    },
  ]);
  const claim = await claimFor();
  const job = newJob({
    id: "kb-move-job",
    accountId: GROUP,
    rule: { id: "kb-mover", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, writer, claim);

  const folder = knowledgeFolderName("Moving target");
  const draft = await readAppJsonAt(
    ctx,
    GROUP,
    `${KNOWLEDGE_FOLDER}/${folder}/${DRAFT_FILE}`,
  );
  if (!isKnowledgeDraft(draft)) assert.fail("the draft is still there");
  assert.equal(
    draft.text,
    "original",
    "a page that moved under the plan is not overwritten",
  );
  const written = await store.readJob("kb-move-job");
  assert.equal(written?.doc.plan?.pages?.[0]?.outcome, "moved");
});

test("a run that would rather keep looking than decide is stopped by the bound", async () => {
  // The loop is finite because the run says so, not because the model stops: a
  // model that answers with a lookup every time meets the last call, which
  // carries none, and the refusal is the run's own (ADR 0020). It fails the way
  // any malformed answer does — retryable, because the next pass may decide.
  const heard = await createMessage("a message to decide about");
  const looker = rule({ id: "greedy", capabilities: ["keyword.add"] });
  await store.writeRules([looker]);
  answerSequence("Mail automation", [{ lookup: { kind: "mail" } }]);
  const claim = await claimFor();
  const job = newJob({
    id: "greedy-job",
    accountId: GROUP,
    rule: { id: "greedy", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, looker, claim);

  const written = await store.readJob("greedy-job");
  assert.notEqual(written?.doc.state, "done", "nothing was decided");
  assert.match(String(written?.doc.error), /no lookups left/);
  assert.equal(
    asked.filter((label) => label === "Mail automation").length,
    AGENT_LOOKUP_ROUNDS + 1,
    "the run asks once per lookup and once with the budget spent",
  );
});

/*
 * What a failure is allowed to do next (ADR 0003 resolution 20). A retry is
 * safe for work that stayed inside the group's own state and dangerous for
 * anything that left the process: a second pass either repeats an effect
 * nobody can take back or runs a plan nobody approved.
 */
test("a whole-tree file listing answers which file is where", async () => {
  /*
   * ADR 0020: "which file is in the wrong folder" is a question about the shape
   * of the tree, so a `files` listing with `deep` walks it — bounded — and a run
   * does not ask a person to open it folder by folder. The group's private app
   * folder is not part of it.
   */
  await writeBytesIntoVisibleFolder(
    ctx,
    GROUP,
    "Deliveries/MS2",
    "packing-list.txt",
    new TextEncoder().encode("ok"),
    "text/plain",
  );
  const heard = await createMessage("where is the packing list?");
  const looker = rule({ id: "tree", capabilities: ["keyword.add"] });
  await store.writeRules([looker]);
  answerSequence("Mail automation", [
    { lookup: { kind: "files", deep: true } },
    {
      summary: "Looked at the tree.",
      confidence: 1,
      actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
    },
  ]);
  const claim = await claimFor();
  const job = newJob({
    id: "tree-job",
    accountId: GROUP,
    rule: { id: "tree", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, looker, claim);

  const user = JSON.stringify(calls[calls.length - 1]?.messages ?? []);
  assert.match(
    user,
    /Deliveries\/MS2\/packing-list\.txt/,
    "the path is in the tree the run was handed",
  );
  assert.equal(
    /-\s*gilbert \(folder\)/.test(user),
    false,
    "the group's own app folder is not a place in its Files",
  );
});

test("a whole-tree listing past its bound says so", async () => {
  /*
   * The listing is bounded (`AGENT_LOOKUP_FILES_MAX`). A bound reached with the
   * tree not exhausted must read as "more entries", never as a complete list a
   * run then trusts: a `truncated` computed before the walk is always false and
   * hides the rest of the tree (ADR 0020).
   */
  for (let i = 0; i < 200; i++)
    await writeBytesIntoVisibleFolder(
      ctx,
      GROUP,
      "BulkA",
      `f-${String(i).padStart(3, "0")}.txt`,
      new TextEncoder().encode("x"),
      "text/plain",
    );
  await writeBytesIntoVisibleFolder(
    ctx,
    GROUP,
    "BulkB",
    "last.txt",
    new TextEncoder().encode("x"),
    "text/plain",
  );
  const heard = await createMessage("list everything");
  const bulk = rule({ id: "bulk", capabilities: ["keyword.add"] });
  await store.writeRules([bulk]);
  answerSequence("Mail automation", [
    { lookup: { kind: "files", deep: true } },
    {
      summary: "Listed the tree.",
      confidence: 1,
      actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
    },
  ]);
  const claim = await claimFor();
  const job = newJob({
    id: "bulk-job",
    accountId: GROUP,
    rule: { id: "bulk", version: 1 },
    trigger: { on: "email", emailId: heard, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, bulk, claim);

  const user = JSON.stringify(calls[calls.length - 1]?.messages ?? []);
  assert.match(
    user,
    /more than 200 entries/,
    "a listing that stopped at its bound says it is bounded",
  );
});

test("a failure that could have sent mail is not retried", async () => {
  const sender = rule({
    id: "sender",
    actions: [{ do: "mail.send", with: { to: ADA, subject: "x", text: "y" } }],
    capabilities: ["mail.send"],
  });
  await store.writeRules([sender]);
  const emailId = await createMessage("An invoice that would have been mailed");
  const job = newJob({
    id: "sender-job",
    accountId: GROUP,
    rule: { id: "sender", version: 1 },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  const planned: AgentJob = {
    ...job,
    attempts: 1,
    state: "running",
    proposal: {
      summary: "send the reply",
      actions: [{ do: "mail.send", with: { to: ADA, text: "y" } }],
      confidence: 0.95,
      draft: null,
    },
  };
  await store.writeJob(planned);

  await executor.failLoudly(store, planned, sender, "the submission was refused");

  const after = await store.readJob("sender-job");
  assert.equal(
    after?.doc.state,
    "failed",
    "a second pass would send again — or send a message nobody approved",
  );
  assert.equal(
    after?.doc.nextAttemptAt,
    undefined,
    "there is no next attempt for a plan that reaches outside",
  );
});

test("a failure that stayed inside the group waits before trying again", async () => {
  const internal = rule({ id: "internal" });
  await store.writeRules([internal]);
  const emailId = await createMessage("An invoice for an internal retry");
  const job = newJob({
    id: "internal-job",
    accountId: GROUP,
    rule: { id: "internal", version: 1 },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  const planned: AgentJob = {
    ...job,
    attempts: 1,
    state: "running",
    proposal: {
      summary: "label it",
      actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
      confidence: 1,
      draft: null,
    },
  };
  await store.writeJob(planned);

  await executor.failLoudly(store, planned, internal, "the store was busy");

  const waiting = await store.readJob("internal-job");
  assert.equal(waiting?.doc.state, "pending", "a retry stays pending for a later pass");
  const due = Date.parse(String(waiting?.doc.nextAttemptAt));
  assert.ok(
    due > Date.now(),
    "the next attempt is in the future: three attempts back to back are one attempt",
  );

  // And the sweep respects the wait instead of burning the attempts at once.
  const ran = await executor.runPending(GROUP, ["mail"]);
  const still = await store.readJob("internal-job");
  assert.equal(still?.doc.attempts, 1, "a job inside its backoff is not run");
  assert.equal(typeof ran, "number");
});

test("a run nobody came back for is closed as a timeout, not a failure", async () => {
  const abandoned = rule({ id: "abandoned" });
  await store.writeRules([abandoned]);
  const emailId = await createMessage("An invoice for an abandoned run");
  const job = newJob({
    id: "abandoned-job",
    accountId: GROUP,
    rule: { id: "abandoned", version: 1 },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  await store.writeJob({
    ...job,
    state: "running",
    attempts: JOB_MAX_ATTEMPTS,
    lease: {
      owner: "a-agent-that-died",
      heartbeatAt: new Date(Date.now() - 10 * LEASE).toISOString(),
    },
  });

  await executor.runPending(GROUP, ["mail"]);

  const closed = await store.readJob("abandoned-job");
  assert.equal(
    closed?.doc.state,
    "failed",
    "an abandoned run does not stay open forever",
  );
  assert.match(
    String(closed?.doc.error),
    /no agent came back/,
    "the reason names what happened: nobody reported a failure",
  );
  const audit = await store.readAuditAt(new Date());
  assert.ok(
    audit?.entries.some((e) => e.jobId === "abandoned-job" && e.outcome === "timeout"),
    "the trail distinguishes a timeout from a failure",
  );
});

test("a run whose agent died is taken up again by the next pass", async () => {
  const resume = rule({ id: "resume" });
  await store.writeRules([resume]);
  const emailId = await createMessage("An invoice to resume");
  const job = newJob({
    id: "resume-job",
    accountId: GROUP,
    rule: { id: "resume", version: 1 },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  await store.writeJob({
    ...job,
    state: "running",
    attempts: 1,
    lease: {
      owner: "the-agent-that-died",
      heartbeatAt: new Date(Date.now() - 10 * LEASE).toISOString(),
    },
  });

  await claimFor();
  await executor.runPending(GROUP, ["mail"]);

  const after = await store.readJob("resume-job");
  assert.equal(
    after?.doc.state,
    "done",
    "a crash mid-run is recoverable: the next pass finishes the work",
  );
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-processed"],
    true,
    "and the effect the run was for actually landed",
  );
});

test("a sweep leaves a job whose unit is somebody else's alone", async () => {
  const fenced = rule({ id: "fenced" });
  await store.writeRules([fenced]);
  const emailId = await createMessage("An invoice only one agent may run");
  const job = newJob({
    id: "fenced-job",
    accountId: GROUP,
    rule: { id: "fenced", version: 1 },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  await store.writeJob({
    ...job,
    state: "running",
    attempts: 1,
    lease: {
      owner: "the-agent-that-died",
      heartbeatAt: new Date(Date.now() - 10 * LEASE).toISOString(),
    },
  });
  // The sweep may take up what a dead agent left **only** for a unit this
  // agent holds: with the claim in another agent's hands, the run is the
  // double execution the fence exists to stop (resolution 18). The takeover is
  // a process starting after the claim was taken, which is how a successor
  // arrives.
  const taken = await claimAccount(store, "another-agent", {
    now: new Date(Date.now() + 10 * LEASE),
    startedAt: new Date(Date.now() + 10 * LEASE),
  });
  assert.ok(taken, "another agent holds mail now");

  await executor.runPending(GROUP, ["mail"]);

  const untouched = await store.readJob("fenced-job");
  assert.equal(
    untouched?.doc.state,
    "running",
    "a agent that does not hold the unit does not run its jobs",
  );
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-processed"],
    undefined,
    "and nothing left the process",
  );

  // The claim is a fixture: a test that leaves the unit in another agent's
  // hands would decide the tests that come after it.
  await claimAccount(store, WORKER, {
    now: new Date(Date.now() + 20 * LEASE),
    startedAt: new Date(Date.now() + 20 * LEASE),
  });
});

test("an approval on a rule that moved on is refused, and the answer is spoken", async () => {
  const movedOn = rule({
    id: "moved-on",
  });
  await setPolicy({ review: "always" });
  // This test is about a run that stops for a person, so the group says so.
  await store.writeRules([movedOn]);
  const emailId = await createMessage("An invoice approved too late");
  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const job = (await jobsOf("moved-on")).find(
    (candidate) => candidate.trigger.emailId === emailId,
  );
  assert.ok(job);
  assert.equal(job.state, "awaiting_approval");
  const decision = (await store.readDecision(String(job.decisionId)))?.doc;
  assert.ok(decision);

  // The rule is edited while the person is holding the answer: the job pins a
  // version nobody approved in that form any more (resolution 21, Decision §4).
  await store.writeRules([{ ...movedOn, version: 2 }]);

  await executor.resolveApproval(GROUP, decision, true, ADA);

  const refused = await store.readJob(String(job.id));
  assert.equal(refused?.doc.state, "failed");
  assert.match(String(refused?.doc.error), /pins rule version 1/);
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-processed"],
    undefined,
    "not one action of the approved plan ran",
  );
  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    chat.some((message) => message.text.includes("version nobody approved")),
    "and the person who answered is told why their answer did nothing",
  );
});

test("a group carrying two automations on one trigger is refused, and told why", async () => {
  /*
   * One enabled automation per trigger is a rule of the product (ADR 0006), and
   * the fan-out is what it exists for: this pass starts a job for every enabled
   * automation on the trigger, so a group with two of them answers one arrival
   * twice. The save guard is the enforcer; a document written by hand, or
   * restored from a backup, reaches the executor anyway — and a person has to
   * hear about it rather than read two replies to one message.
   */
  const first = rule({ id: "double-a" });
  const second = rule({ id: "double-b" });
  await store.writeRules([first, second]);
  await createMessage("An invoice two automations would both read");
  const chatBefore = (await readChat(ctx, GROUP, client)).length;

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    chat.length > chatBefore,
    "the group is told, rather than reading two replies to one message",
  );
  assert.ok(
    chat.some((message) => message.text.includes("leave one enabled per trigger")),
    "and the sentence names what to do about it",
  );
  const line = logLines.find((entry) => entry.includes("leave one enabled per trigger"));
  assert.ok(line, "and the log carries it too, for whoever reads the log");
});

test("an extraction that fails is not retried, because it leaves a file behind", async () => {
  // The same failure twice is a second extraction beside the first, so the plan
  // is dead-lettered rather than repeated (resolution 20).
  const extractor = rule({
    id: "extract",
    actions: [{ do: "mail.extract", with: { folder: "invoices" } }],
    capabilities: ["mail.extract"],
  });
  const proposal = {
    summary: "save the attachments",
    actions: [{ do: "mail.extract", with: { folder: "invoices" } }],
    confidence: 1,
  };
  const job = {
    ...newJob({
      id: "extract-job",
      accountId: GROUP,
      rule: { id: "extract", version: 1 },
      trigger: { on: "email", emailId: "gone", at: new Date().toISOString() },
    }),
    state: "running" as const,
    attempts: 1,
    proposal,
  };
  await store.writeJob(job);

  await executor.failLoudly(
    store,
    job,
    extractor,
    "the second attachment could not be fetched",
  );

  const failed = await store.readJob("extract-job");
  assert.equal(
    failed?.doc.state,
    "failed",
    "a run that leaves a file behind is final, not retried",
  );
  assert.equal(failed?.doc.nextAttemptAt, undefined);
});

/*
 * The two ways a run is stopped before it has an effect: the draft a paused run
 * prepares passes the same fence as the plan's own actions, and a rules document
 * nobody can read is recorded instead of being taken for no automation.
 */

test("a paused run whose unit was taken over leaves no draft", async () => {
  // The draft is the one effect a paused run has, and it is an effect in a
  // mailbox the group shares: a run whose claim a successor took must not leave
  // one beside the draft that successor is preparing (ADR 0003, resolution
  // 20). The fence is asked before the action, the same hook the plan's own
  // actions are fenced by.
  const proposing = rule({
    id: "draft-on-approval",
    capabilities: ["mail.draft"],
  });
  answerFor("Mail automation", {
    summary: "Drafted a reply.",
    confidence: 1,
    actions: [
      { do: "mail.draft", with: { to: ADA, subject: "Re: invoice", text: "Filed." } },
    ],
  });
  await setPolicy({ review: "always" });
  // This test is about a run that stops for a person, so the group says so.
  await store.writeRules([proposing]);
  const emailId = await createMessage("An invoice that would be drafted for approval");
  const claim = await claimFor();
  const job = newJob({
    id: "draft-job",
    accountId: GROUP,
    rule: { id: "draft-on-approval", version: 1 },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  await store.writeJob(job);

  const before = await draftsInDrafts();
  // The unit moves to a successor after the fence every run passes before it
  // starts working: the first read is this agent's, everything read after it
  // belongs to the agent that took over.
  const real = AgentStore.prototype.readClaim;
  let reads = 0;
  AgentStore.prototype.readClaim = async function (
    this: InstanceType<typeof AgentStore>,
  ) {
    reads += 1;
    const held = await real.call(this);
    if (reads > 1 && held) return { ...held, doc: { ...held.doc, agent: "successor" } };
    return held;
  };
  try {
    await executor.runJob(GROUP, job, proposing, claim);
  } finally {
    AgentStore.prototype.readClaim = real;
  }

  const after = await store.readJob("draft-job");
  assert.equal(
    after?.doc.state,
    "failed",
    "a run that lost its unit ends loudly, not paused on a decision nobody can answer",
  );
  assert.match(String(after?.doc.error), /taken over/);
  assert.equal(after?.doc.proposal?.draft ?? null, null, "no draft is recorded either");
  assert.equal(
    await draftsInDrafts(),
    before,
    "and nothing landed in the group's Drafts mailbox",
  );
});

test("a rules document in an older shape is replaced, and the runs continue", async () => {
  // One malformed rule makes the whole document one this build cannot use, and
  // this build is its only writer: the read replaces it with an empty, current
  // document rather than stopping the group's work (ADR 0003).
  await writeAppFileAt(ctx, GROUP, "agent/rules.json", {
    v: 1,
    rules: [{ v: 1, id: "half", version: 1 }],
  });
  const jobsBefore = (await store.listJobs()).length;

  // The executor's own read is the one that replaces it.
  const ran = await executor.runPending(GROUP);
  assert.equal(ran, 0, "there is no automation to run");
  assert.deepEqual((await store.readRules())?.doc, [], "the document was replaced");

  const claim = await claimFor();
  await createMessage("An invoice arriving after the document was replaced");
  await executor.reconcile(GROUP, "Email", claim);

  const audit = await store.readAuditAt(new Date());
  const anomalies = (audit?.entries ?? []).filter(
    (entry) => entry.outcome === "failed" && entry.ruleId === "rules.json",
  );
  assert.equal(anomalies.length, 0, "there is no anomaly to report");
  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    !chat.some((message) =>
      message.text.includes("cannot read this group's automations"),
    ),
    "and the group is not told of a document that was replaced",
  );
  assert.equal((await store.listJobs()).length, jobsBefore, "and no job is opened");

  await store.writeRules([rule()]);
});

/** How many messages wait in the group's Drafts: what a paused run may not add to. */
async function draftsInDrafts(): Promise<number> {
  const mailboxId = await findMailboxByName(client, GROUP, "Drafts");
  assert.ok(mailboxId, "the group has a Drafts mailbox");
  const found = await client.call<{ total?: number }>(
    "Email/query",
    { accountId: GROUP, filter: { inMailbox: mailboxId } },
    [JMAP_MAIL],
  );
  return found.total ?? 0;
}

test("a job write carries the state it was read against, and a refusal writes nothing", async () => {
  const movedRule = rule({ id: "moved" });
  await store.writeRules([movedRule]);
  const emailId = await createMessage("An invoice that moves under the writer");
  const job = newJob({
    id: "moved-job",
    accountId: GROUP,
    rule: { id: movedRule.id, version: movedRule.version },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  await store.writeJob({ ...job, state: "running", attempts: 1 });
  const before = await store.readJob("moved-job");
  assert.ok(before, "the job document is there");

  // A store whose read hands back a state the account has already moved past:
  // that is a write landing in the window between the read a run makes and the
  // write it guards, which is the window a successor's write arrives in. The
  // failure is still reported — the trail and the chat are the report — but
  // nothing is written onto a document somebody else holds.
  const moved = Object.create(store) as AgentStore;
  moved.readJob = async (id: string) => {
    const found = await store.readJob(id);
    return found ? { ...found, state: `${found.state}-moved-past` } : null;
  };

  await executor.failLoudly(moved, before.doc, movedRule, "the provider was down");

  const untouched = await store.readJob("moved-job");
  assert.equal(
    untouched?.doc.state,
    "running",
    "a refused write leaves the document where its reader left it",
  );
  assert.equal(untouched?.doc.error, undefined, "and records no failure on it");
  const audit = await store.readAuditAt(new Date());
  assert.ok(
    audit?.entries.some((e) => e.jobId === "moved-job" && e.outcome === "failed"),
    "the failure is in the trail all the same",
  );

  // The control: the same call against a store whose token is current writes,
  // so what stopped above is the token and not the writer.
  await executor.failLoudly(store, before.doc, movedRule, "the provider was down");
  const written = await store.readJob("moved-job");
  assert.equal(written?.doc.state, "pending", "a write that still holds its state lands");
  assert.equal(written?.doc.error, "the provider was down");
});

test("an approval that was consumed and never ran is recorded, not left silent", async () => {
  const spent = rule({
    id: "spent-approval",
    actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
  });
  await store.writeRules([spent]);
  const emailId = await createMessage("An invoice a person approved");
  const job = newJob({
    id: "spent-job",
    accountId: GROUP,
    rule: { id: spent.id, version: spent.version },
    trigger: { on: "email", emailId, at: new Date().toISOString() },
  });
  const paused: AgentJob = {
    ...job,
    state: "awaiting_approval",
    proposal: {
      summary: "File the invoice",
      actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
      confidence: 1,
      draft: null,
    },
  };
  const decision = newDecision(paused);
  paused.decisionId = decision.id;
  await store.writeJob(paused);
  // The stamp every answer leaves, and the crash the process did not survive:
  // the decision is consumed, the job still waits on the person who answered,
  // and no runner is left holding it.
  const at = new Date().toISOString();
  await store.writeDecision({
    ...decision,
    state: "approved",
    decidedBy: ADA,
    decidedAt: at,
    appliedAt: at,
  });

  await executor.runPending(GROUP);

  const closed = await store.readJob("spent-job");
  assert.equal(closed?.doc.state, "failed", "the job the spent approval names is closed");
  assert.match(
    String(closed?.doc.error),
    /approved/,
    "and says the approval was consumed",
  );
  const audit = await store.readAuditAt(new Date());
  const reports = (audit?.entries ?? []).filter(
    (e) =>
      e.jobId === "spent-job" &&
      e.outcome === "failed" &&
      /no effect of it was ever recorded/.test(e.detail ?? ""),
  );
  assert.equal(reports.length, 1, "the trail carries the failure, with its reason");
  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    chat.some((message) => message.text.includes("Mail automation")),
    "the group's chat names the automation",
  );
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-needattention"],
    true,
    "the message it was about is marked for a person",
  );
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-processed"],
    undefined,
    "and nothing the approval asked for is run on a guess",
  );

  // Closed once: the next pass finds an approval that already has a record.
  await executor.runPending(GROUP);
  const again = ((await store.readAuditAt(new Date()))?.entries ?? []).filter(
    (e) =>
      e.jobId === "spent-job" && /no effect of it was ever recorded/.test(e.detail ?? ""),
  );
  assert.equal(again.length, 1, "a spent approval is recorded once, not every pass");
});

test("a run somebody asked for tells the group what it did", async () => {
  // The door a person comes through (ADR 0003). Every other trigger is the
  // group's own mail, chat or clock, and needs no announcement; a run somebody
  // asked for is a fact about the group's agent that its members should not
  // have to infer from a document they cannot open.
  const asked = rule({ id: "asked" });
  await store.writeRules([asked]);
  const emailId = await createMessage("An invoice somebody asked about");
  const job = newJob({
    id: "job-asked",
    accountId: GROUP,
    rule: asked,
    trigger: {
      on: "manual",
      emailId,
      by: "admin@example.org",
      at: new Date().toISOString(),
    },
  });
  await store.writeJob(job);

  await executor.runJob(GROUP, job, asked, await claimFor());

  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    chat.some(
      (message) =>
        message.text.includes("as asked") && message.text.includes("Add a label"),
    ),
    "the group reads what the run a person asked for did, in words rather than codes",
  );
});

test("a chain carries its lineage, and the run past the bound is refused loudly", async () => {
  /*
   * Two automations passing work along (ADR 0003): the first files what the
   * mail says, and the second wakes on the file it wrote, writes one of its own
   * and so wakes itself again. That cycle is the case the bound exists for — it
   * ends by itself, at the bound, with a line in the group's chat that says why.
   */
  const filer = rule({
    id: "chain-first",
    capabilities: ["file.write"],
  });
  const reader = rule({
    id: "chain-second",
    trigger: { on: "filenode" },
    capabilities: ["file.write"],
  });
  const writes = (name: string) => ({
    summary: "Wrote a note.",
    confidence: 1,
    actions: [{ do: "file.write", with: { folder: "Chain", name, text: "the note" } }],
  });
  answerFor("Mail automation", writes("first.txt"));
  answerFor("File automation", writes("again.txt"));

  // Where the agent has reconciled up to, anchored before this test's own mail
  // and files exist: what the passes below read is the chain this test made.
  const claim = await claimAnchoredOnTheAccount();
  await executor.reconcile(GROUP, "FileNode", claim);
  await store.writeRules([filer, reader]);

  const emailId = await createMessage("the chain starts here");
  await executor.reconcile(GROUP, "Email", claim);

  const first = (await jobsOf("chain-first")).find(
    (job) => job.trigger.emailId === emailId,
  );
  assert.ok(first, "the arrival opened a run for this message");
  assert.equal(first.trigger.hop, 1, "what wakes a rule by itself is hop one");
  assert.equal(
    first.trigger.parentJobId,
    undefined,
    "and it records no parent, because nothing woke it but the mail",
  );
  const readBefore = asked.filter((label) => label === "File automation").length;
  /*
   * The chat is the group's and this suite shares one account, so what "told
   * once" means here is one **new** line: another test's refusal is another
   * automation's, and counting the transcript's absolute total would make this
   * assertion depend on what ran before it.
   */
  const toldBefore = (await readChat(ctx, GROUP, client)).filter((message) =>
    message.text.includes("past 2 hops"),
  ).length;

  // The file changes, pass by pass: the run of each pass writes the file that
  // wakes the next one, up to the bound the installation set. The claim that
  // pass read from is kept, because reconciling it again reads the same change
  // a second time.
  let lastPass = await claimFor();
  for (let pass = 0; pass < 3; pass++) {
    lastPass = await claimFor();
    await executor.reconcile(GROUP, "FileNode", lastPass);
  }

  const chain = await jobsOf("chain-second");
  assert.deepEqual(
    chain.map((job) => job.trigger.hop),
    [2],
    "a run woken by another run's effect is one hop further, and two is the bound this installation set",
  );
  assert.deepEqual(
    chain.map((job) => job.trigger.parentJobId),
    [first.id],
    "each woken run records the job that woke it",
  );
  assert.equal(
    asked.filter((label) => label === "File automation").length - readBefore,
    1,
    "no run happens for the hop past the bound, so no model is asked about one",
  );

  /*
   * The trail is the group's month and this suite shares one account, so what
   * is counted here is this automation's own refusals: another test's refusal is
   * another automation's and says nothing about this one.
   */
  const audit = await store.readAuditAt(new Date());
  const refusals = (audit?.entries ?? []).filter(
    (entry) => entry.outcome === "refused" && entry.ruleId === "chain-second",
  );
  assert.equal(refusals.length, 1, "the refusal stands alone in the trail");
  assert.equal(refusals[0]!.ruleId, "chain-second");
  assert.match(
    String(refusals[0]!.detail),
    /File automation: .*past 2 hops/,
    "and names the automation and the bound it was refused past",
  );

  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    chat.some(
      (message) =>
        message.text.includes("File automation") && message.text.includes("past 2 hops"),
    ),
    "the group is told which automation could not run, and which bound it passed",
  );
  assert.ok(
    logLines.some(
      (line) => line.includes("File automation") && line.includes("past 2 hops"),
    ),
    "and the log carries the same line",
  );

  // One change read twice is one refusal: no job document remembers a refusal,
  // so the entry under the refusal's own subject is what makes this a no-op,
  // rather than a second line in the group's chat about the same change.
  await executor.reconcile(GROUP, "FileNode", lastPass);
  const reread = await store.readAuditAt(new Date());
  assert.equal(
    (reread?.entries ?? []).filter(
      (entry) => entry.outcome === "refused" && entry.ruleId === "chain-second",
    ).length,
    1,
    "the refusal is recorded once, however often the change is read",
  );
  assert.equal(
    (await readChat(ctx, GROUP, client)).filter((message) =>
      message.text.includes("past 2 hops"),
    ).length - toldBefore,
    1,
    "and the group is told once",
  );
});

test("a change somebody else made to a record a run wrote is hop one", async () => {
  /*
   * The lineage is the cause of the wake, not the record's last writer: a person
   * who writes a record a deep run once wrote makes a change of their own, and
   * the run that follows is theirs, at hop one — not the deep run's sixth hop.
   */
  const writes = (name: string) => ({
    summary: "Wrote a note.",
    confidence: 1,
    actions: [{ do: "file.write", with: { folder: "Deep", name, text: "the note" } }],
  });
  // No automation while the deep run's write is reported, so that pass only
  // records where it read up to.
  await store.writeRules([]);
  await executor.reconcile(GROUP, "FileNode", {
    ...(await claimFor()),
    states: {},
  });

  const nodeId = await writeBytesIntoVisibleFolder(
    ctx,
    GROUP,
    "Deep",
    "deep.txt",
    new TextEncoder().encode("deep"),
    "text/plain",
  );
  // A run five hops into its chain wrote that file, and its write is older than
  // the state the next pass reads from.
  const at = new Date(Date.now() - 60_000).toISOString();
  const deep = newJob({
    id: "deep-run",
    accountId: GROUP,
    rule: { id: "deep-rule", version: 1 },
    trigger: { on: "filenode", nodeId, hop: 5, at },
  });
  await store.writeJob({
    ...deep,
    state: "done",
    effects: [{ type: "FileNode", id: nodeId, at }],
  });
  // The pass that reports the deep run's own write, and reads past it.
  await executor.reconcile(GROUP, "FileNode", await claimFor());

  const watcher = rule({
    id: "watch-notes",
    trigger: { on: "filenode" },
    capabilities: ["file.write"],
  });
  answerFor("File automation", writes("from-the-watch.txt"));
  await store.writeRules([watcher]);
  // Somebody writes that file again: the change names a record a deep run wrote,
  // and the run it wakes is the person's.
  await writeBytesIntoVisibleFolder(
    ctx,
    GROUP,
    "Deep",
    "deep.txt",
    new TextEncoder().encode("a person edited this"),
    "text/plain",
  );
  await executor.reconcile(GROUP, "FileNode", await claimFor());

  const jobs = await jobsOf("watch-notes");
  assert.deepEqual(
    jobs.map((job) => job.trigger.hop),
    [1],
    "the change a person made wakes its rule at hop one",
  );
  assert.equal(jobs[0]!.trigger.parentJobId, undefined, "with no parent to name");
  const audit = (await store.readAuditAt(new Date()))?.entries ?? [];
  assert.equal(
    audit.filter((entry) => entry.outcome === "refused" && entry.ruleId === "watch-notes")
      .length,
    0,
    "and nothing is refused as a sixth hop of a chain nobody was in",
  );
});

test("an unrelated shallow write does not reset a chain's own depth", async () => {
  /*
   * A record's producer must be the deepest write inside the window, however
   * the writes are ordered in time: a producer that followed whichever write
   * landed latest would let an unrelated, shallow rule touching the same record
   * after a genuinely deep chain's own write make the next hop look shallower
   * than it really is — letting a chain evade `maxChainHops` by being
   * interleaved with an unrelated, frequently-firing rule.
   */
  await store.writeRules([]);
  await executor.reconcile(GROUP, "FileNode", {
    ...(await claimFor()),
    states: {},
  });

  const nodeId = await writeBytesIntoVisibleFolder(
    ctx,
    GROUP,
    "Attribution",
    "shared.txt",
    new TextEncoder().encode("shared"),
    "text/plain",
  );
  // A pass with no rules to run still reads past this creation, which is what
  // moves the window's anchor to here — after it, the two synthetic producers
  // below (dated relative to this same anchor, not to "now") are inside the
  // window the final pass reads from.
  await executor.reconcile(GROUP, "FileNode", await claimFor());
  const anchor = Date.parse((await store.readClaim())!.doc.statesAt?.FileNode ?? "");
  assert.ok(Number.isFinite(anchor), "the pass recorded when it last read this account");

  const deepAt = new Date(anchor + 1_000).toISOString();
  const shallowAt = new Date(anchor + 2_000).toISOString();
  const deep = newJob({
    id: "deep-two",
    accountId: GROUP,
    rule: { id: "deep-rule", version: 1 },
    trigger: { on: "filenode", nodeId, hop: 2, at: deepAt },
  });
  await store.writeJob({
    ...deep,
    state: "done",
    effects: [{ type: "FileNode", id: nodeId, at: deepAt }],
  });
  // Later in time than the deep run's own write, but shallower: an unrelated
  // rule that happened to touch the same file for reasons of its own.
  const shallow = newJob({
    id: "shallow-one",
    accountId: GROUP,
    rule: { id: "shallow-rule", version: 1 },
    trigger: { on: "filenode", nodeId, hop: 1, at: shallowAt },
  });
  await store.writeJob({
    ...shallow,
    state: "done",
    effects: [{ type: "FileNode", id: nodeId, at: shallowAt }],
  });

  const watcher = rule({
    id: "watch-attribution",
    trigger: { on: "filenode" },
    capabilities: ["file.write"],
  });
  answerFor("File automation", {
    summary: "Noted.",
    confidence: 1,
    actions: [
      { do: "file.write", with: { folder: "Attribution", name: "noted.txt", text: "x" } },
    ],
  });
  await store.writeRules([watcher]);
  // The bound is raised for this one pass: hop three is exactly what the
  // installation's ordinary bound of two would refuse, and this test is about
  // which hop is computed, not about the refusal itself (already covered
  // above).
  await installConfig({ maxChainHops: 5 });
  // The record changes once more for real: the wake this triggers must be
  // attributed to the deepest chain that produced it, not the latest write.
  await writeBytesIntoVisibleFolder(
    ctx,
    GROUP,
    "Attribution",
    "shared.txt",
    new TextEncoder().encode("changed again"),
    "text/plain",
  );
  try {
    await executor.reconcile(GROUP, "FileNode", await claimFor());
  } finally {
    await installConfig();
  }

  const jobs = await jobsOf("watch-attribution");
  assert.deepEqual(
    jobs.map((job) => job.trigger.hop),
    [3],
    "the deepest producer of the record explains the wake, not merely the latest one",
  );
  assert.equal(
    jobs[0]!.trigger.parentJobId,
    "deep-two",
    "and it names that deeper run as its parent, not the shallow one that wrote later",
  );
});

test("a job whose write no pass has read past is not pruned", async () => {
  /*
   * Retention is a window, and the run that wrote a record is what names the wake
   * of the change to it: dropping that document before a pass has read past the
   * write would reset the chain to hop one (ADR 0003). Once a pass has read past
   * it, the ordinary retention applies again.
   */
  const nodeId = await writeBytesIntoVisibleFolder(
    ctx,
    GROUP,
    "Kept",
    "kept.txt",
    new TextEncoder().encode("kept"),
    "text/plain",
  );
  const at = new Date().toISOString();
  const job = newJob({
    id: "kept-by-anchor",
    accountId: GROUP,
    rule: { id: "kept-rule", version: 1 },
    trigger: { on: "filenode", nodeId, hop: 2, at },
  });
  await store.writeJob({
    ...job,
    state: "done",
    effects: [{ type: "FileNode", id: nodeId, at }],
  });

  const retention = new Date(Date.now() + 60_000);
  await executor.prune(GROUP, retention);
  assert.ok(
    await store.readJob("kept-by-anchor"),
    "a finished run whose write the account has still to report is kept",
  );

  // The pass that reads past the write, and the ordinary retention with it.
  await executor.reconcile(GROUP, "FileNode", await claimFor());
  await executor.prune(GROUP, retention);
  assert.equal(
    await store.readJob("kept-by-anchor"),
    null,
    "and dropped once a pass has read past it",
  );
});

/**
 * What an installation without vision hands over, and what its runs are told.
 *
 * `GILBERT_AGENT_VISION=0` is the operator's statement about the model this
 * installation runs on, and the request has to follow it: a run told that a page
 * cannot be read here must not be carrying that page either.
 */
test("a run of an installation without vision carries no page, and is told so", async () => {
  const reader = rule({
    id: "read-the-scan",
    trigger: { on: "filenode" },
    capabilities: ["document.read", "noop"],
  });
  answerFor("File automation", {
    summary: "Read it.",
    confidence: 1,
    actions: [{ do: "noop" }],
  });
  // No automation is armed while the pass catches up, and the state it settles
  // on is the one the file written below is measured against.
  await store.writeRules([]);
  await executor.reconcile(GROUP, "FileNode", {
    ...(await claimFor()),
    states: {},
  });
  await store.writeRules([reader]);
  // One page with no text layer of its own: the page a model with eyes would be
  // handed as an image.
  await writeBytesIntoVisibleFolder(
    ctx,
    GROUP,
    "Scans",
    "letter.pdf",
    await blankPdf(1),
    "application/pdf",
  );
  await executor.reconcile(GROUP, "FileNode", await claimFor());

  const call = lastCallFor("filenode");
  const parts = userParts(call);
  assert.ok(
    parts.every((part) => part.type !== "image_url"),
    "no page travels to a model the installation says cannot read one",
  );
  assert.match(
    parts.map((part) => part.text ?? "").join(""),
    /configured without vision, so none of them can be read here/,
    "and the run is told it in words, rather than that a page was handed over",
  );
});

/**
 * The page bound a run is actually told it has.
 *
 * The number is stated in the prompt the run sends, not only in the function
 * that writes the prompt: a document of the installation's own bound is read to
 * that bound, the pages past it are said out loud rather than left as an
 * omission, and a document somebody wrote by hand past this build's ceiling is
 * held to the ceiling (ADR 0003).
 */
test("a run's prompt states the installation's page bound, clamped to this build's ceiling", async () => {
  const reader = rule({
    id: "page-budget",
    trigger: { on: "filenode" },
    capabilities: ["document.read", "noop"],
  });
  answerFor("File automation", {
    summary: "Read it.",
    confidence: 1,
    actions: [{ do: "noop" }],
  });
  await store.writeRules([]);
  await executor.reconcile(GROUP, "FileNode", {
    ...(await claimFor()),
    states: {},
  });
  await store.writeRules([reader]);

  try {
    await installConfig({ maxPages: 3 });
    await writeBytesIntoVisibleFolder(
      ctx,
      GROUP,
      "Budget",
      "five-pages.pdf",
      await blankPdf(5),
      "application/pdf",
    );
    await executor.reconcile(GROUP, "FileNode", await claimFor());
    const set = lastCallFor("filenode");
    assert.match(set.system, /At most 3 pages/, "the bound the installation set");
    assert.match(
      userParts(set)
        .map((part) => part.text ?? "")
        .join(""),
      /the last 2 pages of it were not read at all/,
      "and the pages past the bound are said rather than left as an omission",
    );

    // A document the installation's own surface would never have written: the
    // ceiling is this build's, and a run is held to it whatever the file says.
    await installConfig({ maxPages: 100 });
    await writeBytesIntoVisibleFolder(
      ctx,
      GROUP,
      "Budget",
      "clamped.pdf",
      await blankPdf(2),
      "application/pdf",
    );
    await executor.reconcile(GROUP, "FileNode", await claimFor());
    assert.match(
      lastCallFor("filenode").system,
      /At most 50 pages/,
      "a bound past the ceiling is held to the ceiling",
    );
  } finally {
    await installConfig();
  }
});
