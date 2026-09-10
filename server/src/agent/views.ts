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

/**
 * Whether a group list came from Stalwart's directory, and why not when it did
 * not.
 *
 * The group mailboxes an admin can act on are enumerated from the directory,
 * and a session whose directory query is refused falls back on the group
 * accounts it already holds. The shorter list and the complete one read
 * identically from the outside, so an answer built that way carries this pair
 * with it: "nothing is waiting" and "I could not look" are different
 * sentences, and only one of them is about the groups.
 */
export interface GroupEnumeration {
  /** False when the directory could not be listed, so the list is a subset. */
  enumeration: boolean;
  /** Why the directory could not be listed; null when it answered. */
  enumerationMessage: string | null;
}

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

/**
 * The installation's fleet, as the status route answers it.
 *
 * `groups` is an enumeration's list, so the pair is `GroupEnumeration`'s:
 * absent on an answer that never enumerated — an installation with no agent
 * lists no group at all, which `reason` already says.
 */
export interface AgentStatus extends Partial<GroupEnumeration> {
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

/**
 * The approval queue, with the reach it was built from.
 *
 * The queue walks the group mailboxes the directory enumeration returned, so a
 * queue the directory could not be asked about is short, and this pair is what
 * tells that apart from a queue with nothing in it.
 */
export interface AgentApprovalsView extends GroupEnumeration {
  approvals: PendingApproval[];
}

/**
 * The agent's new app password, handed back exactly once.
 *
 * `alsoValid` is how many app passwords the rotation left working — the whole
 * difference between rotating a credential and revoking one — and it is null
 * when the account's state could not be re-read: unknown is not zero, and a
 * zero reported here would read as "the old credentials stopped working".
 */
export interface AgentAppPasswordRotation {
  secret: string;
  alsoValid: number | null;
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

/**
 * The rules a member reads: what the automation is, where it works, which tier
 * it runs on, whether it is on, what wakes it, how it is reviewed, and what it
 * then does.
 *
 * The last part (resolution 17) is why the tier's own material is here too: a
 * member who can read that an automation exists but not what it does cannot
 * judge what the agent does in their name. `capabilities`, `version` and the
 * authorship stamps stay out — the allowlist is what a run is checked against,
 * and a member reads the outcome rather than the grant.
 */
export type MemberAgentRule = Pick<
  AgentRule,
  | "id"
  | "name"
  | "area"
  | "tier"
  | "enabled"
  | "trigger"
  | "review"
  | "instruction"
  | "categories"
  | "actions"
>;

export interface MemberAgentView {
  group: string;
  granted: boolean;
  /** The registered agent's address; empty when the installation has none. */
  agentAddress: string;
  rules: MemberAgentRule[];
  /**
   * The group's standing instruction, as text a member reads (resolution 17).
   *
   * An empty `text` is the honest answer for a group that has none, and `max`,
   * `updatedAt` and `updatedBy` come with it so the panel can say how far the
   * ceiling is and who last wrote it — which is how a member sees that this
   * document is an administrator's, not theirs.
   */
  instruction: GroupInstructionView;
  jobs: AgentJob[];
  audit: AgentAuditEntry[];
}
