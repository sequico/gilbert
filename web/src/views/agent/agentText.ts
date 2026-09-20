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
  type AgentLookup,
  type AgentMeter,
  type AgentReviewMode,
  type AgentRule,
  type AgentTrigger,
  type AgentTriggerOn,
  actionParamsText,
  agentActionSpec,
  automationLabel,
  lookupLabel,
  scheduleMinutesOf,
} from "@gilbert/agent/documents";
import type {
  AgentStatusMeter,
  AgentStatusReason,
  GroupPolicyView,
  MemberAgentRule,
  RosterReadability,
} from "@gilbert/agent/views";
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
 * What a review policy means for the runs it governs.
 *
 * The label names the mode; these sentences say what the mode does, because
 * the one thing an author has to decide is who a run stops for. The last two
 * clauses are what no mode can raise: an action that cannot be undone asks
 * whatever the policy says, and one that leaves the group asks unless the
 * consent floor has been raised on purpose.
 */
export const AGENT_REVIEW_MEANING_LABELS: Record<AgentReviewMode, string> = {
  always: "Every run stops here for a person to answer before anything happens.",
  threshold:
    "A run at or above the confidence runs unattended; below it, it waits for a person.",
  never:
    "Nothing waits for a person — though an action that cannot be undone still asks, and one that leaves the group asks unless the consent floor is raised.",
};

export function reviewMeaningText(mode: string): string {
  const label = AGENT_REVIEW_MEANING_LABELS[mode as AgentReviewMode];
  return label ? t(label) : "";
}

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
  refused: "Refused",
};

/** The catalogue's own labels, keyed by capability name. */
export const AGENT_ACTION_LABELS: Record<string, string> = Object.fromEntries(
  AGENT_ACTION_SPECS.map((s): [string, string] => [s.name, s.label]),
);

export function actionLabel(name: string): string {
  return t(AGENT_ACTION_LABELS[name] ?? name);
}

/**
 * What a meter reads as, in words.
 *
 * The counts are tokens and never money — a price list belongs to a vendor and
 * changes without asking (ADR 0003) — and a run the provider reported nothing
 * for is said out loud rather than folded in as a zero, because a reading that
 * understated the bill would be worse than one that admits what it does not
 * know.
 */
export function meterText(meter: AgentMeter): string {
  const count = (value: number | null): string =>
    value === null ? t("unknown") : value.toLocaleString();
  const base = t(
    "{runs} runs · {hit} tokens read from cache, {miss} read fresh, {out} written",
    {
      runs: meter.runs.toLocaleString(),
      hit: count(meter.inputHitTokens),
      miss: count(meter.inputMissTokens),
      out: count(meter.outputTokens),
    },
  );
  return meter.uncounted > 0
    ? `${base} · ${t("{n} of them reported no usage", { n: meter.uncounted })}`
    : base;
}

/**
 * The installation's use, as lines a surface renders in order (ADR 0003).
 *
 * The total first — the number a deployment is judged by — then one line per
 * agent that spent a call, and last the groups whose audit could not be read:
 * the total is a floor then, and saying so is the difference between "this is
 * everything" and "this is what I could see".
 */
