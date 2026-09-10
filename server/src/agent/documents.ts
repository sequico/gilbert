/**
 * The agent worker fleet's durable documents (ADR 0003) — one definition.
 *
 * Everything the fleet needs to survive a crash is a document in Stalwart:
 * rules, jobs, decisions, claims, the schedule and the audit trail, in the
 * group's own app folder (v1 scope: the group's account is what members can
 * read), plus the installation-wide configuration and the stream claim in the
 * agent's own account. Nothing durable lives on the worker.
 *
 * This module is the schema's single home: the shapes, their validators, the
 * action catalogue, the rule matcher and the review gate. The executor, the
 * admin API and the worker all import it; none of them re-declares a field.
 *
 * Document layout, under an account's `gilbert` app folder:
 *
 *   agent/rules.json            rules, in the group's account
 *   agent/schedule.json         next run times, in the group's account
 *   agent/jobs/<id>.json        one document per job, in the group's account
 *   agent/decisions/<id>.json   one document per approval, in the group's account
 *   agent/claims/<area>.json    one claim per account × area, in the group's account
 *   agent/audit/<YYYY-MM>.json  one audit document per month, in the group's account
 *   agent/config.json           provider keys + registration, in the agent's account
 *   agent/stream.json           the stream claim, in the agent's account
 *   agent/workers/<id>.json     worker heartbeats, in the agent's account
 */

import { type Schema, Validator } from "@cfworker/json-schema";
import type { ChatMention } from "../shared/chat.js";

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export const AGENT_DIR = "agent";
export const AGENT_RULES_FILE = "rules.json";
export const AGENT_SCHEDULE_FILE = "schedule.json";
export const AGENT_CONFIG_FILE = "config.json";
export const AGENT_STREAM_FILE = "stream.json";
export const AGENT_JOBS_DIR = "jobs";
export const AGENT_DECISIONS_DIR = "decisions";
export const AGENT_CLAIMS_DIR = "claims";
export const AGENT_AUDIT_DIR = "audit";
export const AGENT_WORKERS_DIR = "workers";

/** The job/decision document name for an id. One writer, one shape. */
export function agentDocName(id: string): string {
  return `${id}.json`;
}

/** The claim document name for an area (the folder already names the account). */
export function claimDocName(area: AgentArea): string {
  return `${area}.json`;
}

/** The audit document name for a month, `YYYY-MM` (UTC). */
export function auditDocName(month?: string): string {
  return `${month ?? monthOf(new Date())}.json`;
}

/** The `YYYY-MM` an instant falls in, UTC. */
export function monthOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Areas and tiers                                                     */
/* ------------------------------------------------------------------ */

/**
 * The areas the agent's work is divided into (ADR 0003, v1 scope). A worker
 * declares which it serves; a rule belongs to exactly one. The claim unit is
 * `account × area`, so two workers never touch the same area of one account.
 */
export type AgentArea = "mail" | "files" | "tasks" | "calendars" | "contacts";

export const AGENT_AREAS: ReadonlyArray<AgentArea> = [
  "mail",
  "files",
  "tasks",
  "calendars",
  "contacts",
];

export function isAgentArea(x: unknown): x is AgentArea {
  return typeof x === "string" && (AGENT_AREAS as ReadonlyArray<string>).includes(x);
}

/**
 * How much work a rule's decision costs (ADR 0003 resolution 2): T0 is
 * deterministic and calls no model, T1 asks a small model to pick a category,
 * T2 hands the instruction to a model that decides and executes.
 */
export type AgentTier = "T0" | "T1" | "T2";

export const AGENT_TIERS: ReadonlyArray<AgentTier> = ["T0", "T1", "T2"];

export function isAgentTier(x: unknown): x is AgentTier {
  return x === "T0" || x === "T1" || x === "T2";
}

/**
 * The tiers that call a model. T0 is deterministic and has no provider, so
 * this — not `AgentTier` — is what indexes the provider configuration.
 */
export type AgentModelTier = "T1" | "T2";

export const AGENT_MODEL_TIERS: ReadonlyArray<AgentModelTier> = ["T1", "T2"];

export function isAgentModelTier(x: unknown): x is AgentModelTier {
  return x === "T1" || x === "T2";
}

/* ------------------------------------------------------------------ */
/* Actions — the capability catalogue                                  */
/* ------------------------------------------------------------------ */

/**
 * Every effect an automation can have. A rule names the ones it may run
 * (`capabilities`); the executor refuses anything outside that list, and a T2
 * model's answer is validated against it too — the model never widens its own
 * permissions.
 */
export type AgentActionName =
  | "noop"
  | "keyword.add"
  | "keyword.remove"
  | "mail.move"
  | "mail.extract"
  | "mail.draft"
  | "mail.send"
  | "chat.post"
  | "file.write";

export interface AgentAction {
  /** The capability name. */
  do: AgentActionName;
  /** Parameters; the shape each name takes is in `AGENT_ACTION_SPECS`. */
  with?: Record<string, unknown>;
}

/**
 * Where an extracted file goes when nothing determined a folder.
 *
 * A person's files are the group's Files, in the folder the automation named
 * or the model chose; when neither did, the file is not dropped in the root
 * where nobody would look for it — it lands in this one folder, which is the
 * group's signal that an automation could not decide (ADR 0003 resolution 15).
 */
export const AGENT_ATTENTION_FOLDER = "Needs attention";

export interface AgentActionParam {
  key: string;
  /** True when the executor refuses an action without it. */
  required: boolean;
  kind: "text" | "number" | "mailbox" | "folder" | "keyword";
}

