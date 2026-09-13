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
  AgentAuditEntry,
  AgentDecision,
  AgentJob,
  AgentMeter,
  AgentNotebookFact,
  AgentRule,
  AgentScheduleEntry,
} from "./documents.js";

/* ------------------------------------------------------------------ */
/* The installation's fleet                                            */
/* ------------------------------------------------------------------ */

/** One group the agent works in, as its own session shows it holds it. */
export interface AgentStatusGroup {
  name: string;
}

/**
 * What the installation has spent, over the window the group panels read
 * (ADR 0003).
 *
 * The total is the sum of every group the agent holds — complete by
 * construction, because the agent's own session is the reach and there is no
 * other index of runs — and the split is how each entry names the agent that
 * made the call. A group whose audit could not be read is named in `unreadable`
 * rather than folded in as nothing: the total is then a floor, and the surface
 * says so.
 */
export interface AgentStatusMeter {
  total: AgentMeter;
  /** One entry per agent address; the empty name is "the entry names none". */
  byAgent: Array<{ agent: string; meter: AgentMeter }>;
  /** Groups whose audit could not be read: their runs are in no total here. */
  unreadable: string[];
}

/** One running worker, with freshness judged at read time rather than stored. */
export interface AgentStatusWorker {
  id: string;
  address: string;
  heartbeatAt: string;
  version: string;
  alive: boolean;
  /**
   * The groups this worker is holding, as its last heartbeat named them.
   *
   * A claim is per account, so this is what one worker is serving and the
   * surface reads one group's workers off it. Empty is a worker that is up and
   * holding nothing — a state a person is meant to see, not a missing answer.
   */
  groups: string[];
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
  | { code: "agent_credentials_rejected"; detail: string }
  | { code: "agent_unreachable"; detail: string }
  | { code: "agents_unreadable"; detail: string };

/**
 * The installation's fleet, as the status route answers it.
 *
 * `groups` is the agent's own membership and nothing else: the groups are read
 * from the agent's session in Stalwart's directory, so the list is complete by
 * construction and carries no enumeration's caveat. An installation whose agent
 * cannot be opened lists no group at all, which `reason` already says.
 */
export interface AgentStatus {
  /**
   * Whether the fleet can run at all: the deployment names an agent, the
   * credential it carries signs in, and the agent's own account opens. False
   * with a `reason` is the honest answer, and the surface reads the sentence
   * that code composes.
   */
  operational: boolean;
  /** The agent's address, as the deployment names it; empty when it names none. */
  address: string;
  groups: AgentStatusGroup[];
  /** The installation's use, and the split per agent (ADR 0003). */
  meter: AgentStatusMeter;
  workers: AgentStatusWorker[];
  /** Grants the fleet has lost, newest first, as its workers reported them. */
  withdrawals: AgentWithdrawal[];
  /**
   * Why the fleet is not operational, when it is not: the deployment names no
   * agent, the credential it carries was refused, or the agent itself could not
   * be opened. It travels as a code, and the sentence a person reads is
   * composed where it is read.
   */
  reason?: AgentStatusReason;
}

/**
 * Why an automation a person asked for did not start.
 *
 * The ask names one automation and, when it wants a particular message, that
 * message. Every answer here is something the person can act on, and they
 * travel as one code carrying the reason rather than as six codes: the union
 * above is the list an agent surface composes a sentence from, and this is one
 * answer — it did not start, and here is why.
 *
 * `rule_not_email` is not a limit of the machinery but of the door: a chat
 * automation is already asked for by talking to the agent in the group's chat,
 * and a time one by its own clock, so the person-shaped door is the one mail
 * has no other way into.
 */
export type ManualRunRefusal =
  | "rule_not_found"
  | "rule_not_armed"
  | "rule_not_email"
  | "no_message"
  | "message_not_matched";

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
  | { code: "agent_credentials_rejected"; detail: string }
  | { code: "agent_unreachable"; detail: string }
  | { code: "agent_files_account_missing"; address: string }
  | { code: "agent_not_found"; detail: string }
  | { code: "forbidden"; detail: string }
  | { code: "duplicate_rule"; id: string }
  | { code: "rule_not_a_document"; index: number }
  | { code: "rule_cannot_run"; name: string; problems: string }
  | { code: "manual_run_refused"; why: ManualRunRefusal; rule?: string }
  | { code: "provider_not_an_object" }
  | { code: "provider_incomplete" }
  | { code: "api_key_required" }
  | { code: "api_key_required_after_move"; movedTo: string }
  | { code: "base_url_invalid" }
  | { code: "base_url_not_https" }
  | { code: "base_url_private"; host: string }
  | { code: "max_output_tokens_invalid"; max: number }
  | { code: "max_chain_hops_invalid"; max: number }
  | { code: "max_pages_invalid"; max: number }
  | { code: "notebook_not_an_object" }
  | { code: "notebook_too_many"; max: number }
  | { code: "notebook_fact_too_long"; max: number }
  | { code: "instruction_too_long"; max: number; length: number }
  | { code: "notes_too_long"; max: number; length: number }
  | { code: "no_provider" }
  | { code: "reading_failed"; detail: string }
  | { code: "envelope_too_long"; max: number; length: number }
  | { code: "authoring_budget_spent"; max: number }
  | { code: "group_labels_unreadable" };

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
  error?: GroupDeniedCode;
  need?: GroupNeed;
  rules: AgentRule[];
  jobs: AgentJob[];
  decisions: AgentDecision[];
  audit: AgentAuditEntry[];
  /** What this group's runs cost, over the window the trail is read over. */
  meter: AgentMeter;
  schedule: AgentScheduleEntry[];
}

