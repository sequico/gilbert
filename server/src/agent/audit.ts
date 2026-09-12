/**
 * The agent's trail: one builder, one writer.
 *
 * ADR 0003 puts the answer to "what did the agent do, under which version of
 * which rule" in Stalwart — one audit document per month per group, in the
 * group's own account. The shapes and the document layout stay in
 * `documents.ts` and `store.ts`; this module only decides what one run's entry
 * says, so a finished run, a refusal and a failure are all written the same
 * way wherever they are recorded from.
 */

import type {
  AgentAction,
  AgentAuditEntry,
  AgentAuditOutcome,
  AgentDecision,
  AgentJob,
  AgentRule,
} from "./documents.js";
import type { AgentStore } from "./store.js";

/** What one line of the trail needs to know about its rule. */
export type AuditRule = Pick<AgentRule, "id" | "name" | "version">;

/** What the builder takes: the run's identity, not the whole job document. */
interface AuditSubject {
  jobId: string;
  ruleId: string;
  /** The version the job pinned: what ran, not what the rule says now. */
  ruleVersion: number;
  /** Who asked, when a person did. */
  by?: string;
}

function subjectOf(job: AgentJob): AuditSubject {
  const subject: AuditSubject = {
    jobId: job.id,
    ruleId: job.ruleId,
    ruleVersion: job.ruleVersion,
  };
  if (job.trigger.by) subject.by = job.trigger.by;
  return subject;
}

/**
 * The subject of a decision, for the case the audit has to answer without a
 * job document: a decision outlives the job document the worker pruned, and a
 * person's approval still belongs in the trail.
 */
function subjectOfDecision(decision: AgentDecision): AuditSubject {
  const subject: AuditSubject = {
    jobId: decision.jobId,
    ruleId: decision.ruleId,
    ruleVersion: decision.ruleVersion,
  };
  if (decision.decidedBy) subject.by = decision.decidedBy;
  return subject;
}

function build(
  subject: AuditSubject,
  rule: AuditRule,
  outcome: AgentAuditOutcome,
  actions: ReadonlyArray<AgentAction>,
  detail?: string,
): AgentAuditEntry {
  const entry: AgentAuditEntry = {
    at: new Date().toISOString(),
    jobId: subject.jobId,
    ruleId: subject.ruleId,
    ruleVersion: subject.ruleVersion,
    outcome,
    actions: [...actions],
    // The rule's name keeps the trail readable a year later, when the rule
    // document may read differently or be gone.
    detail: [rule.name, detail].filter(Boolean).join(": "),
  };
  if (subject.by) entry.by = subject.by;
  return entry;
}

/** Turn a finished, refused or paused run into one entry. */
export function auditEntry(
  job: AgentJob,
  rule: AuditRule,
  outcome: AgentAuditOutcome,
  actions: ReadonlyArray<AgentAction>,
  detail?: string,
): AgentAuditEntry {
  return build(subjectOf(job), rule, outcome, actions, detail);
}

/**
 * A run the schedule moved past while no worker was serving the group.
 *
 * There is no job to name — nobody ever started one — so the entry names the
 * rule and the instant the run was due for. Without it, a worker that was away
 * across a scheduled run leaves a group whose automation simply did not happen,
 * and nothing anywhere says so.
 */
export function missedAuditEntry(
  rule: AuditRule,
  at: string,
  detail?: string,
): AgentAuditEntry {
  return build(
    { jobId: `${rule.id}@${at}`, ruleId: rule.id, ruleVersion: rule.version },
    rule,
    "missed",
    [],
    detail,
  );
}

/** The same entry for a decision whose job document is already gone. */
export function decisionAuditEntry(
  decision: AgentDecision,
  rule: AuditRule,
  outcome: AgentAuditOutcome,
  actions: ReadonlyArray<AgentAction>,
  detail?: string,
): AgentAuditEntry {
  return build(subjectOfDecision(decision), rule, outcome, actions, detail);
}

/** Append an entry to the month its own instant falls in. */
export async function recordAudit(
  store: AgentStore,
  entry: AgentAuditEntry,
): Promise<void> {
  await store.appendAudit(entry, new Date(entry.at));
}

/**
 * A line for a group whose own document cannot be read.
 *
 * There is no run and no job to name: what failed is the document every run of
 * the group is written in, and the group's whole automation is stopped by it.
 * The subject is the document itself, so the trail says which one a person has
 * to look at, and the outcome is `failed` — no run of the group happened, and
 * `missed` is the outcome for one the schedule moved past.
 */
export function unreadableDocumentAuditEntry(
  document: string,
  detail: string,
): AgentAuditEntry {
  return build(
    { jobId: document, ruleId: document, ruleVersion: 0 },
    { id: document, name: document, version: 0 },
    "failed",
    [],
    detail,
  );
}

/** How a failure reads in the trail, the chat and the admin surface. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
