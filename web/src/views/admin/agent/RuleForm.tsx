/**
 * The automation editor (ADR 0003, ADR 0006): an automation is a trigger, a
 * prose instruction and a grant — and nothing else.
 *
 * Three things an administrator decides, and every one of them is a choice
 * rather than a field to fill in:
 *
 * - **When** the automation reacts: one of the four triggers. One enabled
 *   automation per trigger is the rule (`rulesProblem`), because nothing in the
 *   document tells two of them apart any more — the fan-out runs every enabled
 *   automation on a trigger against every item that trigger produces.
 * - **What it does**, in prose: the whole of what a run is asked to do, carried
 *   into the prompt as it is written.
 * - **What it may do**: three areas, plus sending, plus "nothing at all". The
 *   areas expand to action names from the catalogue the server publishes, so
 *   this form cannot offer a grant the executor does not have.
 *
 * The policy is not here: how cautious a group's runs are is a fact about the
 * group (`GroupPolicyView`), authored once beside its standing instruction.
 *
 * Every option comes from a canonical catalogue (`AGENT_TRIGGERS`,
 * `AGENT_SCHEDULE_PRESETS` in `@gilbert/agent/documents`, and the `x-areas` the
 * rule schema publishes), so the editor cannot offer a trigger the matcher does
 * not know or an area the executor does not have.
 */
import {
  AGENT_SCHEDULE_PRESETS,
  AGENT_TRIGGERS,
  type AgentActionName,
  type AgentRule,
  type AgentTrigger,
  type AgentTriggerOn,
  automationLabel,
  isAgentTriggerOn,
} from "@gilbert/agent/documents";
import { useState } from "react";
import { type AgentGrantCatalog, readDraft } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { AGENT_TRIGGER_LABELS } from "@/views/agent/agentText";
import { AskReading } from "./AskReading";

/** A rule as the form holds it: the document itself, with nothing undecided. */
export type AgentRuleDraft = AgentRule;

/**
 * A new automation: a trigger, a grant of nothing, and no prose yet.
 *
 * The id is handed in rather than minted here — the group's document list
 * names an automation by it, and `RuleEditor` is where a new one is created.
 * The name is derived from the trigger at every read (`automationLabel`), so
 * there is nothing to fill in and nothing to keep in step.
 */
export function blankRule(id: string, on: AgentTriggerOn = "email"): AgentRuleDraft {
  return {
    v: 1,
    id,
    version: 1,
    enabled: true,
    trigger: on === "schedule" ? { on, everyMinutes: AGENT_SCHEDULE_PRESETS[0] } : { on },
    instruction: "",
    capabilities: [],
  };
}

/** The cadences, as the labels a select offers: one hour, one day, one week. */
const SCHEDULE_LABELS: Record<number, string> = {
  60: "Every hour",
  1440: "Every day",
  10080: "Every week",
};