export interface AgentActionSpec {
  name: AgentActionName;
  /** A short English label the admin surface shows. */
  label: string;
  /** What the action does, in one sentence, for the rule editor. */
  description: string;
  params: AgentActionParam[];
  /**
   * True when the action reaches outside the group — sending mail to anybody
   * but the group itself. The consent floor is never relaxed for these
   * (ADR 0003 resolution 10), whatever the automation's review policy says.
   */
  external?: boolean;
  /** True when the action cannot be taken back once it has run. */
  irreversible?: boolean;
}

/**
 * The action catalogue. One definition shared by the editor, the executor and
 * the model's prompt, so a capability cannot exist in one and not the others.
 */
export const AGENT_ACTION_SPECS: ReadonlyArray<AgentActionSpec> = [
  {
    name: "noop",
    label: "Do nothing",
    description: "Record the decision and change nothing.",
    params: [],
  },
  {
    name: "keyword.add",
    label: "Add a label",
    description:
      "Apply a label to the message. `G-` labels must exist in the group's catalog.",
    params: [{ key: "keyword", required: true, kind: "keyword" }],
  },
  {
    name: "keyword.remove",
    label: "Remove a label",
    description: "Remove a label from the message.",
    params: [{ key: "keyword", required: true, kind: "keyword" }],
  },
  {
    name: "mail.move",
    label: "Move the message",
    description: "Move the message to a mailbox of the group's own account.",
    params: [
      { key: "mailbox", required: true, kind: "mailbox" },
      { key: "create", required: false, kind: "text" },
    ],
  },
  {
    name: "mail.extract",
    label: "Save the attachments",
    description:
      "Write the message's attachments into a folder of the group's own Files — the folder this action names, or the one the model chose; empty means the needs-attention folder.",
    params: [{ key: "folder", required: false, kind: "folder" }],
  },
  {
    name: "mail.draft",
    label: "Prepare a draft",
    description: "Create a draft in the group's Drafts, for a person to read and send.",
    params: [
      { key: "to", required: true, kind: "text" },
      { key: "subject", required: false, kind: "text" },
      { key: "text", required: true, kind: "text" },
    ],
  },
  {
    name: "mail.send",
    label: "Send mail",
    description: "Submit mail from the group's own identity. Reaches outside the group.",
    params: [{ key: "to", required: true, kind: "text" }],
    external: true,
    irreversible: true,
  },
  {
    name: "chat.post",
    label: "Write in the chat",
    description: "Post a message in the group's chat, as the agent.",
    params: [{ key: "text", required: true, kind: "text" }],
  },
  {
    name: "file.write",
    label: "Write a file",
    description: "Write a text document into a folder of the group's Files.",
    params: [
      { key: "folder", required: true, kind: "folder" },
      { key: "name", required: true, kind: "text" },
      { key: "text", required: true, kind: "text" },
    ],
  },
];

export function agentActionSpec(name: string): AgentActionSpec | undefined {
  return AGENT_ACTION_SPECS.find((s) => s.name === name);
}

export function isAgentActionName(x: unknown): x is AgentActionName {
  return typeof x === "string" && agentActionSpec(x) !== undefined;
}

export function isAgentAction(x: unknown): x is AgentAction {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  if (!isAgentActionName(a.do)) return false;
  if (a.with === undefined) return true;
  return typeof a.with === "object" && a.with !== null && !Array.isArray(a.with);
}

/** The parameters an action is missing, given the catalogue. Empty is complete. */
export function missingActionParams(action: AgentAction): string[] {
  const spec = agentActionSpec(action.do);
  if (!spec) return [];
  const withOut = action.with ?? {};
  return spec.params
    .filter((p) => p.required && !present(withOut[p.key]))
    .map((p) => p.key);
}

function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  return typeof v !== "string" || v.trim().length > 0;
}

/**
 * Whether running these actions needs a person's explicit consent, whatever
 * the review policy says (ADR 0003 resolution 10: the external-send floor is
 * never relaxed by the threshold).
 */
export function consentRequired(actions: ReadonlyArray<AgentAction>): boolean {
  return actions.some((a) => agentActionSpec(a.do)?.external === true);
}

