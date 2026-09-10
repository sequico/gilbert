/**
 * The shapes the agent API answers with.
 *
 * One definition for the two tiers that meet here: the routes build these
 * answers, and the client reads them. They used to be declared twice — once
 * beside the routes, once beside the fetch calls — which is exactly the drift
 * SSOT forbids: a field added on one side and forgotten on the other compiles
 * on both and arrives as `undefined` on one.
 *
 * The stored documents are not here; they are `./documents`, which this module
 * imports type-only (so nothing in this file reaches a runtime in either tier).
 * What a route hands back is a view of those documents, and a surface that
 * writes one sends a request body of its own shape — validated on arrival like
 * every other write (ADR 0003 resolution 16), which is why request bodies are
 * not declared here.
 */
import type {
  AgentArea,
  AgentAuditEntry,
  AgentDecision,
  AgentJob,
  AgentRule,
  AgentScheduleEntry,
} from "./documents.js";

/* ------------------------------------------------------------------ */
/* The installation's fleet                                            */
/* ------------------------------------------------------------------ */

/** One group the agent could work in, and whether it may. */
export interface AgentStatusGroup {
  name: string;
  granted: boolean;
}

/** One running worker, with freshness judged at read time rather than stored. */
export interface AgentStatusWorker {
  id: string;
  address: string;
  areas: AgentArea[];
  heartbeatAt: string;
  version: string;
  alive: boolean;
}

export interface AgentStatus {
  configured: boolean;
  /** The registered agent's address; empty when the installation has none. */
  address: string;
  groups: AgentStatusGroup[];
  workers: AgentStatusWorker[];
  /**
   * Why the fleet cannot be read, when it cannot. `configured: false` plus this
   * line is the honest answer for an installation with no agent, for an
   * unreachable one, and for a deployment whose secret no longer matches.
   */
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* One group                                                           */
/* ------------------------------------------------------------------ */

/**
 * A group's agent surface, in the one shape the route answers with.
 *
 * The documents are there when the admin may read the group and empty when they
 * may not, and `reason` says which and why — so a consumer renders one thing
 * and branches on `granted` alone.
 */
export interface AgentGroupSurface {
  group: string;
  granted: boolean;
  /** The registered agent's address; empty when the installation has none. */
  agentAddress: string;
  /** Present when the admin has no access to the group: why it is empty. */
  reason?: string;
  rules: AgentRule[];
  jobs: AgentJob[];
  decisions: AgentDecision[];
  audit: AgentAuditEntry[];
  schedule: AgentScheduleEntry[];
}

/** The surface for a group this admin can read. */
export type AgentGroupView = AgentGroupSurface & { granted: true };

/** The surface for a group this admin cannot reach: empty, with the reason. */
export type AgentGroupDenied = AgentGroupSurface & {
  granted: false;
  reason: string;
};

/**
 * The documents of one group, as the group's own account hands them over.
 *
 * The half of `AgentGroupSurface` a store can answer on its own: the route adds
 * the name it was asked for and the agent's address, which belong to the
 * installation rather than to the group.
 */
export type AgentGroupDocuments = Pick<
  AgentGroupSurface,
  "rules" | "jobs" | "decisions" | "audit" | "schedule"
> & { granted: true };

/** What the group route answers with, either way. */
export type AgentGroupAnswer = AgentGroupView | AgentGroupDenied;

/* ------------------------------------------------------------------ */
/* Providers — the agent's own configuration                           */
/* ------------------------------------------------------------------ */

/** One tier's provider as the API reads it: `hasKey`, never the key. */
export interface AgentProviderView {
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
}

export interface AgentProvidersView {
  /** Empty when the installation has no agent registered. */
  address: string;
  providers: { T1?: AgentProviderView; T2?: AgentProviderView };
}

/* ------------------------------------------------------------------ */
/* Approvals and the standing instruction                              */
/* ------------------------------------------------------------------ */

/** One pending decision, with the group it waits in (resolution 10). */
export interface PendingApproval {
  group: string;
  decisionId: string;
  jobId: string;
  summary: string;
  confidence: number;
  createdAt: string;
}

export interface GroupInstructionView {
  text: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** The ceiling the document is validated against, in characters. */
  max: number;
}

/* ------------------------------------------------------------------ */
/* What a member sees                                                  */
/* ------------------------------------------------------------------ */

/** The rules a member reads: what it is, where, which tier, on, woken by what. */
export type MemberAgentRule = Pick<
  AgentRule,
  "id" | "name" | "area" | "tier" | "enabled" | "trigger"
>;

export interface MemberAgentView {
  group: string;
  granted: boolean;
  /** The registered agent's address; empty when the installation has none. */
  agentAddress: string;
  rules: MemberAgentRule[];
  jobs: AgentJob[];
  audit: AgentAuditEntry[];
}
