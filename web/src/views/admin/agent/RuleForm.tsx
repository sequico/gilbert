/**
 * The automation editor (ADR 0003): an automation is authored as a form —
 * "When [event] / If [filters] / then what it is asked to do" — and never as
 * raw JSON. One rule document in, one out; the caller owns saving.
 *
 * Every option comes from a canonical catalogue (`AGENT_TRIGGERS` in
 * `@gilbert/agent/documents`) or from the rule schema the server publishes
 * (`x-actions`, read into `@/lib/agents`' catalogue), so the editor cannot
 * offer a trigger the matcher does not know or a capability the executor does
 * not have.
 */
import {
  AGENT_TRIGGERS,
  type AgentActionName,
  type AgentReview,
  type AgentReviewMode,
  type AgentRule,
  type AgentTrigger,
  isAgentTriggerOn,
} from "@gilbert/agent/documents";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  type AgentActionCatalogEntry,
  readDraft,
  readingNotCountedNote,
} from "@/lib/agents";
import { t } from "@/lib/i18n";
import {
  AGENT_REVIEW_LABELS,
  AGENT_REVIEW_MEANING_LABELS,
  AGENT_TRIGGER_LABELS,
} from "@/views/agent/agentText";

/** The filter keys whose value is a number, and must be written as one. */
const AGENT_FILTER_NUMBERS = new Set(["minSize", "maxSize"]);

const REVIEW_MODES: ReadonlyArray<AgentReviewMode> = ["always", "threshold", "never"];

function isReviewMode(x: string): x is AgentReviewMode {
  return (REVIEW_MODES as ReadonlyArray<string>).includes(x);
}

/**
 * The filter fields the executor honours: one entry for every key in
 * `SUPPORTED_FILTER_KEYS`, in the order the form reads best, so a filter the
 * runtime would act on is a filter this form can write. A key that exists on
 * the server and not here is an automation nobody can author, which is how a
 * "form only" promise turns into a rule that cannot be written at all.
 */
const AGENT_FILTER_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "inMailbox", label: "Mailbox" },
  { key: "subject", label: "Subject contains" },
  { key: "from", label: "From contains" },
  { key: "to", label: "To contains" },
  { key: "cc", label: "Cc contains" },
  { key: "text", label: "Anywhere contains" },
  { key: "body", label: "Body contains" },
  { key: "before", label: "Received before" },
  { key: "after", label: "Received after" },
  { key: "minSize", label: "Larger than (bytes)" },
  { key: "maxSize", label: "Smaller than (bytes)" },
  { key: "hasKeyword", label: "Has keyword" },
  { key: "notKeyword", label: "Not keyword" },
];

/** The keys above, as the set a condition's own keys are checked against. */
const AGENT_FILTER_KEYS = new Set(AGENT_FILTER_LABELS.map((f) => f.key));

/**
 * Whether this form can write a condition back.
 *
 * A condition it can write is a flat object of the keys above with string or
 * number values. Anything else — a nested group, a key no matcher implements,
 * a value of another type — is a document this form cannot spell out, and it is
 * carried as it is instead of being flattened into something it never was.
 */
function isWritableCondition(condition: unknown): condition is Record<string, unknown> {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return false;
  }
  for (const [key, value] of Object.entries(condition)) {
    if (!AGENT_FILTER_KEYS.has(key)) return false;
    if (typeof value !== "string" && typeof value !== "number") return false;
  }
  return true;
}