/** Whether any of these actions cannot be undone. */
export function irreversible(actions: ReadonlyArray<AgentAction>): boolean {
  return actions.some((a) => agentActionSpec(a.do)?.irreversible === true);
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

export type AgentTriggerOn = "email" | "filenode" | "chat" | "schedule";

export const AGENT_TRIGGERS: ReadonlyArray<AgentTriggerOn> = [
  "email",
  "filenode",
  "chat",
  "schedule",
];

export function isAgentTriggerOn(x: unknown): x is AgentTriggerOn {
  return typeof x === "string" && (AGENT_TRIGGERS as ReadonlyArray<string>).includes(x);
}

export interface AgentTrigger {
  on: AgentTriggerOn;
  /** A JMAP Email filter (RFC 8621, the subset `matchEmailFilter` implements). */
  filter?: Record<string, unknown>;
  /** `schedule` only: how often the rule runs, in minutes (>= 5). */
  everyMinutes?: number;
}

export type AgentReviewMode = "always" | "threshold" | "never";

export interface AgentReview {
  mode: AgentReviewMode;
  /** `threshold` only: at or above it the run executes unattended. */
  threshold?: number;
  /**
   * The owner's explicit raise of the external-send consent floor. Absent or
   * false means an external action always pauses for a person, whatever the
   * mode says.
   */
  allowExternal?: boolean;
}

/** One T1 category and the fixed actions it runs when the model picks it. */
export interface AgentCategory {
  name: string;
  actions: AgentAction[];
}

export interface AgentRule {
  v: 1;
  /** Stable across edits; a job records the id it was created from. */
  id: string;
  /** Bumped on every edit: an in-flight job keeps the version it started on. */
  version: number;
  name: string;
  enabled: boolean;
  area: AgentArea;
  trigger: AgentTrigger;
  tier: AgentTier;
  review: AgentReview;
  /** T2: the instruction the model receives. */
  instruction?: string;
  /** T1: the closed set of categories the classifier chooses between. */
  categories?: AgentCategory[];
  /** T0: the actions a match runs, in order. */
  actions?: AgentAction[];
  /**
   * The capability allowlist. T2's model answer is validated against it; a T0
   * rule's actions must be a subset of it. Never inferred from `actions`.
   */
  capabilities?: AgentActionName[];
  updatedAt?: string;
  updatedBy?: string;
}

/** The parsed `agent/rules.json`. */
export interface AgentRulesDoc {
  v: 1;
  rules: AgentRule[];
}

export function isAgentReview(x: unknown): x is AgentReview {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (r.mode !== "always" && r.mode !== "threshold" && r.mode !== "never") return false;
  if (r.threshold !== undefined) {
    if (typeof r.threshold !== "number" || r.threshold < 0 || r.threshold > 1)
      return false;
  }
  if (r.allowExternal !== undefined && typeof r.allowExternal !== "boolean") return false;
  // A threshold mode without a number would auto-execute everything, which is
  // the one reading the owner did not choose; refuse it rather than guess.
  return r.mode !== "threshold" || typeof r.threshold === "number";
}

function isActionList(x: unknown): x is AgentAction[] {
  return Array.isArray(x) && x.every(isAgentAction);
}

export function isAgentCategory(x: unknown): x is AgentCategory {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return typeof c.name === "string" && c.name.length > 0 && isActionList(c.actions);
}

export function isAgentTrigger(x: unknown): x is AgentTrigger {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  if (!isAgentTriggerOn(t.on)) return false;
  if (t.filter !== undefined) {
    if (!t.filter || typeof t.filter !== "object" || Array.isArray(t.filter))
      return false;
  }
  if (t.everyMinutes !== undefined) {
    if (typeof t.everyMinutes !== "number" || t.everyMinutes < 5) return false;
  }
  if (t.on === "schedule" && typeof t.everyMinutes !== "number") return false;
  return true;
}

export function isAgentRule(x: unknown): x is AgentRule {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (r.v !== 1) return false;
  if (typeof r.id !== "string" || !r.id) return false;
  if (typeof r.version !== "number" || r.version < 1) return false;
  if (typeof r.name !== "string") return false;
  if (typeof r.enabled !== "boolean") return false;
  if (!isAgentArea(r.area)) return false;
  if (!isAgentTrigger(r.trigger)) return false;
  if (!isAgentTier(r.tier)) return false;
  if (!isAgentReview(r.review)) return false;
  if (r.instruction !== undefined && typeof r.instruction !== "string") return false;
  if (
    r.categories !== undefined &&
    !(Array.isArray(r.categories) && r.categories.every(isAgentCategory))
  )
    return false;
  if (r.actions !== undefined && !isActionList(r.actions)) return false;
  if (r.capabilities !== undefined) {
    if (!Array.isArray(r.capabilities)) return false;
    if (!r.capabilities.every(isAgentActionName)) return false;
  }
  // Each tier needs the material it runs on: T2 an instruction, T1 categories,
  // T0 actions. A rule without them would match and then do nothing at all.
  if (r.tier === "T2" && typeof r.instruction !== "string") return false;
  if (r.tier === "T1" && !Array.isArray(r.categories)) return false;
  if (r.tier === "T0" && !Array.isArray(r.actions)) return false;
  return true;
}

export function isAgentRulesDoc(x: unknown): x is AgentRulesDoc {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const d = x as Record<string, unknown>;
  return d.v === 1 && Array.isArray(d.rules) && d.rules.every(isAgentRule);
}

/**
 * Why a rule cannot run, or null when it can. Used by the admin surface when
 * it saves (refuse early) and by the executor before it starts a job (refuse
 * loudly).
 */
export function ruleProblem(rule: AgentRule): string | null {
  const caps = new Set(rule.capabilities ?? []);
  const actions =
    rule.tier === "T0"
      ? (rule.actions ?? [])
      : rule.tier === "T1"
        ? (rule.categories ?? []).flatMap((c) => c.actions)
        : [];
  for (const a of actions) {
    if (!caps.has(a.do))
      return `the rule uses "${a.do}" but does not list it in its capabilities`;
    const missing = missingActionParams(a);
    if (missing.length) return `"${a.do}" is missing ${missing.join(", ")}`;
  }
  if (rule.tier === "T2" && !caps.size)
    return "a T2 rule needs at least one capability to allow";
  if (rule.tier === "T1" && !(rule.categories ?? []).length)
    return "a T1 rule needs at least one category";
  return null;
}

/* ------------------------------------------------------------------ */
/* Matching — the JMAP filter subset the executor honours              */
/* ------------------------------------------------------------------ */

/**
 * The Email properties a filter may read. Deliberately the JMAP names, so a
 * rule document reads like the RFC 8621 filter it is.
 */
export interface AgentEmailView {
  id: string;
  mailboxIds?: Record<string, boolean> | null;
  keywords?: Record<string, boolean> | null;
  receivedAt?: string | null;
  size?: number | null;
  subject?: string | null;
  from?: ReadonlyArray<AgentAddress> | null;
  to?: ReadonlyArray<AgentAddress> | null;
  cc?: ReadonlyArray<AgentAddress> | null;
  /** The plain-text body, when the caller asked Stalwart for it. */
  body?: string | null;
}

export interface AgentAddress {
  name?: string | null;
  email?: string;
}

const FILTER_OPERATORS = ["AND", "OR", "NOT"];

/**
 * Whether an email matches a rule's filter.
 *
 * The supported keys are the RFC 8621 filter grammar's common half, plus the
 * three operators. An unknown key is **refused, not ignored**: a rule that
 * asks for something the executor cannot honour must fail loudly (an
 * operator would otherwise see a rule that never fires and never know why),
 * which is what `UnsupportedFilterError` is for.
 */
export function matchEmailFilter(
  filter: Record<string, unknown> | undefined,
  email: AgentEmailView,
): boolean {
  if (!filter) return true;
  const operator = filter.operator;
  if (operator !== undefined) {
    if (typeof operator !== "string" || !FILTER_OPERATORS.includes(operator))
      throw new UnsupportedFilterError(`operator "${String(operator)}"`);
    const conditions = filter.conditions;
    if (!Array.isArray(conditions))
      throw new UnsupportedFilterError(`${operator} without conditions`);
    const results = conditions.map((c) =>
      matchEmailFilter(c as Record<string, unknown>, email),
    );
    if (operator === "AND") return results.every(Boolean);
    if (operator === "OR") return results.some(Boolean);
    return !results.some(Boolean);
  }
  for (const [key, want] of Object.entries(filter)) {
    if (!matchesKey(key, want, email)) return false;
  }
  return true;
}

export class UnsupportedFilterError extends Error {
  constructor(public readonly key: string) {
    super(`this executor does not understand the filter "${key}"`);
    this.name = "UnsupportedFilterError";
  }
}

/**
 * The filter keys this executor honours.
 *
 * One list, read by both the matcher and `unsupportedFilterKey`: a rule whose
 * filter the executor cannot evaluate has to be refused, and a second list
 * would eventually let one path accept what the other rejects.
 */
export const SUPPORTED_FILTER_KEYS: ReadonlyArray<string> = [
  "inMailbox",
  "hasKeyword",
  "notKeyword",
  "subject",
  "text",
  "body",
  "from",
  "to",
  "cc",
  "before",
  "after",
  "minSize",
  "maxSize",
];

/**
 * The first key in a filter the executor cannot evaluate, or null.
 *
 * The executor refuses such a rule before it touches any message — a rule that
 * silently never fires is indistinguishable, to the person who wrote it, from
 * a rule that matches nothing.
 */
export function unsupportedFilterKey(
  filter: Record<string, unknown> | undefined,
): string | null {
  if (!filter) return null;
  const operator = filter.operator;
  if (operator !== undefined) {
    if (typeof operator !== "string" || !FILTER_OPERATORS.includes(operator))
      return String(operator);
    const conditions = filter.conditions;
    if (!Array.isArray(conditions)) return `${operator} without conditions`;
    for (const condition of conditions) {
      const bad = unsupportedFilterKey(condition as Record<string, unknown>);
      if (bad) return bad;
    }
    return null;
  }
  for (const key of Object.keys(filter)) {
    if (!SUPPORTED_FILTER_KEYS.includes(key)) return key;
  }
  return null;
}

function matchesKey(key: string, want: unknown, email: AgentEmailView): boolean {
  const text = emailText(email);
  if (!SUPPORTED_FILTER_KEYS.includes(key)) throw new UnsupportedFilterError(key);
  switch (key) {
    case "inMailbox":
      return typeof want === "string" && email.mailboxIds?.[want] === true;
    case "hasKeyword":
      return typeof want === "string" && email.keywords?.[want] === true;
    case "notKeyword":
      return typeof want === "string" && email.keywords?.[want] !== true;
    case "subject":
      return contains(email.subject, want);
    case "text":
      return contains(text, want);
    case "body":
      return contains(email.body ?? "", want);
    case "from":
      return contains(addressesToText(email.from), want);
    case "to":
      return contains(addressesToText(email.to), want);
    case "cc":
      return contains(addressesToText(email.cc), want);
    case "before":
      return before(email.receivedAt, want);
    case "after":
      return after(email.receivedAt, want);
    case "minSize":
      return typeof want === "number" && (email.size ?? 0) >= want;
    case "maxSize":
      return typeof want === "number" && (email.size ?? 0) <= want;
    default:
      throw new UnsupportedFilterError(key);
  }
}

function contains(haystack: string | null | undefined, needle: unknown): boolean {
  if (typeof needle !== "string") return false;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

function addressesToText(list: ReadonlyArray<AgentAddress> | null | undefined): string {
  return (list ?? [])
    .map((a) => (a.name ? `${a.name} <${a.email ?? ""}>` : (a.email ?? "")))
    .join(", ");
}

function emailText(email: AgentEmailView): string {
  return [
    email.subject ?? "",
    addressesToText(email.from),
    addressesToText(email.to),
    addressesToText(email.cc),
    email.body ?? "",
  ].join("\n");
}

function before(receivedAt: string | null | undefined, want: unknown): boolean {
  if (typeof want !== "string" || !receivedAt) return false;
  return Date.parse(receivedAt) < Date.parse(want);
}

function after(receivedAt: string | null | undefined, want: unknown): boolean {
  if (typeof want !== "string" || !receivedAt) return false;
  return Date.parse(receivedAt) >= Date.parse(want);
}

/** The rules that react to one kind of trigger, in document order. */
export function rulesFor(
  rules: ReadonlyArray<AgentRule>,
  on: AgentTriggerOn,
  area?: AgentArea,
): AgentRule[] {
  return rules.filter(
    (r) => r.enabled && r.trigger.on === on && (area === undefined || r.area === area),
  );
}

/* ------------------------------------------------------------------ */
/* The review gate                                                     */
/* ------------------------------------------------------------------ */

export type ReviewOutcome = "execute" | "pause";

/**
 * Whether a run may execute unattended.
 *
 * `threshold` is what a new automation starts at, a T0 decision carries
 * confidence 1 (so `always` is how a group asks for a person on a
 * deterministic rule), and the external-send floor holds whatever the mode
 * says unless the owner has explicitly raised it.
 */
export function reviewOutcome(
  review: AgentReview,
  actions: ReadonlyArray<AgentAction>,
  confidence: number,
): ReviewOutcome {
  if (consentRequired(actions) && review.allowExternal !== true) return "pause";
  if (review.mode === "always") return "pause";
  if (review.mode === "never") return "execute";
  return confidence >= (review.threshold ?? 1) ? "execute" : "pause";
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export type AgentJobState =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed";

/** The states a job is still alive in — the ones an admin surface shows. */
export const AGENT_JOB_OPEN_STATES: ReadonlyArray<AgentJobState> = [
  "pending",
  "running",
  "awaiting_approval",
];

export interface AgentLease {
  /** The worker holding it. */
  owner: string;
  /** When that worker last said it was alive. */
  heartbeatAt: string;
}

/** What a run proposes to do — the text a person answers in the chat. */
export interface AgentProposal {
  /** One sentence a member reads in the chat. */
  summary: string;
  actions: AgentAction[];
  confidence: number;
  rationale?: string;
  /** The draft an approval sends, when the run prepared one. */
  draft?: AgentDraftRef | null;
}

export interface AgentDraftRef {
  /** The group's Drafts mailbox. */
  mailboxId: string;
  /** The draft Email id. */
  emailId: string;
}

/** What woke the rule. Exactly one of the ids is set, by `on`. */
export interface AgentTriggerRecord {
  on: AgentTriggerOn;
  emailId?: string;
  nodeId?: string;
  chatId?: string;
  /** Who caused it: a member's address when a person did. */
  by?: string;
  at: string;
}

export interface AgentJob {
  v: 1;
  id: string;
  /** The account the job works in — the group's own. */
  accountId: string;
  area: AgentArea;
  ruleId: string;
  /** Pinned at creation: an updated rule does not change a running job. */
  ruleVersion: number;
  state: AgentJobState;
  trigger: AgentTriggerRecord;
  attempts: number;
  lease?: AgentLease;
  proposal?: AgentProposal;
  decisionId?: string;
  /** The last failure, when the state is `failed`. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export function isAgentLease(x: unknown): x is AgentLease {
  if (!x || typeof x !== "object") return false;
  const l = x as Record<string, unknown>;
  return typeof l.owner === "string" && typeof l.heartbeatAt === "string";
}

export function isAgentJobState(x: unknown): x is AgentJobState {
  return (
    x === "pending" ||
    x === "running" ||
    x === "awaiting_approval" ||
    x === "done" ||
    x === "failed"
  );
}

export function isAgentTriggerRecord(x: unknown): x is AgentTriggerRecord {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  if (!isAgentTriggerOn(t.on)) return false;
  for (const k of ["emailId", "nodeId", "chatId", "by"] as const) {
    if (t[k] !== undefined && typeof t[k] !== "string") return false;
  }
  return typeof t.at === "string";
}

export function isAgentProposal(x: unknown): x is AgentProposal {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (typeof p.summary !== "string") return false;
  if (!isActionList(p.actions)) return false;
  if (typeof p.confidence !== "number") return false;
  if (p.rationale !== undefined && typeof p.rationale !== "string") return false;
  if (p.draft !== undefined && p.draft !== null) {
    const d = p.draft as Record<string, unknown>;
    if (typeof d.mailboxId !== "string" || typeof d.emailId !== "string") return false;
  }
  return true;
}

export function isAgentJob(x: unknown): x is AgentJob {
  if (!x || typeof x !== "object") return false;
  const j = x as Record<string, unknown>;
  if (j.v !== 1) return false;
  if (typeof j.id !== "string" || !j.id) return false;
  if (typeof j.accountId !== "string") return false;
  if (!isAgentArea(j.area)) return false;
  if (typeof j.ruleId !== "string" || typeof j.ruleVersion !== "number") return false;
  if (!isAgentJobState(j.state)) return false;
  if (!isAgentTriggerRecord(j.trigger)) return false;
  if (typeof j.attempts !== "number") return false;
  if (j.lease !== undefined && !isAgentLease(j.lease)) return false;
  if (j.proposal !== undefined && !isAgentProposal(j.proposal)) return false;
  if (j.decisionId !== undefined && typeof j.decisionId !== "string") return false;
  if (j.error !== undefined && typeof j.error !== "string") return false;
  return typeof j.createdAt === "string" && typeof j.updatedAt === "string";
}

/** Build a job — the one writer; the executor must not inline the shape. */
export function newJob(input: {
  id: string;
  accountId: string;
  area: AgentArea;
  rule: Pick<AgentRule, "id" | "version">;
  trigger: AgentTriggerRecord;
  now?: string;
}): AgentJob {
  const at = input.now ?? new Date().toISOString();
  return {
    v: 1,
    id: input.id,
    accountId: input.accountId,
    area: input.area,
    ruleId: input.rule.id,
    ruleVersion: input.rule.version,
    state: "pending",
    trigger: input.trigger,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
  };
}

/* ------------------------------------------------------------------ */
/* Decisions — the approval a person answers in the chat               */
/* ------------------------------------------------------------------ */

export type AgentDecisionState = "pending" | "approved" | "rejected" | "expired";

export interface AgentDecision {
  v: 1;
  id: string;
  jobId: string;
  accountId: string;
  ruleId: string;
  ruleVersion: number;
  state: AgentDecisionState;
  summary: string;
  actions: AgentAction[];
  confidence: number;
  /** The chat message carrying the proposal, so a reply can be matched. */
  chatId?: string;
  draft?: AgentDraftRef | null;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function isAgentDecisionState(x: unknown): x is AgentDecisionState {
  return x === "pending" || x === "approved" || x === "rejected" || x === "expired";
}

export function isAgentDecision(x: unknown): x is AgentDecision {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1) return false;
  for (const k of ["id", "jobId", "accountId", "ruleId", "summary"] as const) {
    if (typeof d[k] !== "string" || !d[k]) return false;
  }
  if (typeof d.ruleVersion !== "number") return false;
  if (!isAgentDecisionState(d.state)) return false;
  if (!isActionList(d.actions)) return false;
  if (typeof d.confidence !== "number") return false;
  if (d.chatId !== undefined && typeof d.chatId !== "string") return false;
  if (d.draft !== undefined && d.draft !== null) {
    const ref = d.draft as Record<string, unknown>;
    if (typeof ref.mailboxId !== "string" || typeof ref.emailId !== "string")
      return false;
  }
  if (d.decidedBy !== undefined && typeof d.decidedBy !== "string") return false;
  return typeof d.createdAt === "string" && typeof d.updatedAt === "string";
}

/** Build a decision document from a paused job's proposal. */
export function newDecision(job: AgentJob, chatId?: string): AgentDecision {
  const p = job.proposal;
  if (!p) throw new Error("a job without a proposal cannot open a decision");
  const at = new Date().toISOString();
  const doc: AgentDecision = {
    v: 1,
    id: job.decisionId ?? `${job.id}-d`,
    jobId: job.id,
    accountId: job.accountId,
    ruleId: job.ruleId,
    ruleVersion: job.ruleVersion,
    state: "pending",
    summary: p.summary,
    actions: p.actions,
    confidence: p.confidence,
    createdAt: at,
    updatedAt: at,
  };
  if (p.rationale) doc.summary = `${p.summary}\n${p.rationale}`;
  if (chatId) doc.chatId = chatId;
  if (p.draft) doc.draft = p.draft;
  return doc;
}

/* ------------------------------------------------------------------ */
/* Claims — the coordination, without a coordinator                    */
/* ------------------------------------------------------------------ */

/**
 * One worker's claim on `account × area`, with the change states it has
 * reconciled up to. The state map lives here because it is the same kind of
 * fact as the claim: whoever holds the claim owns the catch-up anchor, and a
 * worker taking over a stale claim re-reads from what the previous one
 * recorded instead of from nothing.
 */
export interface AgentClaim {
  v: 1;
  accountId: string;
  area: AgentArea;
  worker: string;
  leasedAt: string;
  heartbeatAt: string;
  /** JMAP data type → the state the worker has reconciled up to. */
  states: Record<string, string>;
}

export function isAgentClaim(x: unknown): x is AgentClaim {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  if (c.v !== 1) return false;
  if (typeof c.accountId !== "string") return false;
  if (!isAgentArea(c.area)) return false;
  if (typeof c.worker !== "string" || !c.worker) return false;
  if (typeof c.leasedAt !== "string" || typeof c.heartbeatAt !== "string") return false;
  if (!c.states || typeof c.states !== "object" || Array.isArray(c.states)) return false;
  return Object.values(c.states as Record<string, unknown>).every(
    (s) => typeof s === "string",
  );
}

/** The stream claim: exactly one worker holds the agent's EventSource (ADR §6). */
export interface AgentStreamClaim {
  v: 1;
  worker: string;
  leasedAt: string;
  heartbeatAt: string;
}

export function isAgentStreamClaim(x: unknown): x is AgentStreamClaim {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.worker === "string" &&
    typeof c.leasedAt === "string" &&
    typeof c.heartbeatAt === "string"
  );
}

/** Whether a lease is stale: its heartbeat is older than the tolerance. */
export function leaseExpired(
  heartbeatAt: string,
  now: number,
  toleranceMs: number,
): boolean {
  const at = Date.parse(heartbeatAt);
  return !Number.isFinite(at) || now - at > toleranceMs;
}

/* ------------------------------------------------------------------ */
/* Schedule                                                            */
/* ------------------------------------------------------------------ */

export interface AgentScheduleEntry {
  ruleId: string;
  /** The next instant the rule is due, UTC ISO-8601. */
  at: string;
}

export interface AgentScheduleDoc {
  v: 1;
  entries: AgentScheduleEntry[];
}

export function isAgentScheduleDoc(x: unknown): x is AgentScheduleDoc {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1 || !Array.isArray(d.entries)) return false;
  return d.entries.every((e) => {
    const s = e as Record<string, unknown>;
    return typeof s?.ruleId === "string" && typeof s?.at === "string";
  });
}

/** The next instant a `schedule` rule is due, from `now`. */
export function nextRunAfter(rule: AgentRule, now: Date): Date | null {
  const minutes = rule.trigger.everyMinutes;
  if (rule.trigger.on !== "schedule" || !minutes) return null;
  const ms = minutes * 60_000;
  const next = Math.ceil(now.getTime() / ms) * ms;
  return new Date(next > now.getTime() ? next : next + ms);
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export type AgentAuditOutcome = "done" | "failed" | "awaiting_approval" | "rejected";

export interface AgentAuditEntry {
  at: string;
  jobId: string;
  ruleId: string;
  ruleVersion: number;
  outcome: AgentAuditOutcome;
  /** Who asked: the trigger's actor, when a person did. */
  by?: string;
  actions: AgentAction[];
  /** The rule's name and the failure's message, for a readable trail. */
  detail?: string;
}

export interface AgentAuditDoc {
  v: 1;
  month: string;
  entries: AgentAuditEntry[];
}

export function isAgentAuditDoc(x: unknown): x is AgentAuditDoc {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1 || typeof d.month !== "string" || !Array.isArray(d.entries)) return false;
  return d.entries.every((e) => {
    const a = e as Record<string, unknown>;
    if (!a || typeof a !== "object") return false;
    if (typeof a.at !== "string" || typeof a.jobId !== "string") return false;
    if (typeof a.ruleId !== "string" || typeof a.ruleVersion !== "number") return false;
    if (a.outcome !== "done" && a.outcome !== "failed") {
      if (a.outcome !== "awaiting_approval" && a.outcome !== "rejected") return false;
    }
    if (a.by !== undefined && typeof a.by !== "string") return false;
    if (a.detail !== undefined && typeof a.detail !== "string") return false;
    return isActionList(a.actions);
  });
}

/* ------------------------------------------------------------------ */
/* Configuration — the agent's own account                             */
/* ------------------------------------------------------------------ */

/**
 * One model provider, for one tier. The API key is stored here and read by
 * the executor through the agent's own session; it is write-only in the admin
 * surface, the way an app password is.
 */
export interface AgentProvider {
  /** A free name for the surface: "openai", "openrouter", "ollama", … */
  provider: string;
  model: string;
  /** The OpenAI-compatible base URL. */
  baseUrl: string;
  apiKey: string;
}

export interface AgentConfigDoc {
  v: 1;
  /** The agent's own address, as the installation registered it. */
  address: string;
  registeredAt?: string;
  registeredBy?: string;
  /** Which provider serves each model tier; T0 calls no model and has no entry. */
  providers: Partial<Record<AgentModelTier, AgentProvider>>;
}

export function isAgentProvider(x: unknown): x is AgentProvider {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.provider === "string" &&
    typeof p.model === "string" &&
    typeof p.baseUrl === "string" &&
    typeof p.apiKey === "string"
  );
}

export function isAgentConfigDoc(x: unknown): x is AgentConfigDoc {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1 || typeof d.address !== "string" || !d.address) return false;
  if (!d.providers || typeof d.providers !== "object" || Array.isArray(d.providers))
    return false;
  const p = d.providers as Record<string, unknown>;
  if (p.T1 !== undefined && !isAgentProvider(p.T1)) return false;
  if (p.T2 !== undefined && !isAgentProvider(p.T2)) return false;
  return true;
}

