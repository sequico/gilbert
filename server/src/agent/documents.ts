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
 *   agent/claim.json            the account's claim, in the group's account
 *   agent/audit/<YYYY-MM>.json  one audit document per month, in the group's account
 *   agent/config.json           provider keys + registration, in the agent's account
 *   agent/stream.json           the stream claim, in the agent's account
 *   agent/workers/<id>.json     worker heartbeats, in the agent's account
 */

import { type Schema, Validator } from "@cfworker/json-schema";
import type { ChatMention } from "../shared/chat.js";
import { countOrNull } from "../shared/counts.js";
import { AGENT_PAGES_DEFAULT } from "../shared/installation.js";
import { isRecord } from "../shared/json.js";

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
export const AGENT_CLAIM_FILE = "claim.json";
export const AGENT_AUDIT_DIR = "audit";
export const AGENT_WORKERS_DIR = "workers";
/**
 * Where the installation's own authoring calls are counted, in the Master's
 * account: one document a month, beside the runs' audit rather than in it
 * (ADR 0003). A reading is not a run, so it is not a group's ledger that holds
 * it.
 */
export const AGENT_AUTHORING_DIR = "authoring";

/** The job/decision document name for an id. One writer, one shape. */
export function agentDocName(id: string): string {
  return `${id}.json`;
}

/** The audit document name for a month, `YYYY-MM` (UTC). */
export function auditDocName(month?: string): string {
  const name = month ?? monthOf(new Date());
  // The name is the month, in the one shape `monthOf` writes: two processes
  // that spelled the same month differently would write two documents for it,
  // and neither would hold the whole trail.
  if (!/^\d{4}-\d{2}$/.test(name))
    throw new Error(`"${name}" is not a month: an audit document is named YYYY-MM`);
  return `${name}.json`;
}

/** The `YYYY-MM` an instant falls in, UTC. */
export function monthOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Every month from `from`'s to `to`'s, oldest first, UTC.
 *
 * The audit's retention is a window of whole months: the prune drops a
 * document by its month, so this is the list of months a reader can still find
 * — and the list a copy of the trail covers, no wider and no narrower. A
 * `YYYY-MM` sorts as it reads, which is why the comparison is the whole rule.
 */
export function monthsSince(from: Date, to: Date): string[] {
  const months: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = monthOf(to);
  for (;;) {
    const month = monthOf(cursor);
    if (month > last) return months;
    months.push(month);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
}

/* ------------------------------------------------------------------ */
/* Actions — the capability catalogue                                  */
/* ------------------------------------------------------------------ */

/**
 * Every effect an automation can have. A rule names the ones it may run
 * (`capabilities`); the executor refuses anything outside that list, and the
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
  | "file.write"
  | "notebook.write"
  | "document.read"
  | "document.split"
  | "document.merge"
  | "document.extract";

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
  /**
   * The area the authoring surface groups this action under, absent for the
   * two entries that answer for themselves (`noop`, and sending, which is
   * excluded from every area by its own flags rather than by a list).
   */
  area?: AgentArea;
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
  /**
   * True when running the action twice is not the same as running it once: it
   * leaves something a person will find, and a second attempt files a second
   * copy beside the first. A run whose plan holds one of these is not retried
   * (resolution 20), and what a retry asks is `leavesTheProcess`. The flag is
   * deliberately not `irreversible`, which also asks a person first.
   */
  unrepeatable?: boolean;
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
    area: "mail",
    label: "Add a label",
    description:
      "Apply a label to the message. `G-` labels must exist in the group's catalog.",
    params: [{ key: "keyword", required: true, kind: "keyword" }],
  },
  {
    name: "keyword.remove",
    area: "mail",
    label: "Remove a label",
    description: "Remove a label from the message.",
    params: [{ key: "keyword", required: true, kind: "keyword" }],
  },
  {
    name: "mail.move",
    area: "mail",
    label: "Move the message",
    description: "Move the message to a mailbox of the group's own account.",
    params: [
      { key: "mailbox", required: true, kind: "mailbox" },
      { key: "create", required: false, kind: "text" },
    ],
  },
  {
    name: "mail.extract",
    area: "mail",
    label: "Save the attachments",
    description:
      "Write the message's attachments into a folder of the group's own Files — the folder this action names, or the one the model chose; empty means the needs-attention folder.",
    params: [{ key: "folder", required: false, kind: "folder" }],
    unrepeatable: true,
  },
  {
    name: "mail.draft",
    area: "mail",
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
    area: "mail",
    label: "Send mail",
    description: "Submit mail from the group's own identity. Reaches outside the group.",
    params: [{ key: "to", required: true, kind: "text" }],
    external: true,
    irreversible: true,
  },
  {
    name: "chat.post",
    area: "chat",
    label: "Write in the chat",
    description: "Post a message in the group's chat, as the agent.",
    params: [{ key: "text", required: true, kind: "text" }],
  },
  {
    name: "file.write",
    area: "files",
    label: "Write a file",
    description: "Write a text document into a folder of the group's Files.",
    params: [
      { key: "folder", required: true, kind: "folder" },
      { key: "name", required: true, kind: "text" },
      { key: "text", required: true, kind: "text" },
    ],
    unrepeatable: true,
  },
  {
    name: "notebook.write",
    area: "files",
    label: "Remember a fact",
    description:
      "Write a fact into the group's notebook — the memory every later run of this group is given. With an `id` it replaces that fact's text, or removes the fact when the text is empty; without one it adds a new fact, and then the text is required.",
    params: [
      { key: "text", required: false, kind: "text" },
      { key: "id", required: false, kind: "text" },
    ],
    unrepeatable: true,
  },
  {
    name: "document.read",
    area: "files",
    label: "Read a document",
    description:
      "Read a file of the group's Files as text: a PDF's own text layer, a .docx, a spreadsheet's sheets (.xls, .xlsx, one block per sheet), or a text file (.csv, .txt and the other plain-text types). It answers with the text and names the pages that carry none — those are read by the model, as images, when a run is woken by the file — and says when a text or a workbook was longer than one reading carries. An image file (.png, .jpg/.jpeg, .gif, .webp) carries no text of its own and is handed to the model whole, as a picture, the same way a scanned page is.",
    params: [{ key: "file", required: false, kind: "text" }],
  },
  {
    name: "document.split",
    area: "files",
    label: "Split a PDF into pages",
    description:
      "Write every page of a PDF of the group's Files as a PDF of its own, into a folder of the group's Files.",
    params: [
      { key: "file", required: false, kind: "text" },
      { key: "folder", required: false, kind: "folder" },
    ],
    unrepeatable: true,
  },
  {
    name: "document.extract",
    area: "files",
    label: "Extract pages",
    description:
      'Cut pages out of a PDF of the group\'s Files into one new PDF: "2-4,7" is pages 2, 3, 4 and 7.',
    params: [
      { key: "file", required: false, kind: "text" },
      { key: "pages", required: true, kind: "text" },
      { key: "folder", required: false, kind: "folder" },
      { key: "name", required: false, kind: "text" },
    ],
    unrepeatable: true,
  },
  {
    name: "document.merge",
    area: "files",
    label: "Merge PDFs",
    description:
      "Join PDFs of the group's Files, in the order given, into one new PDF: the paths one per line, in the order they are to be joined.",
    params: [
      { key: "files", required: true, kind: "text" },
      { key: "folder", required: false, kind: "folder" },
      { key: "name", required: false, kind: "text" },
    ],
    unrepeatable: true,
  },
];

/* ------------------------------------------------------------------ */
/* The areas an author grants                                            */
/* ------------------------------------------------------------------ */

/**
 * The three groups of actions an administrator grants, plus the two entries
 * that stand beside them.
 *
 * An area is a **grouping of the catalogue**, never a second list of actions:
 * what it expands to is computed from `AGENT_ACTION_SPECS` by
 * `areaActions`, so an action added to the catalogue is granted by whichever
 * area it belongs to without this file being revisited, and an action that
 * leaves the group or cannot be undone is excluded from every area by the
 * flags it already carries.
 */
export type AgentArea = "mail" | "chat" | "files";

export const AGENT_AREAS: ReadonlyArray<AgentArea> = ["mail", "chat", "files"];

/**
 * What each area is called, as English source text the surfaces translate.
 *
 * One table, read by the editor on both sides of the wire the way the action
 * labels are: the English here is the key a catalogue looks up.
 */
export const AGENT_AREA_LABELS: Record<AgentArea, string> = {
  mail: "Mail",
  chat: "Chat",
  files: "Files and documents",
};

/**
 * The actions one area grants.
 *
 * An area never grants an action that reaches outside the group or cannot be
 * undone: the exclusion is read off `external` and `irreversible`, so a future
 * action carrying either flag leaves every area the same way without a list
 * being kept in step. Ticking an area can therefore never be how a person
 * grants sending — only the sending entry can.
 *
 * `specs` is a parameter so the rule is testable against a catalogue this
 * build does not have: the exclusion is a property of the rule, not of the
 * thirteen actions it happens to be pointed at today.
 */
