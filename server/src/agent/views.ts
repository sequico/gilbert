/**
 * The shapes the agent API answers with.
 *
 * One definition for the two tiers that meet here: the routes build these
 * answers, and the client reads them. Declared twice — once beside the routes,
 * once beside the fetch calls — a field added on one side and forgotten on the
 * other compiles on both and arrives as `undefined` on one, which is exactly
 * the drift SSOT forbids.
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
  /**
   * The areas an administrator narrowed this group to, when one did. Absent
   * means the deployment's own list is in force — which `AgentStatus.defaultAreas`
   * carries, so a surface can say what "not narrowed" comes to.
   */
  areas?: AgentArea[];
}

/** Where the address the installation acts as came from. */
export type AgentAddressSource = "policy" | "deployment" | "none";

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
  /**
   * Where that address comes from: the installation's own record, the
   * deployment, or nowhere yet. A surface that lets an administrator name the
   * agent says which of the two is in force, because they are fixed in
   * different places.
   */
  addressSource: AgentAddressSource;
  /**
   * Whether the deployment holds the secret that address signs in with. The web
   * tier acts by impersonation and needs none; a worker needs one, so an
   * address with no secret is an agent the product can read and that can do
   * nothing on its own.
   */
  hasSecret: boolean;
  /**
   * How many app passwords the agent's own account holds, read under
   * impersonation. `null` when the read failed — never a zero, which would read
   * as an account holding no credential at all.
   *
   * Two facts, two fields: this is what the installation's agent account can
   * prove it holds, and `hasSecret` is whether the deployment carries the copy
   * that lets a worker sign in as it. A credential minted here and not yet
   * deployed is exactly the gap between them.
   */
  appPasswords: number | null;
  groups: AgentStatusGroup[];
  /** The areas the deployment serves, which a group's own list can only narrow. */
  defaultAreas: AgentArea[];
  workers: AgentStatusWorker[];
  /** Grants the fleet has lost, newest first, as its workers reported them. */
  withdrawals: AgentWithdrawal[];
  /**
   * Why the fleet cannot be read, when it cannot. `configured: false` plus this
   * code is the honest answer for an installation with no agent, for an
   * unreachable one, and for a deployment whose secret no longer matches.
   */
  reason?: AgentStatusReason;
}

/**
 * A refusal from the admin surface, as it travels: a code and its parameters.
 *
 * The sentence is composed where it is read — the same rule the membership
 * refusal follows — so an administrator reads the refusal in the language the
 * surface is set to, and a language whose catalogue does not carry it reads the
 * English in the meantime.
 *
 * `detail`, where a member carries it, is not a sentence of ours: it is what a
 * server that refused said, shown as the diagnostic it is. The union is the one
 * list of codes: the routes build from it, the client composes from it, and a
 * sentence added on one side without the other does not compile.
 */
export type AgentErrorReason =
  | { code: "agent_not_configured" }
  | { code: "agent_unreachable"; detail: string }
  | { code: "agent_files_account_missing"; address: string }
  | { code: "agent_not_found"; detail: string }
  | { code: "forbidden"; detail: string }
  | { code: "duplicate_rule"; id: string }
  | { code: "rule_not_a_document"; index: number }
  | { code: "rule_cannot_run"; name: string; problems: string }
  | { code: "providers_not_an_object" }
  | { code: "unknown_tier"; key: string }
  | { code: "tier_incomplete"; tier: string }
  | { code: "tier_api_key_required"; tier: string }
  | { code: "tier_api_key_required_after_move"; tier: string; movedTo: string }
  | { code: "tier_base_url_invalid"; tier: string }
  | { code: "tier_base_url_not_https"; tier: string }
  | { code: "tier_base_url_private"; tier: string; host: string }
  | { code: "instruction_too_long"; max: number; length: number }
  | { code: "group_labels_unreadable" }
  /** The address was recorded; the credential that would let a worker sign in
   * as it could not be provisioned. The installation is half set up, and the
   * surface says which half rather than reporting the save as a failure. */
  | { code: "agent_credential_failed"; detail: string };

/* ------------------------------------------------------------------ */
/* One withdrawal                                                     */
/* ------------------------------------------------------------------ */

/**
 * A grant the agent had and no longer does, with what it was serving.
 *
 * Written by the worker the pass after the group leaves its session, into the
 * agent's **own** account: from that moment the group's trail is not readable
 * by the agent any more, so what is left to say is what it held and when it
 * noticed — never what the group went on doing. Read back by the status route,
 * so the surface an administrator looks at is where a withdrawal is seen
 * rather than a log nobody tails.
 */
export interface AgentWithdrawal {
  /** The account that left the session. */
  account: string;
  /** The group's name as the session carried it, lower-cased. */
  group: string;
  /** The areas the worker was serving for it when it noticed. */
  heldAreas: AgentArea[];
  /** When the pass noticed. */
  at: string;
}

/**
 * Where a worker keeps its withdrawal report, in its own account.
 *
 * Declared here rather than beside the writer because the reader is a different
 * tier's route: one path, one constant, no second spelling of it to drift.
 */
export const WITHDRAWALS_PATH = "agent/withdrawals.json";

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

/**
 * What naming the installation's agent answers with.
 *
 * The address in force, whether the deployment carries its secret, and the
 * credential the save itself provisioned — a secret nobody has held before,
 * shown once, because a credential's secret is never readable again once it
 * has been minted.
 */
export interface AgentAddressSaved {
  address: string;
  hasSecret: boolean;
  /** Present only when this save had to mint a new app password. */
  credential?: AgentAppPasswordRotation & { created: true };
  /**
   * Why the credential could not be provisioned, when the address was
   * nonetheless recorded. A code and its parameters, like every other agent
   * refusal: the sentence is composed where it is read.
   */
  credentialError?: AgentErrorReason;
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