/** One running worker's heartbeat, in the agent's own account. */
export interface AgentWorkerRecord {
  v: 1;
  id: string;
  address: string;
  areas: AgentArea[];
  /** The version the worker runs, for the status surface. */
  version: string;
  startedAt: string;
  heartbeatAt: string;
}

export function isAgentWorkerRecord(x: unknown): x is AgentWorkerRecord {
  if (!x || typeof x !== "object") return false;
  const w = x as Record<string, unknown>;
  return (
    w.v === 1 &&
    typeof w.id === "string" &&
    typeof w.address === "string" &&
    Array.isArray(w.areas) &&
    w.areas.every(isAgentArea) &&
    typeof w.version === "string" &&
    typeof w.startedAt === "string" &&
    typeof w.heartbeatAt === "string"
  );
}

/* ------------------------------------------------------------------ */
/* Validation of a rule document                                       */
/* ------------------------------------------------------------------ */

/**
 * The published schema, as the validator that enforces it.
 *
 * `@cfworker/json-schema` (MIT) is the only third-party piece the agent adds:
 * a JSON Schema validator that compiles nothing and calls no `eval`, which is
 * what lets the same rule run in the server and in the browser bundle under
 * Gilbert's strict CSP. It is built from `agentRuleJsonSchema()`, so the
 * published contract and the check are the same document.
 */
