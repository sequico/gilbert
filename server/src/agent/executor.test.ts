import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { after, before, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import type { AgentJob, AgentRule } from "./documents.js";

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

const PORT = 18845;
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
const { filesAccountId, writeAppFileAt, writeBytesIntoVisibleFolder } = await import(
  "../appFolder.js"
);
const { JMAP_MAIL, JMAP_SUBMISSION, JmapClient } = await import("../jmap.js");
const { GROUP_LABELS_FILE } = await import("../shared/labels.js");
const { fetchEmailRecord, findMailboxByName } = await import("./actions.js");
const { postMessage, readChat } = await import("./chat.js");
const { newDecision, newJob } = await import("./documents.js");
const { Executor, JOB_MAX_ATTEMPTS } = await import("./executor.js");
const { claimAccount } = await import("./lease.js");
const { AgentStore } = await import("./store.js");

const BASE = `http://127.0.0.1:${PORT}`;
/**
 * The model every run asks. There is one shape now and no tier that runs
 * without a model (ADR 0010), so a run reaches this stub or it does not run.
 *
 * The answer is keyed by the automation's name, which is the one thing the
 * prompt states about which rule is being decided, so a test that needs a
 * particular answer — a mail to send, a malformed action — states it for its
 * own rule instead of moving the answer for every other test.
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

function answerFor(name: string, value: unknown): void {
  answers.set(name, value);
}

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
  const answer = answers.get(named) ?? DEFAULT_ANSWER;
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
  workerId: WORKER,
  now: () => new Date(),
  log: (line) => logLines.push(line),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

function rule(overrides: Partial<AgentRule> = {}): AgentRule {
  return {
    v: 1,
    id: "file-invoices",
    version: 1,
    name: "File the invoices",
    enabled: true,
    trigger: { on: "email", filter: { subject: "invoice" } },
    review: { mode: "threshold", threshold: 0.9 },
    instruction: "Label the invoice so the group can file it.",
    capabilities: ["keyword.add"],
    ...overrides,
  };
}

async function claimFor() {
  const claim = await claimAccount(store, WORKER, { now: new Date(), leaseMs: LEASE });
  assert.ok(claim, "the worker holds the account");
  return claim;
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
async function installConfig(over: { maxPages?: number } = {}): Promise<void> {
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
    // (ADR 0010), and a build that read only the environment would run to five.
    maxChainHops: 2,
    ...over,
  });
}

/** The last call a run of this automation made, as the stub received it. */
function lastCallFor(name: string): ModelCall {
  const call = [...calls]
    .reverse()
    .find((entry) => entry.system.includes(`automation "${name}"`));
  assert.ok(call, `the run of "${name}" asked the model`);
  return call;
}

/** The parts of the user message: the text, and any image the data carried. */
function userParts(call: ModelCall): Array<{ type?: string; text?: string }> {
  const user = call.messages.find((message) => message.role === "user")?.content;
  if (typeof user === "string") return [{ type: "text", text: user }];
  return Array.isArray(user) ? (user as Array<{ type?: string; text?: string }>) : [];
}

/** A PDF of `pages` pages, none of which carries a text layer of its own. */
async function blankPdf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) document.addPage([300, 200]);
  return document.save();
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
  // The cost rides that entry, beside the work that spent it (ADR 0010), so the
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

test("a filter that does not match opens no job, and a rule without a filter matches", async () => {
  const strict = rule({
    id: "only-invoices",
    trigger: { on: "email", filter: { subject: "not in this message" } },
  });
  const loose = rule({ id: "everything", trigger: { on: "email" } });
  await store.writeRules([strict, loose]);
  await createMessage("A message nobody filters for");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  assert.equal((await jobsOf("only-invoices")).length, 0);
  assert.ok((await jobsOf("everything")).length >= 1);
});

test("a filter the executor cannot honour fails loudly instead of never firing", async () => {
  const broken = rule({
    id: "broken-filter",
    trigger: { on: "email", filter: { mood: "sunny" } },
  });
  await store.writeRules([broken]);

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const jobs = await jobsOf("broken-filter");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.state, "failed");
  assert.match(
    String(jobs[0]!.error),
    /uses "mood", which no matcher implements/,
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
    name: "Label wrongly",
    capabilities: ["keyword.add"],
  });
  answerFor("Label wrongly", {
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
    name: "Touch the message once",
    capabilities: ["noop"],
  });
  answerFor("Touch the message once", {
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
    name: "Ask before filing",
    review: { mode: "always" },
  });
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
    name: "Broken on purpose",
    capabilities: ["keyword.add"],
  });
  // The model answers with an action missing a parameter the catalogue
  // requires: the answer is refused before it can become an effect.
  answerFor("Broken on purpose", {
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
    name: "Reply to the invoice",
    review: { mode: "always" },
    capabilities: ["mail.draft", "mail.send"],
  });
  answerFor("Reply to the invoice", {
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
    name: "Reply and forget",
    review: { mode: "always" },
    capabilities: ["mail.draft", "mail.send"],
  });
  answerFor("Reply and forget", {
    summary: "Replied to the invoice.",
    confidence: 1,
    actions: [
      { do: "mail.draft", with: { to: ADA, subject: "Re: gone", text: "Hello." } },
      { do: "mail.send", with: { to: ADA } },
    ],
  });
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

