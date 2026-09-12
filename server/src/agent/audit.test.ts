import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * The trail's one builder and the month it lands in (ADR 0003 §4).
 *
 * One audit document per month per group: the entry's own instant decides which
 * month, so an entry recorded just after midnight on the first of a month goes
 * into that month's document and no other.
 */

const PORT = 18852;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const {
  auditEntry,
  decisionAuditEntry,
  errorMessage,
  missedAuditEntry,
  recordAudit,
  refusedAuditEntry,
  refusedSubject,
} = await import("./audit.js");
const { AgentStore } = await import("./store.js");
const { monthOf, newJob } = await import("./documents.js");

const BASE = `http://127.0.0.1:${PORT}`;
const GROUP = "a3";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const store = new AgentStore(ctx, GROUP);

const rule = { id: "r1", name: "File the invoices", version: 3 };

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a refusal is an entry of its own, named by the change it refused", () => {
  // A run a chain refused never started, so there is no job to name: the entry
  // carries the rule and the change, and the change is what a second pass reads
  // to recognise a refusal it already recorded (ADR 0010).
  const trigger = {
    on: "filenode" as const,
    nodeId: "n1",
    at: "2026-09-10T12:00:00Z",
  };
  const entry = refusedAuditEntry(rule, trigger, "the chain passed 5 hops");
  assert.equal(entry.outcome, "refused");
  assert.equal(entry.jobId, refusedSubject(rule.id, trigger));
  assert.equal(entry.ruleId, rule.id);
  assert.equal(entry.ruleVersion, rule.version);
  assert.deepEqual(entry.actions, []);
  assert.match(String(entry.detail), /the chain passed 5 hops/);
  // The record is what the refusal is remembered by, not the instant of the pass
  // that read the change: a re-read names the same entry, another record does
  // not, and a due run nothing fired is named by its own instant.
  assert.equal(
    refusedSubject(rule.id, { ...trigger, at: "2026-09-10T13:00:00Z" }),
    entry.jobId,
  );
  assert.notEqual(refusedSubject(rule.id, { ...trigger, nodeId: "n2" }), entry.jobId);
  assert.equal(
    missedAuditEntry(rule, "2026-09-10T12:00:00Z").jobId,
    `${rule.id}@2026-09-10T12:00:00Z`,
  );
});

test("an entry names the job, the pinned rule version and the actor", () => {
  const job = newJob({
    id: "j1",
    accountId: GROUP,
    rule: { id: "r1", version: 2 },
    trigger: {
      on: "chat",
      chatId: "c1",
      at: "2026-09-10T08:00:00Z",
      by: "ada@example.org",
    },
  });
  const entry = auditEntry(job, rule, "done", [{ do: "noop" }], "ran");
  assert.equal(entry.jobId, "j1");
  assert.equal(entry.ruleId, "r1");
  assert.equal(entry.ruleVersion, 2, "what ran, not what the rule says now");
  assert.equal(entry.outcome, "done");
  assert.equal(entry.by, "ada@example.org");
  assert.equal(entry.detail, "File the invoices: ran");
  assert.deepEqual(entry.actions, [{ do: "noop" }]);
});

test("a decision whose job document is gone still gets an entry", () => {
  const entry = decisionAuditEntry(
    {
      v: 1,
      id: "j1-d",
      jobId: "j1",
      accountId: GROUP,
      ruleId: "r1",
      ruleVersion: 4,
      state: "approved",
      summary: "send it",
      actions: [],
      confidence: 1,
      decidedBy: "grace@example.org",
      createdAt: "2026-09-10T08:00:00Z",
      updatedAt: "2026-09-10T08:01:00Z",
    },
    rule,
    "done",
    [],
    "approved by grace@example.org",
  );
  assert.equal(entry.jobId, "j1");
  assert.equal(entry.ruleVersion, 4);
  assert.equal(entry.by, "grace@example.org");
});

test("recordAudit appends to the month the entry's instant falls in", async () => {
  const job = newJob({
    id: "j2",
    accountId: GROUP,
    rule,
    trigger: { on: "email", emailId: "e9", at: "2026-09-10T08:00:00Z" },
  });
  await recordAudit(store, auditEntry(job, rule, "failed", [], "the provider was down"));
  await recordAudit(store, auditEntry(job, rule, "done", []));

  const today = await store.readAuditAt(new Date());
  assert.ok(today, "the month's document exists");
  assert.equal(today.month, monthOf(new Date()));
  const mine = today.entries.filter((entry) => entry.jobId === "j2");
  assert.equal(mine.length, 2);
  assert.equal(mine[0]!.outcome, "failed");
  assert.equal(mine[1]!.outcome, "done");
});

test("a failure reads as one line, whoever threw it", () => {
  assert.equal(
    errorMessage(new Error("the provider refused the key")),
    "the provider refused the key",
  );
  assert.equal(errorMessage("just a string"), "just a string");
});
