/**
 * The words the agent surfaces share (ADR 0003).
 *
 * The admin section and the read-only group panel describe the same durable
 * documents, so the label tables and the one-line descriptions live here once:
 * an automation that reads "An email arrives · subject contains “invoice”"
 * says the same thing wherever it is shown. The action labels come from
 * `AGENT_ACTION_SPECS` rather than a copy, so a capability cannot be named one
 * thing in the catalogue and another in the editor.
 */
import {
  AGENT_ACTION_SPECS,
  type AgentAction,
  type AgentAuditOutcome,
  type AgentJobState,
  type AgentReview,
  type AgentReviewMode,
  type AgentRule,
  type AgentTier,
  type AgentTrigger,
  type AgentTriggerOn,
  agentActionSpec,
  SUPPORTED_FILTER_KEYS,
} from "@gilbert/agent/documents";
import type { AgentStatusReason, MemberAgentRule } from "@gilbert/agent/views";
import { agentSentence } from "@/lib/agentErrors";
import { t } from "@/lib/i18n";

/*
 * Held as tables and translated at the render site (`t(label)`) — the
 * convention `SectionShell` documents for a constant label table. Nothing here
 * renders a raw string.
 */
export const AGENT_TRIGGER_LABELS: Record<AgentTriggerOn, string> = {
  email: "An email arrives",
  filenode: "A file or folder changes",
  chat: "Someone writes in the chat",
  schedule: "On a schedule",
};

/**
 * What each tier is called where a person reads it (ADR 0003).
 *
 * T0/T1/T2 are the architecture's names for the tiers, and the ones the
 * documents and the log carry; what someone choosing between them needs is
 * what the tier does, so the label says that and leaves the code to the places
 * that read it.
 */
export const AGENT_TIER_LABELS: Record<AgentTier, string> = {
  T0: "Fixed actions, with no model",
  T1: "A small model picks a category",
  T2: "A model decides and acts",
};

export const AGENT_REVIEW_LABELS: Record<AgentReviewMode, string> = {
  always: "Always ask a person first",
  threshold: "Ask a person below a confidence threshold",
  never: "Never ask — run it unattended",
};

export const AGENT_JOB_STATE_LABELS: Record<AgentJobState, string> = {
  pending: "Waiting to start",
  running: "Running",
  awaiting_approval: "Waiting for a person",
  done: "Done",
  failed: "Failed",
};

export const AGENT_OUTCOME_LABELS: Record<AgentAuditOutcome, string> = {
  running: "Ran",
  done: "Finished",
  failed: "Failed",
  awaiting_approval: "Asked for approval",
  rejected: "Rejected",
  missed: "Missed",
  timeout: "Timed out",
};

/** The catalogue's own labels, keyed by capability name. */
export const AGENT_ACTION_LABELS: Record<string, string> = Object.fromEntries(
  AGENT_ACTION_SPECS.map((s): [string, string] => [s.name, s.label]),
);

export function tierText(tier: string): string {
  return t(AGENT_TIER_LABELS[tier as AgentTier] ?? tier);
}

export function actionLabel(name: string): string {
  return t(AGENT_ACTION_LABELS[name] ?? name);
}

/**
 * A job's state, named.
 *
 * A state this build has never heard of — a job document written by a newer
 * version — renders as the value it carries, never as an empty translation:
 * the panel is a reader, and it shows what the document says.
 */
export function jobStateText(state: string): string {
  return t(AGENT_JOB_STATE_LABELS[state as AgentJobState] ?? state);
}

/** An audit entry's outcome, with the same fallback to the raw value. */
export function outcomeText(outcome: string): string {
  return t(AGENT_OUTCOME_LABELS[outcome as AgentAuditOutcome] ?? outcome);
}

/**
 * Why the fleet cannot be read, in the language the surface is set to.
 *
 * The status answer carries a code and, beside it, whatever the server that
 * refused said — never a sentence of the server's own English (ADR 0003 §4,
 * "Members see, never change" covers the admin's read the same way). The
 * sentence comes from the one table an admin refusal reads as well
 * (`agentErrors`), composed in the catalogue in force, so a language whose
 * catalogue does not carry it reads the English: the declared fallback, with
 * the translations owed as one piece of work for every sentence of this kind.
 */
export function fleetReasonText(reason: AgentStatusReason): string {
  // The sentences live once, in `AGENT_ERROR_SENTENCES`: a fleet status and an
  // admin refusal carry the same words, and a code cannot drift between them.
  return agentSentence(reason.code, reason);
}

/**
 * The trigger in one line: what wakes the automation, then the filters the
 * executor honours (the RFC 8621 subset `matchEmailFilter` implements).
 *
 * A partial document renders as far as it can: an unknown event is shown as the
 * value it carries, and a trigger that is not there at all describes nothing
 * rather than crashing the panel that shows it.
 */