test("a failure retries to a point and then dead-letters, telling the group", async () => {
  const flaky = rule({ id: "flaky", name: "Flaky automation" });
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
    name: "Every five minutes",
    trigger: { on: "schedule", everyMinutes: 5 },
    capabilities: ["noop"],
    review: { mode: "never" },
  });
  answerFor("Every five minutes", {
    summary: "Looked at the clock.",
    confidence: 1,
    actions: [{ do: "noop" }],
  });
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

test("pruning drops finished documents and keeps open ones", async () => {
  const open = rule({
    id: "still-open",
    name: "Still open",
    review: { mode: "always" },
  });
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

test("a folder slice is one header line per message, never a body", async () => {
  const { renderFolderSlice } = await import("./executor.js");
  const view = (id: string, subject: string, body: string) => ({
    id,
    subject,
    body,
    receivedAt: "2026-09-10T09:00:00Z",
    from: [{ name: "Ada", email: "ada@example.org" }],
  });
  const rendered = renderFolderSlice("Inbox", [view("e1", "Invoice 42", "pay me")]);
  assert.match(rendered, /FOLDER "Inbox" \(the 1 most recent\)/);
  assert.match(rendered, /ada@example\.org {2}Invoice 42/);
  assert.equal(
    rendered.includes("pay me"),
    false,
    "the slice names the mail; a run that needs it reads that message",
  );
  assert.equal(renderFolderSlice("Archive", []), 'FOLDER "Archive": no messages');
});

/*
 * What a failure is allowed to do next (ADR 0003 resolution 20). A retry is
 * safe for work that stayed inside the group's own state and dangerous for
 * anything that left the process: a second pass either repeats an effect
 * nobody can take back or runs a plan nobody approved.
 */
test("a failure that could have sent mail is not retried", async () => {
  const sender = rule({
    id: "sender",
    name: "Sender automation",
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
  const internal = rule({ id: "internal", name: "Internal automation" });
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
  const abandoned = rule({ id: "abandoned", name: "Abandoned automation" });
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
      owner: "a-worker-that-died",
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
    /no worker came back/,
    "the reason names what happened: nobody reported a failure",
  );
  const audit = await store.readAuditAt(new Date());
  assert.ok(
    audit?.entries.some((e) => e.jobId === "abandoned-job" && e.outcome === "timeout"),
    "the trail distinguishes a timeout from a failure",
  );
});

test("a run whose agent died is taken up again by the next pass", async () => {
  const resume = rule({ id: "resume", name: "Resume automation" });
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
      owner: "the-worker-that-died",
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
  const fenced = rule({ id: "fenced", name: "Fenced automation" });
  await store.writeRules([fenced]);
  const emailId = await createMessage("An invoice only one worker may run");
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
      owner: "the-worker-that-died",
      heartbeatAt: new Date(Date.now() - 10 * LEASE).toISOString(),
    },
  });
  // The sweep may take up what a dead worker left **only** for a unit this
  // worker holds: with the claim in another worker's hands, the run is the
  // double execution the fence exists to stop (resolution 18). The takeover is
  // dated past the holder's lease, which is how a successor arrives.
  const taken = await claimAccount(store, "another-worker", {
    now: new Date(Date.now() + 10 * LEASE),
    leaseMs: LEASE,
  });
  assert.ok(taken, "another worker holds mail now");

  await executor.runPending(GROUP, ["mail"]);

  const untouched = await store.readJob("fenced-job");
  assert.equal(
    untouched?.doc.state,
    "running",
    "a worker that does not hold the unit does not run its jobs",
  );
  const marked = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal(
    (marked?.keywords as Record<string, unknown>)?.["G-processed"],
    undefined,
    "and nothing left the process",
  );

  // The claim is a fixture: a test that leaves the unit in another worker's
  // hands would decide the tests that come after it.
  await claimAccount(store, WORKER, {
    now: new Date(Date.now() + 20 * LEASE),
    leaseMs: LEASE,
  });
});