let ruleSchemaValidator: Validator | null = null;

function ruleValidator(): Validator {
  ruleSchemaValidator ??= new Validator(
    agentRuleJsonSchema() as unknown as Schema,
    "2020-12",
    false,
  );
  return ruleSchemaValidator;
}

/** Every way a document breaks the published schema, as readable lines. */
export function schemaProblems(rule: unknown): string[] {
  const result = ruleValidator().validate(rule);
  if (result.valid) return [];
  return result.errors.map((error) => {
    const where = error.instanceLocation || "/";
    return `${where} ${error.error}`;
  });
}

/**
 * Every reason a rule could not run.
 *
 * The schema first — the published contract, which the editor and any other
 * writer is held to — and then the cross-field rules a document cannot state
 * on its own: that a rule's actions are inside its capability allowlist, and
 * that each tier carries the material it runs on. One list, so the admin
 * surface refuses a rule with every reason at once instead of one per attempt.
 */
export function ruleProblems(rule: unknown): string[] {
  const problems = schemaProblems(rule);
  if (isAgentRule(rule)) {
    const extra = ruleProblem(rule);
    if (extra) problems.push(extra);
  } else if (!problems.length) {
    problems.push("this is not an automation document");
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* The chat context bound                                              */
/* ------------------------------------------------------------------ */

/**
 * The default number of messages an agent reads as context, and the hard
 * ceiling it may never widen past on its own (ADR 0003 resolution 11).
 */
export const CHAT_CONTEXT_DEFAULT = 50;
export const CHAT_CONTEXT_MAX = 300;

/** What a member asks for, clamped: the default, or a raise up to the ceiling. */
export function clampChatContext(requested?: number | null): number {
  if (requested === undefined || requested === null || !Number.isFinite(requested))
    return CHAT_CONTEXT_DEFAULT;
  const n = Math.floor(requested);
  if (n < 1) return CHAT_CONTEXT_DEFAULT;
  return Math.min(n, CHAT_CONTEXT_MAX);
}

/* ------------------------------------------------------------------ */
/* Chat plumbing shared with the executor                              */
/* ------------------------------------------------------------------ */

/** A chat message the agent is expected to answer, and why. */
export interface AgentChatRequest {
  messageId: string;
  author: string;
  text: string;
  mentions: ChatMention[];
  /** True when the message is a direct reply to one of the agent's own. */
  reply: boolean;
}

/* ------------------------------------------------------------------ */
/* The published schema of a rule document                             */
/* ------------------------------------------------------------------ */

/**
 * The rule document as a standard JSON Schema (draft 2020-12).
 *
 * ADR 0003 resolution 2 asks for exactly this: an automation is a JSON
 * document validated against a standard schema — no new rule language — with
 * the JMAP filter grammar for matching and named, capability-gated actions for
 * effects. The schema is **derived** from the same constants the runtime
 * validator reads (areas, tiers, triggers, and `AGENT_ACTION_SPECS` for the
 * capability names), so there is no second list of what a rule may say; the
 * drift is caught by the test that builds this and checks the enums against
 * those constants.
 *
 * What the schema cannot express is the *cross-field* half — a T2 rule needs
 * an instruction, a T1 rule needs categories, a threshold needs its number —
 * and that stays in `isAgentRule` and `ruleProblem`, which is what the admin
 * API validates with. The schema is the published contract for anything
 * outside this codebase; the guards are the enforcer inside it.
 */
export function agentRuleJsonSchema(): Record<string, unknown> {
  const actionSchema = {
    type: "object",
    required: ["do"],
    additionalProperties: false,
    properties: {
      do: { enum: AGENT_ACTION_SPECS.map((spec) => spec.name) },
      with: {
        type: "object",
        additionalProperties: true,
        description:
          "This action's parameters; the names each action takes are published in the same document's `x-actions`.",
      },
    },
  };
  const actionList = { type: "array", items: actionSchema };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://gilbert.invalid/schemas/agent-rule.json",
    title: "Gilbert agent rule",
    description:
      "One automation: what wakes it, how much work its decision may cost, and what it may do about it (ADR 0003).",
    type: "object",
    required: [
      "v",
      "id",
      "version",
      "name",
      "enabled",
      "area",
      "trigger",
      "tier",
      "review",
    ],
    additionalProperties: true,
    properties: {
      v: { const: 1 },
      id: { type: "string", minLength: 1 },
      version: { type: "integer", minimum: 1 },
      name: { type: "string" },
      enabled: { type: "boolean" },
      area: { enum: [...AGENT_AREAS] },
      tier: { enum: [...AGENT_TIERS] },
      trigger: {
        type: "object",
        required: ["on"],
        additionalProperties: false,
        properties: {
          on: { enum: [...AGENT_TRIGGERS] },
          filter: {
            type: "object",
            description:
              "A JMAP Email filter (RFC 8621). The executor honours the subset listed in `x-filterKeys`; a key outside it is refused loudly, never ignored.",
          },
          everyMinutes: { type: "number", minimum: 5 },
        },
        allOf: [
          {
            if: { properties: { on: { const: "schedule" } }, required: ["on"] },
            then: { required: ["everyMinutes"] },
          },
        ],
      },
      review: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          mode: { enum: ["always", "threshold", "never"] },
          threshold: { type: "number", minimum: 0, maximum: 1 },
          allowExternal: { type: "boolean" },
        },
        allOf: [
          {
            if: { properties: { mode: { const: "threshold" } }, required: ["mode"] },
            then: { required: ["threshold"] },
          },
        ],
      },
      instruction: { type: "string", description: "T2: what the model is asked to do." },
      categories: {
        type: "array",
        description: "T1: the closed set the classifier chooses between.",
        items: {
          type: "object",
          required: ["name", "actions"],
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1 }, actions: actionList },
        },
      },
      actions: { ...actionList, description: "T0: what a match runs, in order." },
      capabilities: {
        type: "array",
        items: { enum: AGENT_ACTION_SPECS.map((spec) => spec.name) },
        description:
          "The allowlist: the only actions this rule may run. A model answer outside it is refused.",
      },
      updatedAt: { type: "string" },
      updatedBy: { type: "string" },
    },
    "x-actions": AGENT_ACTION_SPECS.map((spec) => ({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      external: spec.external === true,
      irreversible: spec.irreversible === true,
      params: spec.params,
    })),
    "x-filterKeys": [...SUPPORTED_FILTER_KEYS],
  };
}
