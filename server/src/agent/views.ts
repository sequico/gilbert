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
 * imports type-only, so no server code reaches a runtime through this file:
 * what it carries into a bundle is the handful of constants declared in it.
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
 * Why the fleet cannot be read, as a code beside whatever an upstream said.
 *
 * The sentence a person reads is composed where it is read — the same rule the
 * group-membership refusal follows — so an administrator reads the reason in
 * the language the surface is set to rather than in the server's English, and a
 * language whose catalogue lacks it reads the English in the meantime.
 *
 * `detail` is not a sentence of ours: it is what the server that refused said,
 * and it is shown as the diagnostic it is.
 */
export type AgentStatusReason =
  | { code: "agent_not_configured" }
  | { code: "agent_unreachable"; detail: string }
  | { code: "workers_unreadable"; detail: string };

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
   * code is the honest answer for an installation with no agent, for an
   * unreachable one, and for a deployment whose secret no longer matches.
   */
  reason?: AgentStatusReason;
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
  /**
   * The membership refusal, when the admin cannot reach the group: the code,
   * and the section whose documents are out of reach. The sentence a person
   * reads is composed where it is shown.
   */
  error?: typeof GROUP_NOT_ACCESSIBLE;
  need?: GroupNeed;
  rules: AgentRule[];
  jobs: AgentJob[];
  decisions: AgentDecision[];
  audit: AgentAuditEntry[];
  schedule: AgentScheduleEntry[];
}

/** The surface for a group this admin can read. */
export type AgentGroupView = AgentGroupSurface & { granted: true };

/** The surface for a group this admin cannot reach: empty, with the refusal. */
export type AgentGroupDenied = AgentGroupSurface & {
  granted: false;
  error: typeof GROUP_NOT_ACCESSIBLE;
  need: GroupNeed;
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
/* The audit export                                                    */
/* ------------------------------------------------------------------ */

/** One month of a group's audit trail, as the export carries it. */
export interface AgentAuditExportMonth {
  /** `YYYY-MM`, the name the month's own document carries. */
  month: string;
  entries: AgentAuditEntry[];
}

/**
 * A group's audit trail, month by month, for an administrator to keep.
 *
 * The trail is one document per month in the group's own `gilbert` app folder
 * and the declared retention is what bounds it, so the export is exactly the
 * months that are still there: taken before the oldest is pruned, it is the
 * copy of a record that would otherwise only expire. Nothing here is a second
 * store — these are the same documents the group's own surface reads.
 */
export interface AgentAuditExport {
  group: string;
  /** The registered agent's address; empty when the installation has none. */
  agentAddress: string;
  /** When the copy was taken, so a reader can date it. */
  exportedAt: string;
  months: AgentAuditExportMonth[];
}

/* ------------------------------------------------------------------ */
/* The group-membership refusal                                        */
/* ------------------------------------------------------------------ */

/**
 * What a section asks a group for.
 *
 * Every surface reaches a group's documents for the same grant — membership of
 * the group — but not for the same document, and the refusal a person reads
 * names the section they were standing at. That name travels as this value
 * rather than inside a sentence, so the sentence can be composed in the
 * language the person reads.
 */
export type GroupNeed =
  | "labels"
  | "automations"
  | "standing instruction"
  | "approvals"
  | "agent documents";

/** The code a group-membership refusal travels as, on every surface. */
export const GROUP_NOT_ACCESSIBLE = "group_not_accessible";

/**
 * Why a group's documents are out of reach: the code, and the parameter that
 * names the section.
 *
 * Membership is the whole answer — a group's documents live in the group's own
 * account, so a non-member has no path to them at all — and the sentence that
 * says so is composed where it is shown, from the catalogue in force: a
 * language whose catalogue lacks it reads the English source.
 */
export interface GroupAccessDenied {
  ok: false;
  error: typeof GROUP_NOT_ACCESSIBLE;
  need: GroupNeed;
}

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