test("an approval on a rule that moved on is refused, and the answer is spoken", async () => {
  const movedOn = rule({
    id: "moved-on",
    name: "Approved too late",
    review: { mode: "always" },
  });
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

test("a filter the form refuses is refused when it runs too", async () => {
  // A group with no conditions is not a filter: `AND` over nothing is true, so
  // a rule written that way quietly matches every message in the account. The
  // form refuses it; a rule that reached storage by another road has to be
  // refused when it runs as well, or the refusal is a formality.
  const empty = rule({
    id: "empty-group",
    name: "An empty group",
    trigger: { on: "email", filter: { operator: "AND", conditions: [] } },
  });
  await store.writeRules([empty]);
  await createMessage("An invoice the empty group would match");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor()), states: {} });

  const jobs = await jobsOf("empty-group");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.state, "failed");
  assert.match(String(jobs[0]!.error), /has none/);
});

test("an extraction that fails is not retried, because it leaves a file behind", async () => {
  // The same failure twice is a second extraction beside the first, so the plan
  // is dead-lettered rather than repeated (resolution 20).
  const extractor = rule({
    id: "extract",
    name: "Save the attachments",
    actions: [{ do: "mail.extract", with: { folder: "invoices" } }],
    capabilities: ["mail.extract"],
    review: { mode: "never" },
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
  // one beside the draft that successor is preparing (ADR 0003 §6, resolution
  // 20). The fence is asked before the action, the same hook the plan's own
  // actions are fenced by.
  const proposing = rule({
    id: "draft-on-approval",
    name: "Ask before replying",
    review: { mode: "always" },
    capabilities: ["mail.draft"],
  });
  answerFor("Ask before replying", {
    summary: "Drafted a reply.",
    confidence: 1,
    actions: [
      { do: "mail.draft", with: { to: ADA, subject: "Re: invoice", text: "Filed." } },
    ],
  });
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
  // starts working: the first read is this worker's, everything read after it
  // belongs to the worker that took over.
  const real = AgentStore.prototype.readClaim;
  let reads = 0;
  AgentStore.prototype.readClaim = async function (
    this: InstanceType<typeof AgentStore>,
  ) {
    reads += 1;
    const held = await real.call(this);
    if (reads > 1 && held) return { ...held, doc: { ...held.doc, worker: "successor" } };
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

test("a rules document nobody can read stops the group's runs and says so", async () => {
  // One malformed rule invalidates the whole document, so every automation of
  // the group stops. A reader that answered "no rules" for it would stop the
  // group's work with no audit row and no word in the chat (ADR 0003, failure
  // paths: an unreadable document), and the reconcile would consume the changes
  // it never acted on.
  await writeAppFileAt(ctx, GROUP, "agent/rules.json", {
    v: 1,
    rules: [{ v: 1, id: "half", version: 1, name: "Half an automation" }],
  });
  const jobsBefore = (await store.listJobs()).length;

  const ran = await executor.runPending(GROUP);
  assert.equal(ran, 0, "not one job is run while the automation cannot be read");

  const claim = await claimFor();
  const anchor = claim.states.Email;
  await createMessage("An invoice arriving while the automation is unreadable");
  await executor.reconcile(GROUP, "Email", claim);

  const audit = await store.readAuditAt(new Date());
  const anomalies = (audit?.entries ?? []).filter(
    (entry) => entry.outcome === "failed" && entry.ruleId === "rules.json",
  );
  assert.equal(
    anomalies.length,
    1,
    "the trail carries the anomaly once per process, not once per pass",
  );
  assert.match(String(anomalies[0]?.detail), /does not read as a rules document/);
  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    chat.some((message) => message.text.includes("cannot read this group's automations")),
    "and the group is told why nothing of its automation runs",
  );
  assert.equal(
    (await store.readClaim())?.doc.states.Email,
    anchor,
    "the reconcile leaves the anchor where it is: changes it could not match are not consumed",
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
  const movedRule = rule({ id: "moved", name: "Moved automation" });
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
    name: "Spent approval",
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
    chat.some((message) => message.text.includes("Spent approval")),
    "the group's chat names the rule",
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
  // The door a person comes through (ADR 0010). Every other trigger is the
  // group's own mail, chat or clock, and needs no announcement; a run somebody
  // asked for is a fact about the group's agent that its members should not
  // have to infer from a document they cannot open.
  const asked = rule({ id: "asked", name: "Label on request" });
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
   * Two automations passing work along (ADR 0010): the first files what the
   * mail says, and the second wakes on the file it wrote, writes one of its own
   * and so wakes itself again. That cycle is the case the bound exists for — it
   * ends by itself, at the bound, with a line in the group's chat that says why.
   */
  const filer = rule({
    id: "chain-first",
    name: "Chain: file it",
    trigger: { on: "email", filter: { subject: "chain" } },
    capabilities: ["file.write"],
  });
  const reader = rule({
    id: "chain-second",
    name: "Chain: read it",
    trigger: { on: "filenode" },
    capabilities: ["file.write"],
  });
  const writes = (name: string) => ({
    summary: "Wrote a note.",
    confidence: 1,
    actions: [{ do: "file.write", with: { folder: "Chain", name, text: "the note" } }],
  });
  answerFor("Chain: file it", writes("first.txt"));
  answerFor("Chain: read it", writes("again.txt"));

  // The FileNode state the worker has reconciled up to is anchored before this
  // test's own files exist, so the passes below see the chain and nothing else.
  await executor.reconcile(GROUP, "FileNode", {
    ...(await claimFor()),
    states: {},
  });
  await store.writeRules([filer, reader]);

  await createMessage("the chain starts here");
  await executor.reconcile(GROUP, "Email", await claimFor());

  const first = (await jobsOf("chain-first")).at(-1);
  assert.ok(first, "the arrival opened a run");
  assert.equal(first.trigger.hop, 1, "what wakes a rule by itself is hop one");
  assert.equal(
    first.trigger.parentJobId,
    undefined,
    "and it records no parent, because nothing woke it but the mail",
  );
  const readBefore = asked.filter((name) => name === "Chain: read it").length;

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
    asked.filter((name) => name === "Chain: read it").length - readBefore,
    1,
    "no run happens for the hop past the bound, so no model is asked about one",
  );

  const audit = await store.readAuditAt(new Date());
  const refusals = (audit?.entries ?? []).filter((entry) => entry.outcome === "refused");
  assert.equal(refusals.length, 1, "the refusal stands alone in the trail");
  assert.equal(refusals[0]!.ruleId, "chain-second");
  assert.match(
    String(refusals[0]!.detail),
    /Chain: read it: .*past 2 hops/,
    "and names the automation and the bound it was refused past",
  );

  const chat = await readChat(ctx, GROUP, client);
  assert.ok(
    chat.some(
      (message) =>
        message.text.includes("Chain: read it") && message.text.includes("past 2 hops"),
    ),
    "the group is told which automation could not run, and which bound it passed",
  );
  assert.ok(
    logLines.some(
      (line) => line.includes("Chain: read it") && line.includes("past 2 hops"),
    ),
    "and the log carries the same line",
  );

  // One change read twice is one refusal: no job document remembers a refusal,
  // so the entry under the refusal's own subject is what makes this a no-op,
  // rather than a second line in the group's chat about the same change.
  await executor.reconcile(GROUP, "FileNode", lastPass);
  const reread = await store.readAuditAt(new Date());
  assert.equal(
    (reread?.entries ?? []).filter((entry) => entry.outcome === "refused").length,
    1,
    "the refusal is recorded once, however often the change is read",
  );
  assert.equal(
    (await readChat(ctx, GROUP, client)).filter((message) =>
      message.text.includes("past 2 hops"),
    ).length,
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
    name: "Watch the notes",
    trigger: { on: "filenode" },
    capabilities: ["file.write"],
  });
  answerFor("Watch the notes", writes("from-the-watch.txt"));
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

test("a job whose write no pass has read past is not pruned", async () => {
  /*
   * Retention is a window, and the run that wrote a record is what names the wake
   * of the change to it: dropping that document before a pass has read past the
   * write would reset the chain to hop one (ADR 0010). Once a pass has read past
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
    name: "Read the scan",
    trigger: { on: "filenode" },
    capabilities: ["document.read", "noop"],
  });
  answerFor("Read the scan", {
    summary: "Read it.",
    confidence: 1,
    actions: [{ do: "noop" }],
  });
  // No automation is armed while the pass catches up, and the state it settles
  // on is the one the file written below is measured against.
  await store.writeRules([]);
  await executor.reconcile(GROUP, "FileNode", { ...(await claimFor()), states: {} });
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

  const call = lastCallFor("Read the scan");
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
 * held to the ceiling (ADR 0010).
 */
test("a run's prompt states the installation's page bound, clamped to this build's ceiling", async () => {
  const reader = rule({
    id: "page-budget",
    name: "Page budget",
    trigger: { on: "filenode" },
    capabilities: ["document.read", "noop"],
  });
  answerFor("Page budget", {
    summary: "Read it.",
    confidence: 1,
    actions: [{ do: "noop" }],
  });
  await store.writeRules([]);
  await executor.reconcile(GROUP, "FileNode", { ...(await claimFor()), states: {} });
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
    const set = lastCallFor("Page budget");
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
      lastCallFor("Page budget").system,
      /At most 50 pages/,
      "a bound past the ceiling is held to the ceiling",
    );
  } finally {
    await installConfig();
  }
});
