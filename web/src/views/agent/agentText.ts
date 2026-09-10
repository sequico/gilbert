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
  type AgentArea,
  type AgentAuditOutcome,
  type AgentJobState,
  type AgentReview,
  type AgentReviewMode,
  type AgentRule,
  type AgentTier,
  type AgentTrigger,
  type AgentTriggerOn,
  agentActionSpec,
} from "@gilbert/agent/documents";
import { t } from "@/lib/i18n";

/*
 * Held as tables and translated at the render site (`t(label)`) — the
 * convention `SectionShell` documents for a constant label table. Nothing here
 * renders a raw string.
 */
export const AGENT_AREA_LABELS: Record<AgentArea, string> = {
  mail: "Mail",
  files: "Files",
  tasks: "Tasks",
  calendars: "Calendars",
  contacts: "Contacts",
};

export const AGENT_TRIGGER_LABELS: Record<AgentTriggerOn, string> = {
  email: "An email arrives",
  filenode: "A file or folder changes",
  chat: "Someone writes in the chat",
  schedule: "On a schedule",
};

export const AGENT_TIER_LABELS: Record<AgentTier, string> = {
  T0: "T0 · fixed actions, no model",
  T1: "T1 · a small model picks a category",
  T2: "T2 · a model decides and acts",
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
};

/** The catalogue's own labels, keyed by capability name. */
export const AGENT_ACTION_LABELS: Record<string, string> = Object.fromEntries(
  AGENT_ACTION_SPECS.map((s): [string, string] => [s.name, s.label]),
);

export function areaText(area: string): string {
  return t(AGENT_AREA_LABELS[area as AgentArea] ?? area);
}

export function tierText(tier: string): string {
  return t(AGENT_TIER_LABELS[tier as AgentTier] ?? tier);
}

export function actionLabel(name: string): string {
  return t(AGENT_ACTION_LABELS[name] ?? name);
}

export function jobStateText(state: AgentJobState): string {
  return t(AGENT_JOB_STATE_LABELS[state]);
}

export function outcomeText(outcome: AgentAuditOutcome): string {
  return t(AGENT_OUTCOME_LABELS[outcome]);
}

/**
 * The trigger in one line: what wakes the automation, then the filters the
 * executor honours (the RFC 8621 subset `matchEmailFilter` implements).
 */
export function triggerText(trigger: AgentTrigger): string {
  const base = t(AGENT_TRIGGER_LABELS[trigger.on]);
  const parts = filterParts(trigger.filter);
  if (trigger.on === "schedule" && typeof trigger.everyMinutes === "number") {
    parts.push(t("every {minutes} minutes", { minutes: trigger.everyMinutes }));
  }
  return parts.length ? `${base} · ${parts.join(", ")}` : base;
}

function filterParts(filter: Record<string, unknown> | undefined): string[] {
  const f = filter ?? {};
  const out: string[] = [];
  const say = (key: string, source: string) => {
    const value = f[key];
    if (typeof value === "string" && value.trim()) out.push(t(source, { value }));
  };
  say("inMailbox", "in mailbox {value}");
  say("subject", "subject contains {value}");
  say("from", "from contains {value}");
  say("hasKeyword", "has keyword {value}");
  say("notKeyword", "without keyword {value}");
  return out;
}

/** The review policy in one line, including the external-send consent floor. */
export function reviewText(review: AgentReview): string {
  const base = t(AGENT_REVIEW_LABELS[review.mode]);
  const withNumber =
    review.mode === "threshold" && typeof review.threshold === "number"
      ? `${base} (${t("at {percent}% confidence or above", {
          percent: Math.round(review.threshold * 100),
        })})`
      : base;
  // The floor is the part a reader must not miss: without it an external
  // action pauses whatever the mode says (ADR 0003 resolution 10).
  return review.allowExternal
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
 */
export function ruleActions(rule: AgentRule): AgentAction[] {
  if (rule.tier === "T0") return rule.actions ?? [];
  if (rule.tier === "T1") return (rule.categories ?? []).flatMap((c) => c.actions);
  return [];
}