export function areaActions(
  area: AgentArea,
  specs: ReadonlyArray<AgentActionSpec> = AGENT_ACTION_SPECS,
): AgentActionName[] {
  return specs
    .filter(
      (spec) =>
        spec.area === area && spec.external !== true && spec.irreversible !== true,
    )
    .map((spec) => spec.name);
}

/**
 * The actions no area grants, for the entries that answer for themselves.
 *
 * Derived the same way as an area: what stands beside the areas is a flag on
 * the catalogue (`area` absent) and never a list kept here. Sending is in it
 * because `areaActions` excludes it from the area it belongs to, not because
 * this function knows its name.
 */
export function standaloneActions(
  specs: ReadonlyArray<AgentActionSpec> = AGENT_ACTION_SPECS,
): AgentActionName[] {
  const inAreas = new Set(AGENT_AREAS.flatMap((area) => areaActions(area, specs)));
  return specs.map((spec) => spec.name).filter((name) => !inAreas.has(name));
}

/**
 * The grant a run actually carries: the rule's own, plus the answer "record the
 * decision and change nothing".
 *
 * A run may only answer with an action its rule allows, and `noop` is not a
 * behaviour — it is how a run says it decided nothing should happen. Leaving it
 * out of the document rather than out of the grant is what keeps the allowlist
 * the whole boundary: nothing here widens what the model may *do*, it only lets
 * it decline. One function, read by the executor's check and by the prompt, so
 * the two cannot disagree about what a run may answer.
 */
export function effectiveCapabilities(
  rule: Pick<AgentRule, "capabilities">,
): AgentActionName[] {
  if (rule.capabilities.includes("noop")) return [...rule.capabilities];
  return [...rule.capabilities, "noop"];
}

/**
 * The actions that leave the process: sending, posting, drafting, filing.
 *
 * Named here rather than read off the specs' flags, because those flags answer
 * three other questions — `external` is the consent floor (resolution 10),
 * `irreversible` asks a person whatever the rule says, `unrepeatable` is about
 * a second copy nobody asked for — and two of the actions a person ends up
 * reading carry none of them: a posted chat message and a prepared draft are
 * effects in the group's own state, and a run whose claim a successor took must
 * not produce a second one. The document family's page work is here for the
 * same reason a file write is: what it produces is a file the group can see,
 * and a second pass leaves a second copy beside it. A notebook write is here
 * because what it writes is read by every later run of the group: a second pass
 * that adds the same fact again is a memory a person has to clean up.
 *
 * The set is the authority for `leavesTheProcess`, which is what the executor's
 * fence and the retry decision both ask: one list, so an action cannot be
 * fenced in one place and repeatable in the other.
 */
export const FENCED_ACTIONS: ReadonlySet<AgentActionName> = new Set<AgentActionName>([
  "mail.send",
  "chat.post",
  "mail.draft",
  "file.write",
  "notebook.write",
  "mail.extract",
  "document.split",
  "document.merge",
  "document.extract",
]);

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
  return isRecord(a.with);
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
 * One action's parameters, as the `key: value` list both tiers render.
 *
 * The catalogue says which parameters an action takes; this says how they read
 * when a person is shown the action itself — the approval prompt a member
 * answers in the group's chat, and the member's panel. One renderer, so "what
 * would it do" cannot be one list of parameters to a member and another to the
 * person approving the same run. A value the catalogue does not describe (a
 * parameter named by hand in an old document) is shown as it was written
 * rather than dropped.
 */
export function actionParamsText(action: Pick<AgentAction, "with">): string {
  return Object.entries(action.with ?? {})
    .map(([key, value]) => `${key}: ${paramValueText(value)}`)
    .join(", ");
}

function paramValueText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value) ?? "";
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

/**
 * Whether one action leaves the process: it sends, posts, drafts or files.
 *
 * This is the set a run must not repeat, and it is also what the fence asks
 * about before an action runs: a label or a mailbox move is either idempotent
 * or harmless to do twice, so a retry may redo it. A message that has left
 * cannot be recalled, a second send is a second message, an extraction or a
 * file the group can see leaves a duplicate beside itself, and a posted message
 * or a prepared draft is read by a person who cannot tell it from the one they
 * were already shown.
 *
 * The answer is `FENCED_ACTIONS`, not the spec's flags: `chat.post` and
 * `mail.draft` reach people without being `external`, `irreversible` or
 * `unrepeatable`, and a fence that read the flags would let a run whose claim a
 * successor took post in the group's chat again.
 */