export function triggerText(trigger: AgentTrigger | undefined): string {
  const on = trigger?.on;
  if (!on) return "";
  const base = t(AGENT_TRIGGER_LABELS[on] ?? on);
  const parts = filterParts(trigger?.filter);
  if (on === "schedule" && typeof trigger?.everyMinutes === "number") {
    parts.push(t("every {minutes} minutes", { minutes: trigger.everyMinutes }));
  }
  return parts.length ? `${base} · ${parts.join(", ")}` : base;
}

/**
 * What each filter key reads as inside that line, for the keys whose wording is
 * worth choosing. The keys themselves come from `SUPPORTED_FILTER_KEYS`, so a
 * filter the matcher implements is always spoken; this table only says how, and
 * a key that arrives here without a phrase still renders (see `filterParts`)
 * rather than dropping quietly out of the sentence.
 */
/**
 * One phrase per filter key, with the lookup written out.
 *
 * The literal has to be at the call site for the catalogs to see it: passing a
 * key through a variable puts the string out of `i18n:check`'s reach, which
 * leaves thirteen translations reading "stale" with nothing changed. The table
 * is keyed by the canonical list, so a key the matcher gains without a phrase
 * here falls back to the plain line below rather than going unrendered.
 */
const FILTER_KEY_PHRASES: Record<string, (value: string) => string> = {
  inMailbox: (value) => t("in mailbox {value}", { value }),
  hasKeyword: (value) => t("has keyword {value}", { value }),
  notKeyword: (value) => t("without keyword {value}", { value }),
  subject: (value) => t("subject contains {value}", { value }),
  text: (value) => t("anywhere contains {value}", { value }),
  body: (value) => t("body contains {value}", { value }),
  from: (value) => t("from contains {value}", { value }),
  to: (value) => t("to contains {value}", { value }),
  cc: (value) => t("cc contains {value}", { value }),
  before: (value) => t("received before {value}", { value }),
  after: (value) => t("received after {value}", { value }),
  minSize: (value) => t("larger than {value} bytes", { value }),
  maxSize: (value) => t("smaller than {value} bytes", { value }),
};

/**
 * The filters that narrow a trigger, in the order the matcher declares them.
 *
 * The keys are read from `SUPPORTED_FILTER_KEYS` rather than written here,
 * because this sentence promises what the executor honours: a key it implements
 * is said, with its own phrase where a phrase reads well and as a plain
 * "{key} is {value}" line where this table has no wording for it yet. A value
 * that is neither text nor a number is not comparable and describes nothing,
 * which is the reading the matcher gives it too.
 */
function filterParts(filter: Record<string, unknown> | undefined): string[] {
  const f = filter ?? {};
  const out: string[] = [];
  for (const key of SUPPORTED_FILTER_KEYS) {
    const value = f[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value);
    if (!text.trim()) continue;
    const phrase = FILTER_KEY_PHRASES[key];
    out.push(phrase ? phrase(text) : t("{key} is {value}", { key, value: text }));
  }
  return out;
}

/**
 * The review policy in one line, including the external-send consent floor.
 *
 * A document that carries no mode describes nothing — there is no policy to
 * name — and an unknown one is shown as written, like the agent's other tables.
 */
export function reviewText(review: AgentReview | undefined): string {
  const mode = review?.mode;
  if (!mode) return "";
  const base = t(AGENT_REVIEW_LABELS[mode] ?? mode);
  const threshold = review?.threshold;
  const withNumber =
    mode === "threshold" && typeof threshold === "number"
      ? `${base} (${t("at {percent}% confidence or above", {
          percent: Math.round(threshold * 100),
        })})`
      : base;
  // The floor is the part a reader must not miss: without it an external
  // action pauses whatever the mode says (ADR 0003 resolution 10).
  return review?.allowExternal
    ? `${withNumber} · ${t("sending outside the group allowed without a person")}`
    : `${withNumber} · ${t("sending outside the group always waits for a person")}`;
}

/** One action as a sentence: the catalogue's label plus its parameters. */
export function actionText(action: AgentAction): string {
  const spec = agentActionSpec(action.do);
  const label = spec ? t(spec.label) : action.do;
  const entries = Object.entries(action.with ?? {});
  if (!entries.length) return label;
  const params = entries.map(([key, value]) => `${key}: ${paramText(value)}`).join(", ");
  return `${label} (${params})`;
}

function paramText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? t("yes") : t("no");
  return JSON.stringify(value) ?? "";
}

/**
 * Every action a rule runs, in the order it was authored: T0's list, T1's
 * categories flattened, nothing for T2 (the model decides at run time).
 *
 * It takes either of the two shapes that describe one durable document: the
 * editor holds the stored `AgentRule`, and the member's panel holds the view the
 * server answers with (`MemberAgentRule`), a `Pick` of the same fields. Neither
 * is written out here, so a field added to one of them cannot go unread by both.
 */
export function ruleActions(rule: AgentRule | MemberAgentRule): AgentAction[] {
  if (rule.tier === "T0") return rule.actions ?? [];
  if (rule.tier === "T1") return (rule.categories ?? []).flatMap((c) => c.actions);
  return [];
}