/** One condition's value for one field, as the input shows it. */
function filterValue(condition: unknown, key: string): string {
  if (!isWritableCondition(condition)) return "";
  const value = condition[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/** The review half of a draft: unset until the author chooses a mode. */
export interface AgentReviewInput {
  mode?: AgentReviewMode;
  threshold?: number;
  allowExternal?: boolean;
}

/**
 * A rule as the form holds it: everything a document carries, except the review
 * policy, which may not be chosen yet.
 */
export type AgentRuleDraft = Omit<AgentRule, "review"> & { review: AgentReviewInput };

/** A new automation, with nothing decided yet — its review policy included. */
export function blankRule(): AgentRuleDraft {
  return {
    v: 1,
    id: "",
    version: 1,
    name: "",
    enabled: true,
    trigger: { on: "email" },
    review: {},
    instruction: "",
    capabilities: [],
  };
}

/**
 * The document a draft describes, or null while it is not one yet.
 *
 * An automation is armed by a person's decision about who a run stops for, so
 * the review mode has no default: until it is chosen there is no document to
 * save (ADR 0003).
 */
export function ruleFromDraft(draft: AgentRuleDraft): AgentRule | null {
  const review = draft.review;
  if (!review.mode) return null;
  const settled: AgentReview = { mode: review.mode };
  if (review.mode === "threshold") settled.threshold = review.threshold ?? 0.7;
  if (review.allowExternal !== undefined) settled.allowExternal = review.allowExternal;
  return { ...draft, review: settled };
}

export function RuleForm({
  rule,
  group,
  catalogue,
  onChange,
}: {
  rule: AgentRuleDraft;
  /** The group this automation belongs to, for the author's reading. */
  group: string;
  /** The capability catalogue the rule schema publishes; null until it is read. */
  catalogue: AgentActionCatalogEntry[] | null;
  onChange(next: AgentRuleDraft): void;
}) {
  const set = (patch: Partial<AgentRuleDraft>) => onChange({ ...rule, ...patch });
  /*
   * The author's reading (ADR 0003): the draft and what it is about go to the
   * installation's model, which reads them beside the group's instruction and
   * its notebook and answers in words about the gaps. Nothing is saved: the
   * answer is shown beside the field it is about and forgotten when the panel
   * closes.
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
      t('the automation "{name}"', { name: rule.name || t("unnamed") }),
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
  const setReview = (patch: AgentReviewInput) =>
    set({ review: { ...rule.review, ...patch } });

  /*
   * A filter is written either flat — every key in it has to match — or as a
   * group of conditions under one of the three operators. The form shows
   * whichever shape the rule already has, and it models a group as the list it
   * is: every condition is there, editing one leaves the others alone, and a
   * condition this form cannot spell out is carried exactly as the document
   * holds it rather than dropped on the next keystroke.
   */
  const filter = rule.trigger.filter;
  const operator = typeof filter?.operator === "string" ? filter.operator : null;
  const grouped = operator !== null;
  const rawConditions = filter?.conditions;
  const conditions: unknown[] = !grouped
    ? [filter ?? {}]
    : Array.isArray(rawConditions)
      ? rawConditions
      : rawConditions === undefined
        ? []
        : [rawConditions];
  /** The conditions that carry something: an empty one narrows nothing. */
  const written = conditions.filter(
    (condition) => isWritableCondition(condition) && Object.keys(condition).length > 0,
  );

  /**
   * Write the conditions back, in the shape the document already has.
   *
   * A flat filter is one condition and no operator: it goes when the last key in
   * it goes. A group keeps its operator while it has a condition — an operator
   * without one is read by the matcher as "everything" (`AND`, `NOT`) or as
   * "nothing" (`OR`), and `filterProblems` refuses such a document — so the last
   * condition to be removed takes the operator with it.
   */
  const writeConditions = (next: unknown[]) => {
    if (!grouped) {
      const only = next[0];
      const kept =
        isWritableCondition(only) && Object.keys(only).length > 0 ? only : undefined;
      setTrigger({ filter: kept });
      return;
    }
    setTrigger({
      filter: next.length ? { operator: filter?.operator, conditions: next } : undefined,
    });
  };
  const setCondition = (index: number, key: string, raw: string) => {
    writeConditions(
      conditions.map((condition, i) => {
        // The conditions around this one are carried through untouched, whether
        // or not this form can write them.
        if (i !== index || !isWritableCondition(condition)) return condition;
        const next: Record<string, unknown> = { ...condition };
        if (!raw.trim()) delete next[key];
        // A size is a number, and the matcher compares numbers: a string here
        // is a filter that is valid and never matches.
        else if (AGENT_FILTER_NUMBERS.has(key)) next[key] = Number(raw);
        else next[key] = raw;
        return next;
      }),
    );
  };
  const addCondition = () => writeConditions([...conditions, {}]);
  const removeCondition = (index: number) =>
    writeConditions(conditions.filter((_, i) => i !== index));
  /**
   * Choose how the conditions compose. `All of these` on a filter that is not
   * grouped yet is the shape the form already writes, so it leaves the document
   * alone rather than rewriting it into a group of one — and an operator is
   * never written over nothing, because a filter nobody wrote is what the
   * server refuses: the selector moves once a condition carries something.
   */
  const setOperator = (next: string) => {
    if (next === "AND" && !grouped) return;
    if (!written.length) return;
    setTrigger({ filter: { operator: next, conditions } });
  };

  const capabilities = new Set(rule.capabilities);
  const toggleCapability = (name: string) => {
    if (capabilities.has(name as AgentActionName))
      capabilities.delete(name as AgentActionName);
    else capabilities.add(name as AgentActionName);
    // Kept in catalogue order rather than click order, so two rules that allow
    // the same capabilities read the same way.
    set({
      capabilities: (catalogue ?? [])
        .map((entry) => entry.name)
        .filter((candidate) =>
          capabilities.has(candidate as AgentActionName),
        ) as AgentActionName[],
    });
  };

  return (
    <div className="agent-form">
      <div className="field">
        <label htmlFor="agent-rule-name">{t("Name")}</label>
        <input
          id="agent-rule-name"
          className="input"
          value={rule.name}
          placeholder={t("File the invoices")}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
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
            if (isAgentTriggerOn(on)) setTrigger({ on });
          }}
        >
          {AGENT_TRIGGERS.map((on) => (
            <option key={on} value={on}>
              {t(AGENT_TRIGGER_LABELS[on])}
            </option>
          ))}
        </select>
      </div>
      {rule.trigger.on === "schedule" && (
        <div className="field">
          <label htmlFor="agent-rule-every">{t("Run every (minutes)")}</label>
          <input
            id="agent-rule-every"
            className="input"
            type="number"
            min={5}
            value={rule.trigger.everyMinutes ?? 60}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              if (Number.isFinite(minutes) && minutes >= 5) {
                setTrigger({ everyMinutes: Math.floor(minutes) });
              }
            }}
          />
          <p className="hint">
            {t("The smallest interval a scheduled automation may take is 5 minutes.")}
          </p>
        </div>
      )}
      {rule.trigger.on === "email" && (
        <>
          <h3>{t("If")}</h3>
          <p className="hint">
            {grouped
              ? t(
                  "The selector says how these conditions compose: all of them, any of them, or none of them.",
                )
              : t("Every filter must match. An empty filter matches every message.")}
          </p>
          <div className="field">
            <label htmlFor="agent-filter-operator">{t("Match")}</label>
            <select
              id="agent-filter-operator"
              className="input"
              value={operator ?? "AND"}
              disabled={!grouped && !written.length}
              onChange={(e) => setOperator(e.target.value)}
            >
              <option value="AND">{t("All of these")}</option>
              <option value="OR">{t("Any of these")}</option>
              <option value="NOT">{t("None of these")}</option>
            </select>
          </div>
          {grouped ? (
            <div className="agent-actions">
              {conditions.map((condition, i) => (
                <div className="agent-action" key={`condition-${i}`}>
                  <div className="agent-action-head">
                    <b>{t("Condition {n}", { n: i + 1 })}</b>
                    <button
                      type="button"
                      className="icon-btn xs danger"
                      aria-label={t("Remove condition")}
                      onClick={() => removeCondition(i)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <FilterFields
                    condition={condition}
                    idPrefix={`agent-filter-${i}`}
                    onChange={(key, raw) => setCondition(i, key, raw)}
                  />
                </div>
              ))}
              <button type="button" className="btn btn-sm" onClick={addCondition}>
                <Plus size={14} /> {t("Add condition")}
              </button>
            </div>
          ) : (
            <FilterFields
              condition={conditions[0]}
              idPrefix="agent-filter"
              onChange={(key, raw) => setCondition(0, key, raw)}
            />
          )}
        </>
      )}

      <h3>{t("What it does")}</h3>
      <div className="field">
        <label htmlFor="agent-rule-instruction">{t("Instruction")}</label>
        <textarea
          id="agent-rule-instruction"
          className="textarea"
          rows={6}
          value={rule.instruction}
          placeholder={t(
            "Read the message and say what should happen to it. Useful context, in plain words.",
          )}
          onChange={(e) => set({ instruction: e.target.value })}
        />
        <p className="hint">
          {t(
            "This prose is the whole of what a run is asked to do: every run hands it to the installation's model, which answers with actions from the capability list below.",
          )}
        </p>
        <p className="hint">
          {t(
            "The capability list below is the whole grant. The instruction steers inside it and never widens it.",
          )}
        </p>
        <p className="hint">
          {t(
            "It is read as data, not obeyed: a message that asks the model to do something is still just a message.",
          )}
        </p>
        <p className="hint">
          {t(
            "Say what this automation reacts to and what should happen to it — a bare box produces prose that guesses.",
          )}
        </p>
      </div>

      <div className="field">
        <label htmlFor="agent-rule-notes">{t("Your notes beside it")}</label>
        <textarea
          id="agent-rule-notes"
          className="textarea"
          rows={3}
          value={rule.notes ?? ""}
          placeholder={t(
            "Why this automation is written the way it is, and what it deliberately leaves out. Nobody's model reads this.",
          )}
          onChange={(e) => set({ notes: e.target.value })}
        />
        <p className="hint">
          {t(
            "Kept with the automation for whoever edits it next, and never sent to a model: a run carries the instruction and nothing beside it.",
          )}
        </p>
      </div>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={askReading}
        disabled={readingBusy || !group || !rule.instruction.trim()}
      >
        {readingBusy ? t("Reading…") : t("Ask the model to read it")}
      </button>
      {reading && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            {t("What the model said about this draft:")}
          </p>
          <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{reading}</p>
          {!readingCounted && <p className="hint">{readingNotCountedNote()}</p>}
        </div>
      )}

      <h3>{t("Review")}</h3>
      <div className="field">
        <label htmlFor="agent-rule-review">{t("When a person has to agree")}</label>
        <select
          id="agent-rule-review"
          className="select"
          value={rule.review.mode ?? ""}
          onChange={(e) => {
            const mode = e.target.value;
            if (!isReviewMode(mode)) return;
            // A threshold mode without a number would auto-execute everything,
            // which is the one reading nobody chose, so the switch supplies the
            // starting number ADR 0003 resolution 10 gives a new automation.
            setReview(
              mode === "threshold"
                ? { mode, threshold: rule.review.threshold ?? 0.7 }
                : { mode },
            );
          }}
        >
          {rule.review.mode === undefined && <option value="">{t("Choose…")}</option>}
          {REVIEW_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(AGENT_REVIEW_LABELS[mode])}
            </option>
          ))}
        </select>
      </div>
      {rule.review.mode === undefined ? (
        <p className="hint">
          {t(
            "Nobody has chosen yet, and there is no default: who a run stops for is the author's decision, so nothing can be saved until it is made.",
          )}
        </p>
      ) : (
        <p className="hint">{t(AGENT_REVIEW_MEANING_LABELS[rule.review.mode])}</p>
      )}
      {rule.review.mode === "threshold" && (
        <div className="field">
          <label htmlFor="agent-rule-threshold">
            {t("Confidence threshold (0 to 1)")}
          </label>
          <input
            id="agent-rule-threshold"
            className="input"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={rule.review.threshold ?? 0.7}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value >= 0 && value <= 1) {
                setReview({ threshold: value });
              }
            }}
          />
          <p className="hint">
            {t(
              "Above this confidence the run goes ahead unattended; below it the job waits for a person in the group's chat.",
            )}
          </p>
        </div>
      )}
      <label className="agent-check">
        <input
          type="checkbox"
          checked={rule.review.allowExternal === true}
          onChange={(e) => setReview({ allowExternal: e.target.checked })}
        />
        <span>
          {t(
            "Allow sending outside the group without a person — this raises the external-send consent floor.",
          )}
        </span>
      </label>
      <p className="hint">
        {t(
          "Off, an action that reaches outside the group always waits for a person, whatever the review policy says.",
        )}
      </p>

      <h3>{t("Capabilities")}</h3>
      <p className="hint">
        {t(
          "The allowlist: the only actions this automation may run. The model is offered these and nothing else, and an answer outside them is refused.",
        )}
      </p>
      {catalogue === null ? (
        <p className="hint">{t("The capability catalogue has not been read yet.")}</p>
      ) : (
        catalogue.map((entry) => (
          <label className="agent-check" key={entry.name}>
            <input
              type="checkbox"
              checked={capabilities.has(entry.name as AgentActionName)}
              onChange={() => toggleCapability(entry.name)}
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
        ))
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * One condition's fields: every filter key the executor honours, each with a
 * field of its own.
 *
 * A condition this form cannot write — a nested group, a key no matcher
 * implements, a value that is neither text nor a number — is shown as the
 * document holds it and is read-only on purpose: the form's promise is that it
 * does not quietly reshape a document, and rewriting a condition it cannot
 * spell out would be exactly that.
 */
function FilterFields({
  condition,
  idPrefix,
  onChange,
}: {
  condition: unknown;
  /** Distinguishes the fields of two conditions on one form. */
  idPrefix: string;
  onChange(key: string, raw: string): void;
}) {
  if (!isWritableCondition(condition)) {
    return (
      <>
        <p className="hint">
          {t(
            "This condition uses something this form cannot spell out, so it is shown as the document holds it and left exactly as it is.",
          )}
        </p>
        <pre className="mono small">{JSON.stringify(condition, null, 2)}</pre>
      </>
    );
  }
  return (
    <>
      {AGENT_FILTER_LABELS.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={`${idPrefix}-${f.key}`}>{t(f.label)}</label>
          <input
            id={`${idPrefix}-${f.key}`}
            className="input"
            value={filterValue(condition, f.key)}
            onChange={(e) => onChange(f.key, e.target.value)}
          />
          {f.key === "inMailbox" && (
            <p className="hint">
              {t("The mailbox id in the group's own account; it is matched exactly.")}
            </p>
          )}
        </div>
      ))}
    </>
  );
}