export function leavesTheProcess(action: AgentAction): boolean {
  return FENCED_ACTIONS.has(action.do);
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

/**
 * Whether this is what woke a job: a rule's four, or a person.
 *
 * Separate from `isAgentTriggerOn` on purpose: a rule may not be woken by a
 * person (ADR 0003 — the ask is a job's provenance, and a rule that could carry
 * it would have to say what it acts on), while a job a person asked for is a run
 * like any other and validates as one. One predicate each, so neither the rule
 * path nor the job path can accept the other's answer.
 */
export function isAgentJobTriggerOn(x: unknown): x is AgentJobTriggerOn {
  return x === "manual" || isAgentTriggerOn(x);
}

export interface AgentTrigger {
  on: AgentTriggerOn;
  /** `schedule` only: how often the rule runs, in minutes (>= 5). */
  everyMinutes?: number;
}

/**
 * What each trigger is called where a name is needed (ADR 0006).
 *
 * An automation is not named by its author: with one enabled automation per
 * trigger (ADR 0006 decision one) the trigger *is* the name, and deriving it is
 * what keeps a name from becoming a field nobody needs to fill in. English
 * source text, translated where it is shown, like the action labels.
 */
export const AGENT_AUTOMATION_LABELS: Record<AgentTriggerOn, string> = {
  email: "Mail automation",
  filenode: "File automation",
  chat: "Chat automation",
  schedule: "Scheduled automation",
};

/**
 * What an automation is called when its own document is gone.
 *
 * A run outlives the rule it was created from — a job is pinned to a version a
 * person may have deleted since, and an approval is answered in the chat after
 * the fact — and the trail is read a year later, when the document may be gone
 * for good. The line still needs a name, and the honest one says that: what the
 * automation *was* is in the trigger record the job carries, and the wording of
 * what happened is in the entry's own detail.
 */
export const GONE_AUTOMATION_LABEL = "An automation that no longer exists";

/**
 * The name of an automation: the trigger it stands on.
 *
 * One function for every reader — the prompt, the log, the chat the agent
 * speaks in, the audit's readable line, the member's panel — so an automation
 * answers to one name everywhere (ADR 0006). A trigger is optional because a
 * caller may be naming a run whose rule document is already gone:
 * `GONE_AUTOMATION_LABEL` is what that answers, and it is the only other
 * answer this function has.
 */
export function automationLabel(rule: { trigger?: AgentTrigger }): string {
  const on = rule.trigger?.on;
  if (!on) return GONE_AUTOMATION_LABEL;
  return AGENT_AUTOMATION_LABELS[on];
}

/**
 * The cadences an author may choose, in minutes.
 *
 * A scheduled automation is not asked "every how many minutes": three presets
 * are the whole choice, because the interval is not what the automation is
 * *about* (ADR 0006). The document still carries a number, so a rule written
 * before this table or by hand keeps the interval it states.
 */
export const AGENT_SCHEDULE_PRESETS = [60, 1440, 10080] as const;

/** One of the cadences the editor offers, as the interval it stands for. */
export type AgentScheduleMinutes = (typeof AGENT_SCHEDULE_PRESETS)[number];

/** What a scheduled automation runs at when its document states no interval. */
export const AGENT_SCHEDULE_MINUTES_DEFAULT = 60;

/**
 * The interval a scheduled automation runs at.
 *
 * One reader for the schedule planner, the prompt's own sentence and every
 * surface that shows the cadence: a document that states none falls back here
 * rather than at each call site, so "every hour" means one thing.
 */
export function scheduleMinutesOf(rule: Pick<AgentRule, "trigger">): number {
  return rule.trigger.everyMinutes ?? AGENT_SCHEDULE_MINUTES_DEFAULT;
}

export interface AgentRule {
  v: 1;
  /** Stable across edits; a job records the id it was created from. */
  id: string;
  /** Bumped on every edit: an in-flight job keeps the version it started on. */
  version: number;
  enabled: boolean;
  trigger: AgentTrigger;
  /**
   * The prose its administrator wrote, and the whole of what a run is asked to
   * do: every run hands it to the model, which answers with actions from the
   * catalogue (ADR 0003). There is no compiled form to keep in step with it.
   */
  instruction: string;
  /**
   * The capability allowlist: the only actions this rule may run. The model is
   * offered these and nothing else, and an answer outside them is refused, so
   * the instruction steers inside the grant and never widens it. "Do nothing"
   * is not listed: it is not a capability but the absence of one, and
   * `effectiveCapabilities` adds it to every grant.
   */
  capabilities: AgentActionName[];
  updatedAt?: string;
  updatedBy?: string;
}

/** The parsed `agent/rules.json`. */
export interface AgentRulesDoc {
  v: 1;
  rules: AgentRule[];
}

function isActionList(x: unknown): x is AgentAction[] {
  return Array.isArray(x) && x.every(isAgentAction);
}

export function isAgentTrigger(x: unknown): x is AgentTrigger {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  if (!isAgentTriggerOn(t.on)) return false;
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
  if (typeof r.enabled !== "boolean") return false;
  if (!isAgentTrigger(r.trigger)) return false;
  if (typeof r.instruction !== "string") return false;
  if (!Array.isArray(r.capabilities)) return false;
  if (!r.capabilities.every(isAgentActionName)) return false;
  return true;
}

export function isAgentRulesDoc(x: unknown): x is AgentRulesDoc {
  if (!isRecord(x)) return false;
  const d = x as Record<string, unknown>;
  return d.v === 1 && Array.isArray(d.rules) && d.rules.every(isAgentRule);
}

/**
 * Why a rule cannot run, or null when it can. Used by the admin surface when
 * it saves (refuse early) and by the executor before it starts a job (refuse
 * loudly).
 */
export function ruleProblem(rule: AgentRule): string | null {
  if (!rule.instruction.trim())
    return "the rule needs an instruction: it is what the model is asked to do";
  if (!rule.capabilities.length)
    return "the rule needs at least one capability to allow: with none it could do nothing";
  return null;
}

/**
 * Why a whole list of automations could not be stored, or null.
 *
 * An automation is a trigger, its prose and its grant — it carries no filter,
 * so nothing in the document tells two automations on one trigger apart, and
 * the executor runs **every** enabled automation on a trigger against **every**
 * item that trigger produces (ADR 0006 decision one). Two enabled automations
 * on one trigger are therefore not two halves of a job: both answer the same
 * arrival, and a member reads two replies to one question. One per trigger is
 * the only correct count, and this is where that is said — in one function the
 * admin surface and the executor both ask.
 *
 * A disabled automation is a draft: it wakes nothing, so it may sit beside the
 * enabled one while its author decides to replace it. The count is of enabled
 * automations, not of documents.
 */
export function rulesProblem(rules: ReadonlyArray<AgentRule>): string | null {
  const seen = new Map<AgentTriggerOn, number>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    seen.set(rule.trigger.on, (seen.get(rule.trigger.on) ?? 0) + 1);
  }
  for (const on of AGENT_TRIGGERS) {
    const count = seen.get(on) ?? 0;
    if (count > 1)
      return (
        `${count} enabled automations share the "${on}" trigger, and the executor ` +
        "runs every one of them on every item that trigger produces: " +
        "leave one enabled per trigger"
      );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* A message, as a run reads it                                        */
/* ------------------------------------------------------------------ */

/**
 * The Email properties a run reads of the message that woke it. Deliberately
 * the JMAP names, so what the executor renders is the record the server sent.
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

/** The rules that react to one kind of trigger, in document order. */
export function rulesFor(
  rules: ReadonlyArray<AgentRule>,
  on: AgentTriggerOn,
): AgentRule[] {
  return rules.filter((r) => r.enabled && r.trigger.on === on);
}

/* ------------------------------------------------------------------ */
/* The review gate, and the group's policy document                     */
/* ------------------------------------------------------------------ */

/**
 * The group's policy: who a run stops for, and whether it may reach outside.
 *
 * It is one document per group (`agent/policy.json` in the group's own
 * account) rather than a field on every automation. The question it answers —
 * how cautious this group wants its agent to be — is a fact about the group:
 * two automations of one group are the same team's work on the same
 * correspondence, and a policy repeated per automation is a policy that drifts
 * apart. The grant of *what* an automation may do stays on the automation;
 * this is only what happens before it does it.
 */
export interface AgentGroupPolicyDoc {
  v: 1;
  review: AgentReviewMode;
  /**
   * The group's explicit raise of the external-send consent floor. False means
   * an action that reaches outside the group always pauses for a person,
   * whatever the mode says.
   */
  allowExternal: boolean;
  updatedAt: string;
  updatedBy: string;
}

export const AGENT_POLICY_FILE = "agent/policy.json";

export type AgentReviewMode = "always" | "threshold" | "never";

export const AGENT_REVIEW_MODES: ReadonlyArray<AgentReviewMode> = [
  "always",
  "threshold",
  "never",
];

/**
 * The confidence a `threshold` policy treats as sure enough to go unattended.
 *
 * One number, not a field: an author choosing "run it unattended when the model
 * is confident" is choosing the behaviour, not a decimal, and a form that asked
 * for the decimal made every author invent one (ADR 0006). An installation that
 * wants a different number changes this constant, and `planFor`'s prompt and
 * the gate read it from here, so the two cannot disagree about what "confident"
 * means.
 */
export const AGENT_REVIEW_THRESHOLD = 0.7;

/**
 * A group that has written no policy: a run goes ahead when the model is
 * confident, and stops for a person when it is not.
 *
 * Nothing has said how cautious this group wants to be, so the reading is the
 * one a butler needs to be useful at all: an in-group, reversible action that
 * the model is sure of happens, and one it is unsure of becomes a question.
 * "Sure" is `AGENT_REVIEW_THRESHOLD` and never a number an author invents, and
 * the floors hold whatever this says — an action that leaves the group or
 * cannot be undone still asks a person. A group's policy is authored where its
 * automations are, and this is what a group that has never opened that form
 * answers with.
 */
export const EMPTY_GROUP_POLICY: Omit<AgentGroupPolicyDoc, "updatedAt" | "updatedBy"> = {
  v: 1,
  review: "threshold",
  allowExternal: false,
};

export function isAgentGroupPolicyDoc(x: unknown): x is AgentGroupPolicyDoc {
  if (!isRecord(x)) return false;
  const d = x as Record<string, unknown>;
  return (
    d.v === 1 &&
    (AGENT_REVIEW_MODES as ReadonlyArray<string>).includes(String(d.review)) &&
    typeof d.allowExternal === "boolean" &&
    typeof d.updatedAt === "string" &&
    typeof d.updatedBy === "string"
  );
}

/**
 * The policy a run is held to, as a document or as the default.
 *
 * One reader for the two shapes a caller has — the document or nothing — so the
 * executor and the member's panel cannot read "no policy" two different ways.
 */
export function policyOf(
  doc: AgentGroupPolicyDoc | null,
): Pick<AgentGroupPolicyDoc, "review" | "allowExternal"> {
  if (!doc)
    return {
      review: EMPTY_GROUP_POLICY.review,
      allowExternal: EMPTY_GROUP_POLICY.allowExternal,
    };
  return { review: doc.review, allowExternal: doc.allowExternal };
}

export type ReviewOutcome = "execute" | "pause";

/**
 * Whether a run may execute unattended.
 *
 * The group's policy decides how cautious its runs are; the automated floors
 * decide what no policy may relax. An action that reaches outside the group
 * needs a person unless the group has raised that floor on purpose, and an
 * action that cannot be undone asks whatever the policy says — today's only
 * irreversible action also sends, and the two flags must not be able to drift
 * apart into an irreversible effect nobody was asked about.
 */
export function reviewOutcome(
  policy: Pick<AgentGroupPolicyDoc, "review" | "allowExternal">,
  actions: ReadonlyArray<AgentAction>,
  confidence: number,
): ReviewOutcome {
  if (consentRequired(actions) && policy.allowExternal !== true) return "pause";
  if (irreversible(actions)) return "pause";
  if (policy.review === "always") return "pause";
  if (policy.review === "never") return "execute";
  return confidence >= AGENT_REVIEW_THRESHOLD ? "execute" : "pause";
}

/* ------------------------------------------------------------------ */
/* What a run may look up                                              */
/* ------------------------------------------------------------------ */

/**
 * How many times one run may look something up before it has to decide.
 *
 * A run's context is what it was handed; a butler's is what it goes and reads.
 * The deciding call may answer with a lookup instead of actions, the run
 * performs it and asks again — and this is how many times, so a model that
 * would rather keep reading than answer is stopped by the run rather than
 * trusted (ADR 0020). The count is of lookups, not of calls: one more call is
 * made with the last lookup's result, and its prompt says the budget is spent.
 */
export const AGENT_LOOKUP_ROUNDS = 3;

/**
 * The most messages one lookup lists.
 *
 * A listing carries headers and an id, never a body: a run that wants what a
 * message says names it back in a `message` lookup. That is what keeps a
 * butler's reading cheap — the index is paid for once and the content only for
 * the one item the run actually needs (ADR 0006 decision three, ADR 0020).
 */
export const AGENT_LOOKUP_MESSAGES_MAX = 20;

/**
 * The most characters of one read item's own text.
 *
 * One message or one file at this ceiling, not a mailbox and not a folder: the
 * narrow, named tail ADR 0006 decision three describes, and a document longer
 * than it arrives as the beginning of itself.
 */
export const AGENT_LOOKUP_TEXT_MAX = 2000;

/** The longest name, keyword, address or path a lookup may carry. */
export const AGENT_LOOKUP_PARAM_MAX = 200;

/** The longest search query a lookup may carry. */
export const AGENT_LOOKUP_QUERY_MAX = 500;

/** The most nodes one whole-tree `files` listing hands a run. */
export const AGENT_LOOKUP_FILES_MAX = 200;

/** How deep a whole-tree `files` listing walks, from the folder it starts at. */
export const AGENT_LOOKUP_DEPTH_MAX = 4;

/**
 * Something a run asked to read, from the closed catalogue in `AGENT_LOOKUP_KINDS`.
 *
 * The model chooses a kind and its parameters and nothing else: it never writes
 * a query, a filter or a JMAP method. The catalogue is the group's own state as
 * its members see it — its mail (by folder, label, sender, text or unread), one
 * message of it, its folders, its labels, its visible Files and one file of
 * them, and its chat — because the context a butler needs is the group's, not
 * one label's. Every shape is a read of the group's own account, and none of
 * them writes anything (ADR 0020).
 */
export type AgentLookup =
  | { kind: "mail"; query?: string; limit?: number }
  | { kind: "message"; id: string }
  | { kind: "mailboxes" }
  | { kind: "labels" }
  | { kind: "files"; folder?: string; deep?: boolean; name?: string }
  | { kind: "file"; path: string }
  | { kind: "chat"; query?: string; limit?: number };

export type AgentLookupKind = AgentLookup["kind"];

export const AGENT_LOOKUP_KINDS: ReadonlyArray<AgentLookupKind> = [
  "mail",
  "message",
  "mailboxes",
  "labels",
  "files",
  "file",
  "chat",
];

function lookupParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > AGENT_LOOKUP_PARAM_MAX) return null;
  return text;
}