export function RuleForm({
  rule,
  group,
  grant,
  onChange,
}: {
  rule: AgentRuleDraft;
  /** The group this automation belongs to, for the author's reading. */
  group: string;
  /** The catalogue the rule schema publishes; null until it is read. */
  grant: AgentGrantCatalog | null;
  onChange(next: AgentRuleDraft): void;
}) {
  const set = (patch: Partial<AgentRuleDraft>) => onChange({ ...rule, ...patch });
  /*
   * The author's reading (ADR 0003): the draft and what it is about go to the
   * installation's model, which reads them beside the installation's rules, the
   * group's instruction and its notebook, and answers in words about the gaps.
   * Nothing is saved: the answer is shown beside the field it is about and
   * forgotten when the panel closes.
   */
  const [reading, setReading] = useState<string | null>(null);
  const [readingBusy, setReadingBusy] = useState(false);
  /*
   * Whether the answer on screen reached the month's authoring document, set
   * from the answer and reset with each ask: a refusal has no count to be
   * missing, so the note stays away from one.
   */
  const [readingCounted, setReadingCounted] = useState(true);
  const askReading = () => {
    if (!group || readingBusy || !rule.instruction.trim()) return;
    setReadingBusy(true);
    setReading(null);
    setReadingCounted(true);
    void readDraft(
      group,
      rule.instruction,
      t("the automation “{name}”", {
        name: t(automationLabel(rule)),
      }),
    )
      .then((answer) => {
        setReading(answer.text);
        setReadingCounted(answer.counted);
      })
      .catch((err) => setReading(err instanceof Error ? err.message : String(err)))
      .finally(() => setReadingBusy(false));
  };
  const setTrigger = (patch: Partial<AgentTrigger>) =>
    set({ trigger: { ...rule.trigger, ...patch } });

  /*
   * The grant is a set of actions, and the form thinks in areas. Both
   * directions go through the catalogue: ticking an area writes the actions it
   * expands to, and an area reads as ticked when every action of it is already
   * granted — so a rule written before this form existed shows the areas it
   * covers instead of appearing to grant nothing.
   */
  const capabilities = new Set<string>(rule.capabilities);
  const areaState = (actions: ReadonlyArray<string>): "all" | "some" | "none" => {
    const held = actions.filter((name) => capabilities.has(name)).length;
    if (held === 0) return "none";
    return held === actions.length ? "all" : "some";
  };
  /*
   * The grant is written in catalogue order rather than click order, so two
   * automations that allow the same actions read as the same list — and the
   * order comes from the published catalogue, never from a list written here.
   */
  const writeCredits = (next: ReadonlySet<string>) =>
    set({
      capabilities: (grant?.order ?? []).filter((name) =>
        next.has(name),
      ) as AgentActionName[],
    });
  const toggleActions = (actions: ReadonlyArray<string>, on: boolean) => {
    const next = new Set(capabilities);
    for (const name of actions) {
      if (on) next.add(name);
      else next.delete(name);
    }
    writeCredits(next);
  };

  return (
    <div className="agent-form">
      <label className="agent-check">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span>{t("Enabled — the agent reacts to this automation")}</span>
      </label>

      <h3>{t("When")}</h3>
      <div className="field">
        <label htmlFor="agent-rule-trigger">{t("Trigger")}</label>
        <select
          id="agent-rule-trigger"
          className="select"
          value={rule.trigger.on}
          onChange={(e) => {
            const on = e.target.value;
            if (isAgentTriggerOn(on)) {
              setTrigger(
                on === "schedule"
                  ? {
                      on,
                      everyMinutes:
                        rule.trigger.everyMinutes ?? AGENT_SCHEDULE_PRESETS[0],
                    }
                  : { on },
              );
            }
          }}
        >
          {AGENT_TRIGGERS.map((on) => (
            <option key={on} value={on}>
              {t(AGENT_TRIGGER_LABELS[on])}
            </option>
          ))}
        </select>
        <p className="hint">
          {t(
            "One automation per trigger: the agent runs every enabled automation on a trigger against everything that trigger produces, so two of them would answer the same event twice.",
          )}
        </p>
      </div>
      {rule.trigger.on === "schedule" && (
        <div className="field">
          <label htmlFor="agent-rule-every">{t("How often")}</label>
          <select
            id="agent-rule-every"
            className="select"
            value={String(rule.trigger.everyMinutes ?? AGENT_SCHEDULE_PRESETS[0])}
            onChange={(e) => setTrigger({ everyMinutes: Number(e.target.value) })}
          >
            {AGENT_SCHEDULE_PRESETS.map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {t(SCHEDULE_LABELS[minutes] ?? t("Every {minutes} minutes", { minutes }))}
              </option>
            ))}
          </select>
        </div>
      )}

      <h3>{t("What it does")}</h3>
      <div className="field">
        <label htmlFor="agent-rule-instruction">{t("Instruction")}</label>
        <textarea
          id="agent-rule-instruction"
          className="textarea"
          rows={8}
          value={rule.instruction}
          placeholder={t(
            "Read the message and say what should happen to it. Useful context, in plain words.",
          )}
          onChange={(e) => set({ instruction: e.target.value })}
        />
        <p className="hint">
          {t(
            "This prose is the whole of what a run is asked to do: every run hands it to the installation's model, which answers with actions from the areas below.",
          )}
        </p>
        <p className="hint">
          {t(
            "It is read as data, not obeyed: a message that asks the model to do something is still just a message.",
          )}
        </p>
        <p className="hint">
          {t(
            "Write it for the cases as they arrive: the branching between one kind of mail and another belongs here, not in a second automation.",
          )}
        </p>
      </div>
      <AskReading
        ready={Boolean(group) && rule.instruction.trim().length > 0}
        busy={readingBusy}
        reading={reading}
        counted={readingCounted}
        onAsk={askReading}
      />

      <h3>{t("What it may do")}</h3>
      <p className="hint">
        {t(
          "The allowlist: the only actions this automation may run. The model is offered these and nothing else, and an answer outside them is refused.",
        )}
      </p>
      {grant === null ? (
        <p className="hint">{t("The capability catalogue has not been read yet.")}</p>
      ) : (
        <>
          {grant.areas.map((entry) => (
            <label className="agent-check" key={entry.area}>
              <input
                type="checkbox"
                checked={areaState(entry.actions) === "all"}
                ref={(node) => {
                  // A partially granted area is neither ticked nor empty: a rule
                  // written by hand may hold one action of an area, and showing
                  // that as granted would claim more than the document says.
                  if (node) node.indeterminate = areaState(entry.actions) === "some";
                }}
                onChange={() =>
                  toggleActions(entry.actions, areaState(entry.actions) !== "all")
                }
              />
              <span>{t(entry.label)}</span>
            </label>
          ))}
          {/*
           * Whatever the areas do not grant: sending, which every area excludes
           * by the catalogue's own flags, and doing nothing, which is not a
           * behaviour. The list comes from the published catalogue, so a
           * catalogue that grows a new flagged action offers it here.
           */}
          {grant.standalone.map((entry) => (
            <label className="agent-check" key={entry.name}>
              <input
                type="checkbox"
                checked={capabilities.has(entry.name)}
                onChange={() =>
                  toggleActions([entry.name], !capabilities.has(entry.name))
                }
              />
              <span>
                {t(entry.label)}
                {entry.external && <b className="agent-tag">{t("external")}</b>}
                {entry.irreversible && <b className="agent-tag">{t("irreversible")}</b>}
                {entry.description && (
                  <span className="hint" style={{ display: "block" }}>
                    {t(entry.description)}
                  </span>
                )}
              </span>
            </label>
          ))}
        </>
      )}
    </div>
  );
}