/** The surface for a group this admin can read. */
export type AgentGroupView = AgentGroupSurface & { granted: true };

/** The surface for a group this admin cannot reach: empty, with the refusal. */
export type AgentGroupDenied = AgentGroupSurface & {
  granted: false;
  error: GroupDeniedCode;
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
  "rules" | "jobs" | "decisions" | "audit" | "meter" | "schedule"
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
 * Every administration surface reaches a group's documents for the same grant —
 * the installation's agent holds the group — but not for the same document, and
 * the refusal a person reads names the section they were standing at. That name
 * travels as this value rather than inside a sentence, so the sentence can be
 * composed in the language the person reads.
 */
export type GroupNeed =
  | "labels"
  | "automations"
  | "standing instruction"
  | "notebook"
  | "approvals"
  | "agent documents";

/** The code a group the agent does not hold travels as, on every surface. */
export const GROUP_NOT_ACCESSIBLE = "group_not_accessible";

/**
 * The code a group nobody could ask about travels as.
 *
 * A probe that did not answer is not a group the agent lacks: the surface says
 * what it could not establish, so a person retries or looks at the server
 * rather than editing a grant that was never the problem (ADR 0005).
 */
export const GROUP_UNREADABLE = "group_unreadable";

/** The two ways a group's documents are out of reach, as codes a client reads. */
export type GroupDeniedCode = typeof GROUP_NOT_ACCESSIBLE | typeof GROUP_UNREADABLE;

/**
 * Why a group's documents are out of reach: the code, and the parameter that
 * names the section.
 *
 * The agent's grant is the whole answer — a group's documents live in the
 * group's own account, and the agent is the principal that holds it — so a
 * group the agent is not granted on has no path to them at all, and a group the
 * mail server would not answer about has none either. The sentence that says so
 * is composed where it is shown, from the catalogue in force: a language whose
 * catalogue lacks it reads the English source.
 */
export interface GroupAccessDenied {
  ok: false;
  error: GroupDeniedCode;
  need: GroupNeed;
}

/* ------------------------------------------------------------------ */
/* Providers — the agent's own configuration                           */
/* ------------------------------------------------------------------ */

/** The installation's model as the API reads it: `hasKey`, never the key. */
export interface AgentProviderView {
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
}

export interface AgentProvidersView {
  /** Empty when the installation has no agent registered. */
  address: string;
  /** The one model every automation runs on; null when none is configured. */
  provider: AgentProviderView | null;
  /** The ceiling on one answer, in tokens, as it stands. */
  maxOutputTokens: number;
  /** How many hops a chain of automations may run, as it stands. */
  maxChainHops: number;
  /** How many pages one run may hand the model as images, as it stands. */
  maxPages: number;
}

/* ------------------------------------------------------------------ */
/* Approvals and the standing instruction                              */
/* ------------------------------------------------------------------ */

/**
 * The group's notebook as a surface reads it: the facts themselves — the same
 * shape the document stores, never a second spelling of one — the stamps, and
 * the bounds the document enforces, so a form can say them.
 */
export interface GroupNotebookView {
  facts: AgentNotebookFact[];
  updatedAt: string | null;
  updatedBy: string | null;
  maxFact: number;
  maxFacts: number;
}

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
 * The approval queue.
 *
 * The queue walks the agent's own session, so it is exactly the groups a
 * decision can be waiting in and complete by construction: there is no listing
 * that could fall short of it, and no caveat to carry.
 */
export interface AgentApprovalsView {
  approvals: PendingApproval[];
}

export interface GroupInstructionView {
  text: string;
  /**
   * The author's remarks beside the prose. Carried in the document so they
   * survive a container, and read by nobody's model: a run's prompt is the
   * instruction and nothing beside it (ADR 0003).
   */
  notes: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** The ceiling the document is validated against, in characters. */
  max: number;
  /** The ceiling on the remarks, in characters. */
  notesMax: number;
}

/**
 * What an author's reading answered: prose, and whether the month recorded it.
 *
 * The answer is shown where it was asked for and stored nowhere — it compiles
 * nothing, produces no document, and is not a run — so this is the whole shape
 * of it (ADR 0003).
 *
 * `counted` is false when the words reached the reader and the month's
 * authoring document did not take the entry: the tokens are spent either way,
 * so the surface shows the answer it paid for and says beside it that the
 * count is missing.
 */
export interface AgentReadingView {
  text: string;
  /** Whether the month's authoring document took this call's entry. */
  counted: boolean;
}

/* ------------------------------------------------------------------ */
/* What a member sees                                                  */
/* ------------------------------------------------------------------ */

/**
 * The rules a member reads: what the automation is, whether it is on, what
 * wakes it, how it is reviewed, and the instruction it carries.
 *
 * The instruction is here (resolution 17) because a member who can read that
 * an automation exists but not what it does cannot judge what the agent does in
 * their name. `capabilities`, `version` and the authorship stamps stay out —
 * the allowlist is what a run is checked against, and a member reads the
 * outcome rather than the grant.
 */
export type MemberAgentRule = Pick<
  AgentRule,
  "id" | "name" | "enabled" | "trigger" | "review" | "instruction"
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