/** An optional string parameter: absent is fine, present must be a name. */
function optionalParam(x: Record<string, unknown>, key: string): boolean {
  return x[key] === undefined || lookupParam(x[key]) !== null;
}

/** An optional search query: absent or empty is the unfiltered listing. */
function optionalQuery(x: Record<string, unknown>, key: string): boolean {
  const value = x[key];
  if (value === undefined) return true;
  return typeof value === "string" && value.length <= AGENT_LOOKUP_QUERY_MAX;
}

/**
 * Whether an answer names only the fields its kind has.
 *
 * A parameter this build no longer reads must be refused rather than ignored:
 * a lookup that carried yesterday's `starred` and is accepted as "no query"
 * answers a question about starred mail from the whole mailbox, which is the
 * silent widening every answer here exists to prevent (ADR 0020).
 */
function onlyKeys(x: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  return Object.keys(x).every((key) => allowed.includes(key));
}

/** An optional count: absent is fine, present must be within the listing bound. */
function optionalLimit(x: Record<string, unknown>): boolean {
  const value = x.limit;
  if (value === undefined) return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= AGENT_LOOKUP_MESSAGES_MAX
  );
}

export function isAgentLookup(x: unknown): x is AgentLookup {
  if (!isRecord(x)) return false;
  switch (x.kind) {
    case "mail":
      return (
        onlyKeys(x, ["kind", "query", "limit"]) &&
        optionalQuery(x, "query") &&
        optionalLimit(x)
      );
    case "message":
      return onlyKeys(x, ["kind", "id"]) && lookupParam(x.id) !== null;
    case "mailboxes":
    case "labels":
      return onlyKeys(x, ["kind"]);
    case "files":
      return (
        onlyKeys(x, ["kind", "folder", "deep", "name"]) &&
        optionalParam(x, "folder") &&
        optionalParam(x, "name") &&
        (x.deep === undefined || typeof x.deep === "boolean")
      );
    case "file":
      return onlyKeys(x, ["kind", "path"]) && lookupParam(x.path) !== null;
    case "chat":
      return (
        onlyKeys(x, ["kind", "query", "limit"]) &&
        optionalQuery(x, "query") &&
        optionalLimit(x)
      );
    default:
      return false;
  }
}

/**
 * What a lookup is called, in the trail and in a run's own context.
 *
 * One renderer for the server's prompt, the audit table and the admin surface,
 * so "what did this run read" reads the same wherever it is asked. English
 * source text, translated where it is shown, like the action labels.
 */
