import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
 */

const PORT = 18845;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { writeAppFileAt } = await import("../appFolder.js");
const { JMAP_MAIL, JMAP_SUBMISSION, JmapClient } = await import("../jmap.js");
const { GROUP_LABELS_FILE } = await import("../shared/labels.js");
const { fetchEmailRecord } = await import("./actions.js");
const { postMessage, readChat } = await import("./chat.js");
const { newJob } = await import("./documents.js");
const { Executor } = await import("./executor.js");
const { claimArea } = await import("./lease.js");
const { AgentStore } = await import("./store.js");

const BASE = `http://127.0.0.1:${PORT}`;
const GROUP = "a3";
const AGENT = "gilbert@example.com";
const ADA = "ada@example.org";
const WORKER = "w-executor-test";
const LEASE = 60_000;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const client = new JmapClient(AUTH, session);
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
    area: "mail",
    trigger: { on: "email", filter: { subject: "invoice" } },
    tier: "T0",
    review: { mode: "threshold", threshold: 0.9 },
    actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
    capabilities: ["keyword.add"],
    ...overrides,
  };
}

async function claimFor(area: "mail" | "files" | "schedule") {
  const claim = await claimArea(store, area, WORKER, { now: new Date(), leaseMs: LEASE });
  assert.ok(claim, `the worker holds ${area}`);
  return claim;
}

async function jobsOf(ruleId: string): Promise<AgentJob[]> {
  return (await store.listJobs())
    .map((entry) => entry.doc)
    .filter((job) => job.ruleId === ruleId);
}

before(async () => {
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
  (mock as { server?: { close(): void } }).server?.close();
});

test("a matching message is filed: the job runs, the audit records it, the claim advances", async () => {
  const rule_ = rule();
  await store.writeRules([rule_]);
  const emailId = await createMessage("Your invoice #4821 is ready");
  const claim = await claimFor("mail");

  await executor.reconcile(GROUP, "Email", claim);

  const jobs = await jobsOf(rule_.id);
  assert.equal(jobs.length, 1, "one job per (record × rule)");
  const job = jobs[0]!;
  assert.equal(job.state, "done", "T0 carries confidence 1, so the threshold passes it");
  assert.equal(job.ruleVersion, rule_.version);
  assert.equal(job.attempts, 1);
  assert.equal(job.trigger.emailId, emailId);
  assert.equal(job.trigger.by, ADA, "the trail records who caused the run");
  assert.equal(job.area, "mail");

  const audit = await store.readAuditAt(new Date());
  const entry = audit?.entries.find((candidate) => candidate.jobId === job.id);
  assert.ok(entry, "the run is in the month's audit document");
  assert.equal(entry.outcome, "done");
  assert.equal(entry.ruleId, rule_.id);
  assert.deepEqual(entry.actions, rule_.actions);

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

  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });

  assert.equal((await jobsOf("only-invoices")).length, 0);
  assert.ok((await jobsOf("everything")).length >= 1);
});

test("a filter the executor cannot honour fails loudly instead of never firing", async () => {
  const broken = rule({
    id: "broken-filter",
    trigger: { on: "email", filter: { mood: "sunny" } },
  });
  await store.writeRules([broken]);

  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });

  const jobs = await jobsOf("broken-filter");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.state, "failed");
  assert.match(String(jobs[0]!.error), /does not understand the filter "mood"/);
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
    actions: [{ do: "keyword.add", with: { keyword: "G-nobody-defined-this" } }],
    capabilities: ["keyword.add"],
  });
  await store.writeRules([bad]);
  const emailId = await createMessage("An invoice for the wrong label");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });

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
    actions: [{ do: "noop" }],
    capabilities: ["noop"],
  });
  await store.writeRules([once]);
  const emailId = await createMessage("An invoice delivered twice");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });
  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });

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
    area: "mail",
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

  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });

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
    actions: [{ do: "keyword.add", with: {} }],
    capabilities: ["keyword.add"],
  });
  await store.writeRules([broken]);
  await createMessage("An invoice for a broken rule");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });

  const job = (await jobsOf("no-action-params")).at(-1);
  assert.ok(job);
  assert.equal(job.state, "failed");
  assert.match(String(job.error), /cannot run|cannot be honoured/);
});

test("a proposal that would send mail leaves the draft in Drafts, unread, and a person sending it settles the decision", async () => {
  const proposer = rule({
    id: "draft-and-send",
    name: "Reply to the invoice",
    review: { mode: "always" },
    actions: [
      {
        do: "mail.draft",
        with: { to: ADA, subject: "Re: invoice", text: "Filed, thank you." },
      },
      {
        do: "mail.send",
        with: { to: ADA, subject: "Re: invoice", text: "Filed, thank you." },
      },
    ],
    capabilities: ["mail.draft", "mail.send"],
  });
  await store.writeRules([proposer]);
  const emailId = await createMessage("An invoice that wants a reply");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });

  const job = (await jobsOf("draft-and-send")).find(
    (candidate) => candidate.trigger.emailId === emailId,
  );
  assert.ok(job);
  assert.equal(job.state, "awaiting_approval");
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
    actions: [
      { do: "mail.draft", with: { to: ADA, subject: "Re: gone", text: "Hello." } },
      { do: "mail.send", with: { to: ADA, subject: "Re: gone", text: "Hello." } },
    ],
    capabilities: ["mail.draft", "mail.send"],
  });
  await store.writeRules([proposer]);
  await createMessage("An invoice whose draft will vanish");

  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });
  const job = (await jobsOf("vanishing-draft")).at(-1);
  assert.ok(job?.proposal?.draft);
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
    area: "mail",
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
    actions: [{ do: "noop" }],
    capabilities: ["noop"],
    review: { mode: "never" },
  });
  await store.writeRules([scheduled]);
  await store.writeSchedule([
    { ruleId: scheduled.id, at: new Date(Date.now() - 60_000).toISOString() },
  ]);

  await executor.reconcile(GROUP, "schedule", await claimFor("mail"));

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
  await executor.reconcile(GROUP, "Email", { ...(await claimFor("mail")), states: {} });
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