export function fleetMeterLines(meter: AgentStatusMeter): string[] {
  const lines = [
    t("This installation has spent: {meter}", { meter: meterText(meter.total) }),
  ];
  for (const row of meter.byAgent)
    lines.push(
      t("{agent}: {meter}", {
        agent: row.agent || t("no agent named"),
        meter: meterText(row.meter),
      }),
    );
  if (meter.unreadable.length > 0)
    lines.push(
      t(
        "The audit of {groups} could not be read, so this total is a floor: their runs are in no count here.",
        { groups: meter.unreadable.join(", ") },
      ),
    );
  return lines;
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
 * refused said — never a sentence of the server's own English (ADR 0003,
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
 * What the roster read's state means for a person, and what fixes it.
 *
 * `ok` answers nothing on purpose: this is the installation working as
 * designed, and a line about it would be furniture. Every other state says
 * what a reader loses *and* keeps — the `@` offers the people who have already
 * written — so nobody goes looking for a bug in the chat.
 */
export function rosterText(readability: RosterReadability): string {
  switch (readability) {
    case "forbidden":
      return t(
        "This installation cannot list a group's members: the Master may not read the account registry. Give it the sysAccountGet and sysAccountQuery permissions — a per-account grant, not an administrator role — and the chat's @ offers the group's members; until then it offers the people who have already written.",
      );
    case "unreadable":
      return t(
        "The account registry did not answer, so a group's members cannot be listed and the chat's @ offers the people who have already written.",
      );
    case "unknown":
      return t(
        "No agent is registered, so nothing can read a group's members: the chat's @ offers the people who have already written.",
      );
    default:
      return "";
  }
}

/**
 * The trigger in one line: what wakes the automation, and how often for a
 * scheduled one.
 *
 * There is nothing else to say about it. An automation carries no filter — the
 * discrimination between one case and another belongs in its prose (ADR 0006) —
 * so the line is the trigger and, for the clock, its cadence.
 *
 * A partial document renders as far as it can: an unknown event is shown as the
 * value it carries, and a trigger that is not there at all describes nothing
 * rather than crashing the panel that shows it.
 */
export function triggerText(trigger: AgentTrigger | undefined): string {
  const on = trigger?.on;
  if (!on) return "";
  const base = t(AGENT_TRIGGER_LABELS[on] ?? on);
  if (on !== "schedule") return base;
  return `${base} · ${scheduleText({ trigger })}`;
}

/**
 * A cadence in words, from the same table the editor offers.
 *
 * The preset names and the interval they stand for are one fact, so a value the
 * select cannot produce — a document written by hand, or by a build that had
 * other presets — is still said in minutes rather than dropped out of the
 * sentence.
 */
const SCHEDULE_LABELS: Record<number, string> = {
  60: "every hour",
  1440: "every day",
  10080: "every week",
};

export function scheduleText(rule: Pick<AgentRule, "trigger">): string {
  const minutes = scheduleMinutesOf(rule);
  const label = SCHEDULE_LABELS[minutes];
  return label ? t(label) : t("every {minutes} minutes", { minutes });
}

/**
 * The group's policy in one line, including the external-send consent floor.
 *
 * It is one line per group rather than one per automation, because it is one
 * document per group: how cautious a group's runs are is a fact about the
 * group (ADR 0006). The floor is the part a reader must not miss — without the
 * group having raised it, an action that leaves the group waits whatever the
 * mode says.
 */
export function reviewText(policy: GroupPolicyView | undefined): string {
  const mode = policy?.review;
  if (!mode) return "";
  const base = t(AGENT_REVIEW_LABELS[mode] ?? mode);
  return policy?.allowExternal
    ? `${base} · ${t("sending outside the group allowed without a person")}`
    : `${base} · ${t("sending outside the group always waits for a person")}`;
}

/**
 * How far a document of prose has got, in one line, for the surfaces that show
 * one: who wrote it last and when, or that nobody has.
 *
 * One renderer for every document of this kind — the installation's rules, a
 * group's instruction, a group's policy, the notebook — because they are one
 * thing a person writes and a surface reports, and four copies of the sentence
 * are four chances for one of them to drift. It takes the two fields the
 * sentence is made of rather than a whole view, so a caller that holds a
 * stamp and not a document can still ask for the sentence.
 */
export function proseStampText(
  doc: { updatedAt?: string | null; updatedBy?: string | null } | undefined | null,
): string {
  if (!doc?.updatedAt) return t("Nobody has written here yet.");
  return t("Last written by {who} on {when}.", {
    who: doc.updatedBy ?? t("an administrator"),
    when: doc.updatedAt,
  });
}

/**
 * One action as a sentence: the catalogue's label plus its parameters.
 *
 * The parameter half is `actionParamsText`, the renderer the server's approval
 * prompt uses too, so "what would it do" reads the same to the person who
 * approves a run and to the member who reads it afterwards (ADR 0003).
 */
export function actionText(action: AgentAction): string {
  const spec = agentActionSpec(action.do);
  const label = spec ? t(spec.label) : action.do;
  const params = actionParamsText(action);
  return params ? `${label} (${params})` : label;
}

/**
 * What a run looked up, as a reader sees it (ADR 0020).
 *
 * The one renderer of a lookup's name, shared with the server's own trail, so
 * "what did this run read" reads the same in the chat a run wrote to and in the
 * audit an administrator opens.
 */
export function lookupText(lookup: AgentLookup): string {
  return t(lookupLabel(lookup));
}

/**
 * The instruction an automation carries — what it is asked to do, in the
 * author's own words and the whole of what a run is told.
 *
 * It takes either of the two shapes that describe one durable document: the
 * editor holds the stored `AgentRule`, and the member's panel holds the view
 * the server answers with (`MemberAgentRule`), a `Pick` of the same fields.
 */
export function ruleInstruction(rule: AgentRule | MemberAgentRule): string {
  return rule.instruction ?? "";
}

/**
 * What to call an automation in a surface, in the reader's language.
 *
 * One function, so the editor, the member's panel and the audit see the same
 * words: the English table is the key a catalogue looks up, and a language that
 * has not translated it reads the English (ADR 0006).
 */
export function automationText(rule: { trigger?: AgentTrigger }): string {
  return t(automationLabel(rule));
}