export function lookupLabel(lookup: AgentLookup): string {
  switch (lookup.kind) {
    case "mail":
      return lookup.query ? `the mail matching “${lookup.query}”` : "the group's mail";
    case "message":
      return `the message ${lookup.id}`;
    case "mailboxes":
      return "the group's folders";
    case "labels":
      return "the group's labels";
    case "files": {
      const where = lookup.folder
        ? `the group's Files in “${lookup.folder}”`
        : "the group's Files";
      const tree = lookup.deep ? `${where}, the whole tree` : where;
      return lookup.name ? `${tree}, matching “${lookup.name}”` : tree;
    }
    case "file":
      return `the file “${lookup.path}”`;
    case "chat":
      return lookup.query
        ? `the group's chat matching “${lookup.query}”`
        : "the group's chat";
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export const AGENT_JOB_STATES: ReadonlyArray<string> = [
  "pending",
  "running",
  "awaiting_approval",
  "done",
  "failed",
];

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
/**
 * What started a job: one of a rule's own triggers, or a person.
 *
 * A rule has four triggers and they are the whole of what wakes it by itself;
 * `manual` is a job's provenance and never a rule's — an automation that only
 * runs when somebody asks for it is a person's habit, not a document, and a
 * rule that could carry it would have to say what it acts on, which is exactly
 * the thing a rule's trigger already says.
 */
export type AgentJobTriggerOn = AgentTriggerOn | "manual";

export interface AgentTriggerRecord {
  on: AgentJobTriggerOn;
  emailId?: string;
  nodeId?: string;
  chatId?: string;
  /** Who caused it: a member's address when a person did. */
  by?: string;
  /**
   * The job whose own effect woke this one: the lineage a chain is read along
   * (ADR 0003). Absent when nothing woke this run but its trigger itself, and a
   * manual ask is one of those — a person asking is a trigger like any other.
   */
  parentJobId?: string;
  /**
   * How many hops into its chain this run is, counted from the trigger.
   *
   * What wakes a rule by itself — an arrival, a file, a request in the group's
   * chat, the clock — is hop one, and a run woken by another run's effect is one
   * more. Absent on records written before the count existed, and read as hop
   * one, which is what `hopOf` is for (ADR 0003).
   */
  hop?: number;
  at: string;
}

/**
 * How many hops into its chain a trigger is.
 *
 * The one reader of the count: a record that carries no number is a trigger
 * that woke its rule by itself, which is hop one.
 */
export function hopOf(trigger: { hop?: number }): number {
  const hop = trigger.hop;
  return typeof hop === "number" && Number.isInteger(hop) && hop >= 1 ? hop : 1;
}

/**
 * What identifies the change a trigger names: the record it was about, or the
 * instant when it names none.
 *
 * A trigger's `at` is when the pass read the change, so the same change read
 * twice is the same thing only when the record is: this is what a job is
 * deduplicated by, and what a refusal is remembered under.
 *
 * A manual ask is the exception, and it is one on purpose: the deduplication
 * exists so a re-read change does not run twice, and a person pressing a button
 * twice is not a re-read — it is two asks, and the second one is theirs to make.
 */
export function changeIdOf(
  trigger: Pick<AgentTriggerRecord, "on" | "emailId" | "nodeId" | "chatId" | "at">,
): string {
  if (trigger.on === "manual") return trigger.at;
  return trigger.emailId ?? trigger.nodeId ?? trigger.chatId ?? trigger.at;
}

export interface AgentJob {
  v: 1;
  id: string;
  /** The account the job works in — the group's own. */
  accountId: string;
  ruleId: string;
  /** Pinned at creation: an updated rule does not change a running job. */
  ruleVersion: number;
  state: AgentJobState;
  trigger: AgentTriggerRecord;
  attempts: number;
  lease?: AgentLease;
  proposal?: AgentProposal;
  /**
   * The actions that already ran, in the order they landed.
   *
   * A retry re-enters a job whose first pass may already have had an effect, so
   * the executor records each action as it completes and the next pass skips
   * what is done. A job that has already run an action it cannot take back is
   * not retried at all (ADR 0003 resolution 18).
   */
  applied?: string[];
  /**
   * The records this run's own effects wrote, in the order they landed.
   *
   * Beside `applied`, which says which actions ran: this says which records
   * moved, and that is what a chain's lineage is read from — a change reports
   * the id of the record that moved, and the job whose effect carried that id is
   * the job that woke the run the change starts (ADR 0003).
   */
  effects?: AgentEffect[];
  /**
   * What this run looked up before it decided, in the order it asked.
   *
   * A read the run performed on its own initiative (ADR 0020), kept so "what
   * did this run read" is a question about a document rather than about a log.
   * Absent on a run that had everything it needed, and on every job written
   * before a run could look anything up.
   */
  lookups?: AgentLookup[];
  /** When the next attempt may start: the backoff between retries. */
  nextAttemptAt?: string;
  decisionId?: string;
  /** The last failure, when the state is `failed`. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A record a run's own effect wrote: a message it labelled or moved, a chat
 * message or a file it posted, the copy it sent.
 *
 * The kind is JMAP's, because that is what a change names when it reports that
 * the record moved.
 */
export interface AgentEffect {
  type: "Email" | "FileNode";
  id: string;
  /**
   * When the write landed, as the worker's clock read it when the action
   * returned.
   *
   * A change says nothing about when the record it names moved, so this is what
   * separates the write a pass is reporting from an earlier write to the same
   * record: only a write inside the window the pass reads explains its change,
   * and a write without an instant explains nothing (ADR 0003).
   */
  at?: string;
}

export function isAgentEffect(x: unknown): x is AgentEffect {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  if (e.type !== "Email" && e.type !== "FileNode") return false;
  if (typeof e.id !== "string" || !e.id.length) return false;
  return e.at === undefined || typeof e.at === "string";
}

export function isAgentLease(x: unknown): x is AgentLease {
  if (!x || typeof x !== "object") return false;
  const l = x as Record<string, unknown>;
  return typeof l.owner === "string" && typeof l.heartbeatAt === "string";
}

export function isAgentJobState(x: unknown): x is AgentJobState {
  return typeof x === "string" && AGENT_JOB_STATES.includes(x);
}

export function isAgentTriggerRecord(x: unknown): x is AgentTriggerRecord {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  if (!isAgentJobTriggerOn(t.on)) return false;
  for (const k of ["emailId", "nodeId", "chatId", "by", "parentJobId"] as const) {
    if (t[k] !== undefined && typeof t[k] !== "string") return false;
  }
  if (t.hop !== undefined && (!Number.isInteger(t.hop) || (t.hop as number) < 1))
    return false;
  return typeof t.at === "string";
}

export function isAgentProposal(x: unknown): x is AgentProposal {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (typeof p.summary !== "string") return false;
  if (!isActionList(p.actions)) return false;
  if (typeof p.confidence !== "number") return false;
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
  if (typeof j.ruleId !== "string" || typeof j.ruleVersion !== "number") return false;
  if (!isAgentJobState(j.state)) return false;
  if (!isAgentTriggerRecord(j.trigger)) return false;
  if (typeof j.attempts !== "number") return false;
  if (j.lease !== undefined && !isAgentLease(j.lease)) return false;
  if (j.proposal !== undefined && !isAgentProposal(j.proposal)) return false;
  if (
    j.applied !== undefined &&
    (!Array.isArray(j.applied) || j.applied.some((a) => typeof a !== "string"))
  )
    return false;
  if (
    j.effects !== undefined &&
    (!Array.isArray(j.effects) || j.effects.some((effect) => !isAgentEffect(effect)))
  )
    return false;
  if (
    j.lookups !== undefined &&
    (!Array.isArray(j.lookups) || !j.lookups.every(isAgentLookup))
  )
    return false;
  if (j.nextAttemptAt !== undefined && typeof j.nextAttemptAt !== "string") return false;
  if (j.decisionId !== undefined && typeof j.decisionId !== "string") return false;
  if (j.error !== undefined && typeof j.error !== "string") return false;
  return typeof j.createdAt === "string" && typeof j.updatedAt === "string";
}

/** Build a job — the one writer; the executor must not inline the shape. */
export function newJob(input: {
  id: string;
  accountId: string;
  rule: Pick<AgentRule, "id" | "version">;
  trigger: AgentTriggerRecord;
  now?: string;
}): AgentJob {
  const at = input.now ?? new Date().toISOString();
  return {
    v: 1,
    id: input.id,
    accountId: input.accountId,
    ruleId: input.rule.id,
    ruleVersion: input.rule.version,
    state: "pending",
    // The count starts at the trigger: a job whose caller named no lineage is
    // one that nothing woke but its own trigger, which is hop one (ADR 0003).
    trigger: { ...input.trigger, hop: hopOf(input.trigger) },
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
  /**
   * When the approval was stamped for applying, before the effects ran.
   *
   * The stamp is the at-most-once guard for an approved decision: it is written
   * conditionally **before** the actions, so a second approval — another
   * member answering, a retry after a crash — finds it and refuses instead of
   * sending the same mail twice. The stamp survives a crash: a decision that is
   * stamped but whose effects are unknown is a question for a person, which is
   * better than a second send.
   */
  appliedAt?: string;
  summary: string;
  actions: AgentAction[];
  confidence: number;
  /** The chat message carrying the proposal, so a reply can be matched. */
  chatId?: string;
  draft?: AgentDraftRef | null;
  /**
   * What the job looked up before it proposed this, copied when the decision
   * opened (ADR 0020).
   *
   * The decision is what a person answers, and it outlives the job: an approval
   * line in the trail has to be able to say what the run read, not only the
   * paused line before it.
   */
  lookups?: AgentLookup[];
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
  if (
    d.lookups !== undefined &&
    (!Array.isArray(d.lookups) || !d.lookups.every(isAgentLookup))
  )
    return false;
  if (d.appliedAt !== undefined && typeof d.appliedAt !== "string") return false;
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
    id: job.decisionId ?? `${job.id}-d${job.attempts ? `-a${job.attempts}` : ""}`,
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
  if (chatId) doc.chatId = chatId;
  if (p.draft) doc.draft = p.draft;
  if (job.lookups?.length) doc.lookups = job.lookups;
  return doc;
}

/* ------------------------------------------------------------------ */
/* Claims — the coordination, without a coordinator                    */
/* ------------------------------------------------------------------ */

/**
 * One worker's claim on an account, with the change states it has reconciled
 * up to. The state map lives here because it is the same kind of fact as the
 * claim: whoever holds the claim owns the catch-up anchor, and a worker taking
 * over a stale claim re-reads from what the previous one recorded instead of
 * from nothing.
 */
export interface AgentClaim {
  v: 1;
  accountId: string;
  worker: string;
  /**
   * When this worker **took** the unit. The claim is a fence, taken and
   * released, not a lease renewed on a clock: nothing rewrites this field while
   * the holder holds the unit, so it is the instant ownership began and the
   * only thing a peer reads to decide whether the holder can still be running.
   */
  takenAt: string;
  /**
   * Which ownership of this unit the holder is. Incremented on every takeover,
   * never while a claim is held, so a worker whose fence was taken over
   * mid-pass can be told apart from the one that replaced it: the epoch it
   * holds is behind, and its late writes are refused rather than landing on the
   * new owner's run.
   *
   * Absent on claims written before the epoch existed, and read as 0.
   */
  epoch?: number;
  /** JMAP data type → the state the worker has reconciled up to. */
  states: Record<string, string>;
  /**
   * When each of those states was observed, by the same keys.
   *
   * The states say what a worker has read up to; these say when, which is the
   * only thing that tells a change a run's own effect caused from a change
   * somebody else made to the same record afterwards. A type with no instant is
   * a state of unknown age, and a wake is then not attributed to any run.
   */
  statesAt?: Record<string, string>;
}

/** The epoch a claim is in, with claims written before epochs read as 0. */
export function claimEpoch(claim: { epoch?: number }): number {
  return typeof claim.epoch === "number" &&
    Number.isInteger(claim.epoch) &&
    claim.epoch >= 0
    ? claim.epoch
    : 0;
}

export function isAgentClaim(x: unknown): x is AgentClaim {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  if (c.v !== 1) return false;
  if (typeof c.accountId !== "string") return false;
  if (typeof c.worker !== "string" || !c.worker) return false;
  if (typeof c.takenAt !== "string") return false;
  if (c.epoch !== undefined && (!Number.isInteger(c.epoch) || (c.epoch as number) < 0))
    return false;
  if (!isStringMap(c.states)) return false;
  return c.statesAt === undefined || isStringMap(c.statesAt);
}

/** Whether a value is a map of keys to strings: the claim's states and instants. */
function isStringMap(x: unknown): x is Record<string, string> {
  if (!isRecord(x)) return false;
  return Object.values(x as Record<string, unknown>).every(
    (value) => typeof value === "string",
  );
}

/** The stream claim: exactly one worker holds the agent's EventSource (ADR 0003). */
export interface AgentStreamClaim {
  v: 1;
  worker: string;
  /** As `AgentClaim.takenAt`: when this worker took the stream. */
  takenAt: string;
  /** As `AgentClaim.epoch`: the ownership a held stream belongs to. */
  epoch?: number;
}

export function isAgentStreamClaim(x: unknown): x is AgentStreamClaim {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.worker === "string" &&
    typeof c.takenAt === "string" &&
    (c.epoch === undefined || (Number.isInteger(c.epoch) && (c.epoch as number) >= 0))
  );
}

/**
 * Whether a claim's lease is stale: its heartbeat is older than the tolerance.
 *
 * A job lease is judged here, and only a job lease: a **claim** is a fence and
 * is not renewed on a clock, so what makes it free to take over is decided in
 * `lease.ts` against the instant the taking process started. A heartbeat that
 * cannot be read is **not** a free lease either: a document whose time is
 * unreadable means the truthful answer is unknown, and taking over on an
 * unknown is how two workers end up on the same job. It throws instead, which
 * the worker reports as a failure of its pass — loudly, once, rather than
 * silently running the account's work twice.
 */
export function leaseExpired(
  heartbeatAt: string,
  now: number,
  toleranceMs: number,
): boolean {
  const at = Date.parse(heartbeatAt);
  if (!Number.isFinite(at))
    throw new Error(
      `a lease heartbeat of "${heartbeatAt}" cannot be read as a time, so whether the job it belongs to is still held is unknown`,
    );
  return now - at > toleranceMs;
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
  if (!isRecord(x)) return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1 || !Array.isArray(d.entries)) return false;
  return d.entries.every((e) => {
    const s = e as Record<string, unknown>;
    return typeof s?.ruleId === "string" && typeof s?.at === "string";
  });
}

/** The next instant a `schedule` rule is due, from `now`. */
export function nextRunAfter(rule: AgentRule, now: Date): Date | null {
  if (rule.trigger.on !== "schedule") return null;
  const minutes = scheduleMinutesOf(rule);
  if (!Number.isFinite(minutes) || minutes < 1)
    throw new Error(`a schedule of every ${String(minutes)} minutes has no next run`);
  const ms = minutes * 60_000;
  const next = Math.ceil(now.getTime() / ms) * ms;
  return new Date(next > now.getTime() ? next : next + ms);
}

/* ------------------------------------------------------------------ */
/* The prose an agent carries: house rules, group rules, a group's form */
/* ------------------------------------------------------------------ */

/**
 * A group may state, once, how its agent should behave — the shape of an
 * `AGENTS.md`, written by an administrator of that group and handed to the
 * model on **every** call the group's agent makes, before the automation's own
 * instruction and before the data it is looking at.
 *
 * It can steer and it cannot grant: what an automation may do is its
 * capability allowlist, and every answer the model gives is validated against
 * it, so a standing instruction cannot widen a rule. What it *can* do is say
 * the things that are true of the whole group — the tone, the language, the
 * house rules — instead of repeating them in every automation.
 */
export const AGENT_INSTRUCTION_FILE = "agent/instruction.json";

/**
 * The installation's own rules, held in the Master's account.
 *
 * The third and outermost level of prose an automation runs under: what is
 * true of Gilbert everywhere, before anything is true of a group or of one
 * automation. It is written once, in Admin → Master, and carried into every
 * call of every group the installation serves — so the house rules a company
 * states once do not have to be repeated in each group's instruction.
 */
export const AGENT_PREAMBLE_FILE = "agent/preamble.json";

/** The group's notebook: the facts its agent holds in every call (ADR 0003). */
export const AGENT_NOTEBOOK_FILE = "agent/notebook.json";

/** Long enough for a page of house rules, short enough to stay a prompt. */
export const AGENT_INSTRUCTION_MAX = 4000;

/**
 * One piece of prose an agent carries: its text, and who last wrote it.
 *
 * One type for both documents that are prose and nothing else — the
 * installation's rules and a group's standing instruction — because they are
 * the same thing at two scopes: a person writes sentences, the agent reads
 * them before it acts, and nothing about them is a field. They differ in where
 * they are stored and in how far they reach, never in shape, so a reader, a
 * bound and a validator serve both.
 */
export interface AgentProseDoc {
  v: 1;
  text: string;
  updatedAt: string;
  updatedBy: string;
}

export function isAgentProseDoc(x: unknown): x is AgentProseDoc {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return (
    d.v === 1 &&
    typeof d.text === "string" &&
    d.text.length <= AGENT_INSTRUCTION_MAX &&
    typeof d.updatedAt === "string" &&
    typeof d.updatedBy === "string"
  );
}

/**
 * The prose a model call carries, or "" when the document is absent.
 *
 * One renderer for both documents of this shape, so "what the agent was told"
 * is read the same way wherever it sits in the prompt.
 */
export function proseFor(doc: AgentProseDoc | null): string {
  return (doc?.text ?? "").trim();
}

/* ------------------------------------------------------------------ */
/* The notebook — what memory means for a group                        */
/* ------------------------------------------------------------------ */

/**
 * One fact the group's agent holds in every call.
 *
 * A fact is prose rather than a field: it is what a person wrote down about the
 * group — how its mail is filed, what its clients are called, which language it
 * works in, the exceptions — and it is read as data like everything else in a
 * prompt. It is a list of them rather than one blob so a surface can show,
 * change, remove and add one at a time (ADR 0003).
 */
export interface AgentNotebookFact {
  /** Stable across edits, so a surface can name the fact it is changing. */
  id: string;
  /** The fact itself, in the author's words. */
  text: string;
  /** When this fact was last written — added, or corrected since. */
  addedAt?: string;
  /** Who last wrote it. */
  addedBy?: string;
}

export interface AgentNotebookDoc {
  v: 1;
  facts: AgentNotebookFact[];
  updatedAt: string;
  updatedBy: string;
}

/** How many facts a notebook may hold, and how long one may be. */
export const AGENT_NOTEBOOK_FACTS_MAX = 100;
export const AGENT_NOTEBOOK_FACT_MAX = 500;

export function isAgentNotebookFact(x: unknown): x is AgentNotebookFact {
  if (!x || typeof x !== "object") return false;
  const f = x as Record<string, unknown>;
  if (typeof f.id !== "string" || !f.id) return false;
  if (typeof f.text !== "string" || f.text.length > AGENT_NOTEBOOK_FACT_MAX) return false;
  if (f.addedAt !== undefined && typeof f.addedAt !== "string") return false;
  if (f.addedBy !== undefined && typeof f.addedBy !== "string") return false;
  return true;
}

export function isAgentNotebookDoc(x: unknown): x is AgentNotebookDoc {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1 || !Array.isArray(d.facts)) return false;
  if (d.facts.length > AGENT_NOTEBOOK_FACTS_MAX) return false;
  if (!d.facts.every(isAgentNotebookFact)) return false;
  return typeof d.updatedAt === "string" && typeof d.updatedBy === "string";
}

/**
 * The notebook as a prompt carries it, or "" when there is nothing to say.
 *
 * One line per fact, in the order the group keeps them: the block sits in the
 * prompt's stable head, so it is built the same way every time (ADR 0003).
 */
export function notebookFor(doc: AgentNotebookDoc | null): string {
  const facts = (doc?.facts ?? []).map((fact) => fact.text.trim()).filter(Boolean);
  if (!facts.length) return "";
  return facts.map((text) => `- ${text}`).join("\n");
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export const AGENT_AUDIT_OUTCOMES: ReadonlyArray<string> = [
  "running",
  "done",
  "failed",
  "awaiting_approval",
  "rejected",
  "missed",
  /**
   * A run whose worker stopped holding it: the lease expired with the job still
   * `running`, nobody came back for it, and the attempts it had are spent. It is
   * an outcome of its own rather than `failed`, because nothing reported a
   * failure — the process that would have done so is gone, and a reader of the
   * trail is entitled to see the difference.
   */
  "timeout",
  /**
   * A run a chain refused before it started: an automation woken past the bound
   * the installation sets on hops. It is an outcome of its own rather than
   * `failed`, because nothing failed — a run that must not happen is a fact
   * about the agent, and a reader of the trail is entitled to see it (ADR 0003).
   */
  "refused",
];

export type AgentAuditOutcome =
  | "running"
  | "done"
  | "failed"
  | "awaiting_approval"
  | "rejected"
  | "missed"
  | "timeout"
  | "refused";

/** Whether a value names an outcome the audit can carry. */
export function isAgentAuditOutcome(x: unknown): x is AgentAuditOutcome {
  return typeof x === "string" && AGENT_AUDIT_OUTCOMES.includes(x);
}

/**
 * The outcomes that record no call a provider could answer for.
 *
 * A refusal is the absence of a run (`refused`), a due run nothing could fire
 * never asked a provider anything (`missed`), and a holder that stopped
 * reporting answers for nothing (`timeout`). An entry carrying one of these adds
 * nothing to a meter: counting them would make `runs` a count of entries and
 * `uncounted` a count of silences, and the meter is the group's reading of what
 * its own runs cost (ADR 0003).
 */
export const UNMETERED_OUTCOMES: ReadonlyArray<AgentAuditOutcome> = [
  "refused",
  "missed",
  "timeout",
];

export interface AgentAuditEntry {
  at: string;
  jobId: string;
  ruleId: string;
  ruleVersion: number;
  outcome: AgentAuditOutcome;
  /** Who asked: the trigger's actor, when a person did. */
  by?: string;
  actions: AgentAction[];
  /** The automation's name and the failure's message, for a readable trail. */
  detail?: string;
  /** The agent that held the group and spent the call (ADR 0003). */
  agent?: string;
  /** Whether the run paid for the model's chain of thought. */
  reasoned?: boolean;
  /**
   * What the run looked up before it decided, in the order it asked (ADR 0020).
   *
   * Absent on a run that had everything it needed, and on every entry written
   * before a run could look anything up. This is where "what did it read" is
   * answered after the job document has been pruned.
   */
  lookups?: AgentLookup[];
  /**
   * A pass that resumes a plan already decided and already counted: it spent
   * nothing of its own, so it is neither a run nor an uncounted one.
   */
  resumed?: true;
  /** What the deciding call cost, as the provider reported it. */
  usage?: AgentUsage;
}

/**
 * What one call cost, as the provider reported it.
 *
 * `null` is "the provider did not say", never zero: a count nobody reported and
 * a count of nothing are different facts, and a meter that showed the first as
 * the second would be a number nobody can check (ADR 0003). `inputMissTokens`
 * is what the provider charged full price for, so a provider that reports only
 * a total leaves it null rather than guessing.
 */
export interface AgentUsage {
  inputHitTokens: number | null;
  inputMissTokens: number | null;
  outputTokens: number | null;
}

export function isAgentUsage(x: unknown): x is AgentUsage {
  if (!x || typeof x !== "object") return false;
  const u = x as Record<string, unknown>;
  return (
    countOrNull(u.inputHitTokens) === u.inputHitTokens &&
    countOrNull(u.inputMissTokens) === u.inputMissTokens &&
    countOrNull(u.outputTokens) === u.outputTokens
  );
}

/**
 * A meter: the counts of many runs, and how many of them said nothing.
 *
 * The sum is of what was reported, and a run the provider gave no numbers for
 * is counted in `uncounted` rather than added as a zero — so a reading can say
 * "twelve runs, nine counted" instead of quietly understating the bill.
 */
export interface AgentMeter {
  inputHitTokens: number | null;
  inputMissTokens: number | null;
  outputTokens: number | null;
  runs: number;
  uncounted: number;
}

/** What one entry adds to one meter: the only place that rule is written. */
export function meterOf(
  meter: AgentMeter,
  entry: Pick<AgentAuditEntry, "usage" | "outcome" | "resumed">,
): AgentMeter {
  if (UNMETERED_OUTCOMES.includes(entry.outcome)) return meter;
  // A pass that resumed a plan was counted when the plan was decided: counting
  // it again would bill one run twice (ADR 0003).
  if (entry.resumed) return meter;
  const usage = entry.usage;
  // Not a row of zeros, whichever way the silence arrived: a provider that
  // reported nothing is a run nobody can price, and it is the only thing the
  // meter can say about it (ADR 0003).
  const reported =
    usage !== undefined &&
    (usage.inputHitTokens !== null ||
      usage.inputMissTokens !== null ||
      usage.outputTokens !== null);
  if (!reported)
    return { ...meter, runs: meter.runs + 1, uncounted: meter.uncounted + 1 };
  const add = (total: number | null, value: number | null): number | null =>
    value === null ? total : (total ?? 0) + value;
  return {
    inputHitTokens: add(meter.inputHitTokens, usage.inputHitTokens),
    inputMissTokens: add(meter.inputMissTokens, usage.inputMissTokens),
    outputTokens: add(meter.outputTokens, usage.outputTokens),
    runs: meter.runs + 1,
    uncounted: meter.uncounted,
  };
}

/** A meter that has seen nothing: the fold's starting point, written once. */
export const EMPTY_METER: AgentMeter = {
  inputHitTokens: null,
  inputMissTokens: null,
  outputTokens: null,
  runs: 0,
  uncounted: 0,
};

/** A meter over the entries a surface reads. The one aggregator. */
export function meterOver(entries: ReadonlyArray<AgentAuditEntry>): AgentMeter {
  return entries.reduce(meterOf, EMPTY_METER);
}

/**
 * The same fold, one meter per agent — the split the fleet view reads.
 *
 * The key is the address an entry names as having spent the call, and an entry
 * that names none is counted under the empty name rather than dropped: the
 * parts have to add up to the total, or the split is a second, quieter number.
 */
export function metersByAgent(
  entries: ReadonlyArray<Pick<AgentAuditEntry, "agent" | "usage" | "outcome">>,
): Array<{ agent: string; meter: AgentMeter }> {
  const by = new Map<string, AgentMeter>();
  for (const entry of entries) {
    const agent = entry.agent ?? "";
    by.set(agent, meterOf(by.get(agent) ?? EMPTY_METER, entry));
  }
  return [...by]
    .map(([agent, meter]) => ({ agent, meter }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

export interface AgentAuditDoc {
  v: 1;
  month: string;
  entries: AgentAuditEntry[];
}

/**
 * One authoring call: what a reading spent, and what it was a reading of.
 *
 * It carries the counts and no prose: the answer is shown where it was asked
 * for and stored nowhere, so what survives is that the installation spent this
 * much asking about that draft (ADR 0003).
 */
export interface AgentAuthoringEntry {
  at: string;
  /** What the reading was about: the group's instruction, or one automation. */
  about: string;
  /** The group whose documents the reading carried, when it carried one. */
  group?: string;
  /** Who asked for it, as the session names them. */
  by?: string;
  usage?: AgentUsage;
  /**
   * A reservation made before the call is paid for, not yet a completed
   * reading. `reserveAuthoring` writes it, `finalizeAuthoring` clears it once
   * the call answers, and `cancelAuthoring` removes the entry entirely when
   * the call never happens — closing the window where two overlapping
   * readings could each see room under the month's ceiling and both spend.
   */
  pending?: true;
  /** The reservation this entry answers to; present only while `pending`. */
  token?: string;
}

export interface AgentAuthoringDoc {
  v: 1;
  month: string;
  entries: AgentAuthoringEntry[];
}

export function isAgentAuthoringDoc(x: unknown): x is AgentAuthoringDoc {
  if (!isRecord(x)) return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1 || typeof d.month !== "string" || !Array.isArray(d.entries)) return false;
  return d.entries.every((e) => {
    const a = e as Record<string, unknown>;
    if (!a || typeof a !== "object") return false;
    if (typeof a.at !== "string" || typeof a.about !== "string") return false;
    if (a.group !== undefined && typeof a.group !== "string") return false;
    if (a.by !== undefined && typeof a.by !== "string") return false;
    if (a.usage !== undefined && !isAgentUsage(a.usage)) return false;
    if (a.pending !== undefined && a.pending !== true) return false;
    if (a.token !== undefined && typeof a.token !== "string") return false;
    return true;
  });
}

export function isAgentAuditDoc(x: unknown): x is AgentAuditDoc {
  if (!isRecord(x)) return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1 || typeof d.month !== "string" || !Array.isArray(d.entries)) return false;
  return d.entries.every((e) => {
    const a = e as Record<string, unknown>;
    if (!a || typeof a !== "object") return false;
    if (typeof a.at !== "string" || typeof a.jobId !== "string") return false;
    if (typeof a.ruleId !== "string" || typeof a.ruleVersion !== "number") return false;
    if (!isAgentAuditOutcome(a.outcome)) return false;
    if (a.by !== undefined && typeof a.by !== "string") return false;
    if (a.detail !== undefined && typeof a.detail !== "string") return false;
    if (a.agent !== undefined && typeof a.agent !== "string") return false;
    if (a.reasoned !== undefined && typeof a.reasoned !== "boolean") return false;
    if (a.usage !== undefined && !isAgentUsage(a.usage)) return false;
    if (
      a.lookups !== undefined &&
      (!Array.isArray(a.lookups) || !a.lookups.every(isAgentLookup))
    )
      return false;
    return isActionList(a.actions);
  });
}

/* ------------------------------------------------------------------ */
/* Configuration — the agent's own account                             */
/* ------------------------------------------------------------------ */

/**
 * The installation's model. One entry, not one per classification (ADR 0003).
 *
 * The API key is stored here and read by the executor through the agent's own
 * session; it is write-only in the admin surface, the way an app password is.
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
  /** The one model every automation of this installation runs on. */
  provider?: AgentProvider;
  /**
   * The ceiling on one answer, in tokens (ADR 0003). The provider's own ceiling
   * is enormous and an uncapped answer is an uncapped bill, so the request
   * always carries one: this value, or the default when it is absent.
   */
  maxOutputTokens?: number;
  /**
   * How many hops a chain of automations may run, as this installation sets it.
   * Absent leaves the agent's own default alone, which is what the environment
   * states (ADR 0003).
   */
  maxChainHops?: number;
  /** How many pages one run may hand the model as images, as it sets it. */
  maxPages?: number;
}

/** What one answer may cost when the installation has not said otherwise. */
export const MODEL_MAX_OUTPUT_DEFAULT = 2048;

/**
 * How many pages one run hands the model as images when the installation has
 * not said otherwise (ADR 0003): a page whose own text layer is empty is
 * rendered and read by the model, and a document is as long as whoever sent it
 * made it, so the count is bounded rather than left to the file.
 */
/** See `AGENT_PAGES_DEFAULT`: one value, defined where the document is. */
export const AGENT_MAX_PAGES_DEFAULT = AGENT_PAGES_DEFAULT;

/**
 * How many bytes of a document one run may read.
 *
 * The blob is fetched whole before anything can look at it, and a page is held
 * as pixels while it is rendered, so this is the bound on both: a file larger
 * than this is not read here, and the run says so rather than spending the
 * process on it (ADR 0003).
 */
export const AGENT_DOCUMENT_BYTES_MAX = 32 * 1024 * 1024;

/**
 * How many pages one `document.split` may write.
 *
 * A split turns one file into as many files as it has pages, so the bound is on
 * what the group's own storage gains from one action rather than on what one
 * call reads.
 */
export const AGENT_SPLIT_PAGES_MAX = 100;

/** What an installation may raise the two bounds to, from its own surface. */
export const AGENT_CHAIN_HOPS_CEILING = 50;
export const AGENT_PAGES_CEILING = 50;

/** Whether a bound an installation set for itself is one this build accepts. */
export function isAgentBound(x: unknown, ceiling: number): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= ceiling;
}

/**
 * The highest ceiling an installation may set. Well under the provider's own,
 * because a run reads one message and answers with a handful of actions: a
 * figure in the hundreds of thousands is a bill nobody meant to authorise.
 */
export const MODEL_MAX_OUTPUT_CEILING = 32_000;

/** Whether a value may be written as an installation's output ceiling. */
export function isModelMaxOutput(x: unknown): x is number {
  return (
    typeof x === "number" &&
    Number.isInteger(x) &&
    x >= 1 &&
    x <= MODEL_MAX_OUTPUT_CEILING
  );
}

/**
 * Why a provider's base URL may not be used, or null when it may.
 *
 * One rule, two doors: the admin route refuses a write with a sentence, and
 * every call path re-checks the address it is about to send the installation's
 * key to — a configuration document can be written by hand, restored from a
 * backup, or written by a build that predates the guard, and the call is where
 * the key would actually leave.
 */
export function baseUrlProblem(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "base_url_invalid";
  }
  if (url.protocol !== "https:") return "base_url_not_https";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    /^(f[cd][0-9a-f]{2}:|fe80:)/.test(host);
  return privateHost ? "base_url_private" : null;
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
  if (!isRecord(x)) return false;
  const d = x as Record<string, unknown>;
  if (d.v !== 1 || typeof d.address !== "string" || !d.address) return false;
  if (d.maxOutputTokens !== undefined && !isModelMaxOutput(d.maxOutputTokens))
    return false;
  // The two bounds an installation sets for itself are whole positive numbers,
  // and a document that carries anything else is refused rather than read as a
  // default nobody chose.
  for (const bound of [d.maxChainHops, d.maxPages])
    if (
      bound !== undefined &&
      (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1)
    )
      return false;
  return d.provider === undefined || isAgentProvider(d.provider);
}

