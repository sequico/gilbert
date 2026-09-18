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

import { errorMessage } from "../shared/errors.js";
import type {
  AgentAction,
  AgentAuditEntry,
  AgentAuditOutcome,
  AgentDecision,
  AgentJob,
  AgentRule,
  AgentTriggerRecord,
} from "./documents.js";
import { changeIdOf } from "./documents.js";
import type { AgentStore } from "./store.js";

export { errorMessage };

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

/**
 * What the run that wrote this entry cost, and on what settings.
 *
 * The counts ride the entry the run writes when it is decided, so the cost sits
 * beside the work that spent it, in the same monthly document, pruned by the
 * same retention — and every reading is a reading of that one record (ADR 0003). A run that reported nothing carries no counts rather than zeros.
 */
export type RunCost = Pick<AgentAuditEntry, "agent" | "reasoned" | "usage">;

function build(
  subject: AuditSubject,
  rule: AuditRule,
  outcome: AgentAuditOutcome,
  actions: ReadonlyArray<AgentAction>,
  detail?: string,
  cost?: RunCost,
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
  if (cost?.agent) entry.agent = cost.agent;
  if (cost?.reasoned !== undefined) entry.reasoned = cost.reasoned;
  if (cost?.usage) entry.usage = cost.usage;
  return entry;
}

/** Turn a finished, refused or paused run into one entry. */
export function auditEntry(
  job: AgentJob,
  rule: AuditRule,
  outcome: AgentAuditOutcome,
  actions: ReadonlyArray<AgentAction>,
  detail?: string,
  cost?: RunCost,
): AgentAuditEntry {
  return build(subjectOf(job), rule, outcome, actions, detail, cost);
}

/**
 * The id an entry carries when no job exists to name: the rule, and what the run
 * was about.
 *
 * A due run nothing fired and a run a chain refused are both runs that never
 * started, so neither has a job document and the trail names them by that pair.
 */
function unstartedRunId(ruleId: string, what: string): string {
  return `${ruleId}@${what}`;
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
    { jobId: unstartedRunId(rule.id, at), ruleId: rule.id, ruleVersion: rule.version },
    rule,
    "missed",
    [],
    detail,
  );
}

/**
 * The id a refusal is recorded under.
 *
 * A refusal has no job to name — nothing was started — and what it is about is
 * the change, not the pass that read it: the same change read twice is one
 * refusal. An id built from the instant of the pass would put a second entry in
 * the trail for a change the worker read again.
 */
export function refusedSubject(ruleId: string, trigger: AgentTriggerRecord): string {
  return unstartedRunId(ruleId, changeIdOf(trigger));
}

/**
 * A run a chain refused: the automation was woken past the installation's bound
 * on hops, so no job exists to name — the refusal happened instead of the run.
 *
 * The outcome is `refused` rather than `failed`, because nothing failed: a run
 * that must not happen is a fact about the agent, and the trail is where a
 * reader finds it (ADR 0003).
 */
export function refusedAuditEntry(
  rule: AuditRule,
  trigger: AgentTriggerRecord,
  detail: string,
): AgentAuditEntry {
  return build(
    {
      jobId: refusedSubject(rule.id, trigger),
      ruleId: rule.id,
      ruleVersion: rule.version,
    },
    rule,
    "refused",
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