/**
 * What a running worker has last said about itself, in the agent's own account.
 *
 * Written when the worker starts, when the set of accounts it serves changes and
 * when it stops — never on a clock, because a heartbeat is a durable write and
 * Stalwart charges the account for every one of them (and never gives the blob
 * back). Whether a worker is **up** is therefore not a question this document
 * can answer: that is a fact of the process that hosts it, kept in memory, and
 * this record is what it is doing and what it last changed.
 */
export interface AgentWorkerRecord {
  v: 1;
  id: string;
  address: string;
  /** The version the worker runs, for the status surface. */
  version: string;
  startedAt: string;
  /** When this worker last changed what it is doing: the instant this record did. */
  updatedAt: string;
  /**
   * The groups this worker is holding as this record was written, by name —
   * the accounts it has claimed. A worker claims per account, so this is what
   * the fleet is spread over, and it is how the admin surface can say which
   * workers are serving one group.
   *
   * Empty when the worker is up and holding nothing, which is a state the
   * surface shows rather than hides. Absent on records written before the field
   * existed, and read as none.
   */
  serves?: string[];
}

export function isAgentWorkerRecord(x: unknown): x is AgentWorkerRecord {
  if (!x || typeof x !== "object") return false;
  const w = x as Record<string, unknown>;
  return (
    w.v === 1 &&
    typeof w.id === "string" &&
    typeof w.address === "string" &&
    typeof w.version === "string" &&
    typeof w.startedAt === "string" &&
    typeof w.updatedAt === "string" &&
    (w.serves === undefined ||
      (Array.isArray(w.serves) && w.serves.every((g) => typeof g === "string")))
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

/**
 * Every way a document breaks the published schema, as readable lines.
 *
 * A validator answers; it never throws, because this is asked while a surface
 * draws the draft it is editing and an exception there takes the whole tree
 * down. A document is JSON, and a value JSON cannot carry at all — an
 * `undefined` a caller built in memory, which the validator refuses to walk
 * rather than call invalid — is reported as the one problem it is. That is the
 * honest reading of "cannot be stored", and it is what turns the class of
 * mistake that once rendered a blank page into a sentence beside the field.
 */
export function schemaProblems(rule: unknown): string[] {
  let result: ReturnType<Validator["validate"]>;
  try {
    result = ruleValidator().validate(rule);
  } catch (err) {
    return [
      `the document carries a value that is not JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ];
  }
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
 * on its own: a rule with no instruction or no capability would match and then
 * have nothing to do. One list, so the admin surface refuses a rule with every
 * reason at once instead of one per attempt.
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
 * ADR 0003 asks for exactly this: an automation is a JSON
 * document validated against a standard schema — no new rule language — with
 * one trigger, prose and named, capability-gated actions. The schema is
 * **derived** from the same constants the runtime validator reads (the
 * triggers, and `AGENT_ACTION_SPECS` for the capability names and the areas),
 * so there is no second list of what a rule may say; the drift is caught by the
 * test that builds this and checks the enums against those constants.
 *
 * What the schema cannot express is the *cross-field* half — at least one
 * capability, and one enabled automation per trigger — and that stays in
 * `ruleProblem` and `rulesProblem`, which is what the admin API validates with.
 * The schema is the published contract for anything outside this codebase; the
 * guards are the enforcer inside it.
 */
export function agentRuleJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://gilbert.invalid/schemas/agent-rule.json",
    title: "Gilbert agent rule",
    description:
      "One automation: what wakes it, what it is asked to do, and what it may do about it (ADR 0003).",
    type: "object",
    required: ["v", "id", "version", "enabled", "trigger", "instruction", "capabilities"],
    additionalProperties: true,
    properties: {
      v: { const: 1 },
      id: { type: "string", minLength: 1 },
      version: { type: "integer", minimum: 1 },
      enabled: { type: "boolean" },
      trigger: {
        type: "object",
        required: ["on"],
        additionalProperties: false,
        properties: {
          on: { enum: [...AGENT_TRIGGERS] },
          everyMinutes: { type: "number", minimum: 5 },
        },
        allOf: [
          {
            if: { properties: { on: { const: "schedule" } }, required: ["on"] },
            then: { required: ["everyMinutes"] },
          },
        ],
      },
      instruction: {
        type: "string",
        description:
          "The prose its administrator wrote: the whole of what a run is asked to do.",
      },
      capabilities: {
        type: "array",
        minItems: 1,
        items: { enum: AGENT_ACTION_SPECS.map((spec) => spec.name) },
        description:
          'The allowlist: the only actions this rule may run. A model answer outside it is refused. "Do nothing" is granted to every run and is not listed here.',
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
    "x-areas": AGENT_AREAS.map((area) => ({
      area,
      label: AGENT_AREA_LABELS[area],
      actions: areaActions(area),
    })),
    /*
     * What the areas do not grant, derived here and published rather than left
     * for a surface to work out by subtracting one list from another: sending,
     * which every area excludes by the catalogue's own flags, and doing nothing,
     * which is not a behaviour.
     */
    "x-standalone": standaloneActions().map((name) => {
      const spec = agentActionSpec(name)!;
      return {
        name: spec.name,
        label: spec.label,
        description: spec.description,
        external: spec.external === true,
        irreversible: spec.irreversible === true,
      };
    }),
  };
}
