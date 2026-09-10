/**
 * The automation editor (ADR 0003 resolution 2): an automation is authored as
 * a form — "Quando [evento] / Se [filtri] / Allora [azioni]" — and never as raw
 * JSON. One rule document in, one out; the caller owns saving.
 *
 * Every option and every parameter comes from the canonical catalogue
 * (`AGENT_ACTION_SPECS`, `AGENT_AREAS`, `AGENT_TIERS`, `AGENT_TRIGGERS` in
 * `@gilbert/agent/documents`), so the editor cannot offer a capability the
 * executor does not have, nor invent a field the document validator refuses.
 */
import {
  AGENT_ACTION_SPECS,
  AGENT_AREAS,
  AGENT_TIERS,
  AGENT_TRIGGERS,
  type AgentAction,
  type AgentActionName,
  type AgentActionParam,
  type AgentCategory,
  type AgentReview,
  type AgentReviewMode,
  type AgentRule,
  type AgentTier,
  type AgentTrigger,
  agentActionSpec,
  isAgentArea,
  isAgentTier,
  isAgentTriggerOn,
} from "@gilbert/agent/documents";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";
import {
  AGENT_AREA_LABELS,
  AGENT_REVIEW_LABELS,
  AGENT_TIER_LABELS,
  AGENT_TRIGGER_LABELS,
  actionLabel,
} from "@/views/agent/agentText";

/** What each parameter kind holds, as the field's placeholder. */
const AGENT_PARAM_LABELS: Record<AgentActionParam["kind"], string> = {
  text: "Text",
  number: "A number",
  mailbox: "Mailbox id",
  folder: "Files folder",
  keyword: "Label keyword",
};

/**
 * What each parameter the catalogue declares is called, as the field's label.
 *
 * The catalogue names a parameter by its key — `folder`, `name` — because that
 * is what the executor reads in the document; the form names it for a person.
 * A key that is not here is shown as the catalogue wrote it.
 */
const AGENT_PARAM_KEY_LABELS: Record<string, string> = {
  keyword: "Label",
  mailbox: "Mailbox",
  create: "Create the mailbox if it is missing",
  folder: "Folder",
  name: "File name",
  to: "To",
  subject: "Subject",
  text: "Text",
};

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

export function RuleForm({
  rule,
  onChange,
}: {
  rule: AgentRule;
  onChange(next: AgentRule): void;
}) {
  const set = (patch: Partial<AgentRule>) => onChange({ ...rule, ...patch });
  const setTrigger = (patch: Partial<AgentTrigger>) =>
    set({ trigger: { ...rule.trigger, ...patch } });
  const setReview = (patch: Partial<AgentReview>) =>
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

  /*
   * Each tier needs the material it runs on — the document validator refuses a
   * T2 rule without an instruction, a T1 without categories, a T0 without an
   * action list — so switching tier seeds what is missing. What another tier
   * already holds is kept: an admin who switches to look at the other shape and
   * switches back must not lose their work.
   */
  const setTier = (tier: AgentTier) => {
    const patch: Partial<AgentRule> = { tier };
    if (tier === "T0" && !rule.actions) patch.actions = [];
    if (tier === "T1" && !rule.categories?.length) {
      patch.categories = [{ name: "", actions: [] }];
    }
    if (tier === "T2" && rule.instruction === undefined) patch.instruction = "";
    set(patch);
  };

  const capabilities = new Set(rule.capabilities ?? []);
  const toggleCapability = (name: AgentActionName) => {
    if (capabilities.has(name)) capabilities.delete(name);
    else capabilities.add(name);
    // Kept in catalogue order rather than click order, so two rules that allow
    // the same capabilities read the same way.
    set({
      capabilities: AGENT_ACTION_SPECS.filter((s) => capabilities.has(s.name)).map(
        (s) => s.name,
      ),
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
        <span>{t("Enabled — the worker reacts to this automation")}</span>
      </label>

      <div className="field">
        <label htmlFor="agent-rule-area">{t("Area")}</label>
        <select
          id="agent-rule-area"
          className="select"
          value={rule.area}
          onChange={(e) => {
            if (isAgentArea(e.target.value)) set({ area: e.target.value });
          }}
        >
          {AGENT_AREAS.map((a) => (
            <option key={a} value={a}>
              {t(AGENT_AREA_LABELS[a])}
            </option>
          ))}
        </select>
      </div>

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

      <h3>{t("Tier")}</h3>
      <div className="field">
        <label htmlFor="agent-rule-tier">{t("Which model serves this automation")}</label>
        <select
          id="agent-rule-tier"
          className="select"
          value={rule.tier}
          onChange={(e) => {
            if (isAgentTier(e.target.value)) setTier(e.target.value);
          }}
        >
          {AGENT_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {t(AGENT_TIER_LABELS[tier])}
            </option>
          ))}
        </select>
      </div>

      <h3>{t("Review")}</h3>
      <div className="field">
        <label htmlFor="agent-rule-review">{t("When a person has to agree")}</label>
        <select
          id="agent-rule-review"
          className="select"
          value={rule.review.mode}
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
          {REVIEW_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(AGENT_REVIEW_LABELS[mode])}
            </option>
          ))}
        </select>
      </div>
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
          "The allowlist. The executor refuses anything outside it, and a T2 model is validated against it too.",
        )}
      </p>
      {AGENT_ACTION_SPECS.map((spec) => (
        <label className="agent-check" key={spec.name}>
          <input
            type="checkbox"
            checked={capabilities.has(spec.name)}
            onChange={() => toggleCapability(spec.name)}
          />
          <span>
            {t(spec.label)}
            {spec.external && <b className="agent-tag">{t("external")}</b>}
            {spec.irreversible && <b className="agent-tag">{t("irreversible")}</b>}
          </span>
        </label>
      ))}

      <h3>{t("Then")}</h3>
      {rule.tier === "T0" && (
        <ActionListEditor
          actions={rule.actions ?? []}
          onChange={(actions) => set({ actions })}
        />
      )}
      {rule.tier === "T1" && (
        <CategoryEditor
          categories={rule.categories ?? []}
          onChange={(categories) => set({ categories })}
        />
      )}
      {rule.tier === "T2" && (
        <div className="field">
          <label htmlFor="agent-rule-instruction">{t("Instruction for the model")}</label>
          <textarea
            id="agent-rule-instruction"
            className="input"
            rows={5}
            value={rule.instruction ?? ""}
            placeholder={t(
              "Read the message and say what should happen to it. Useful context, in plain words.",
            )}
            onChange={(e) => set({ instruction: e.target.value })}
          />
        </div>
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

/* ------------------------------------------------------------------ */

/** A T1 category: the name the classifier returns, then its fixed actions. */
function CategoryEditor({
  categories,
  onChange,
}: {
  categories: AgentCategory[];
  onChange(next: AgentCategory[]): void;
}) {
  return (
    <div className="agent-actions">
      <p className="hint">
        {t(
          "The model picks one of these categories by name; the actions you attach to it are what actually run.",
        )}
      </p>
      {categories.map((category, i) => (
        <div className="agent-action" key={`category-${i}`}>
          <div className="agent-action-head">
            <input
              className="input"
              value={category.name}
              placeholder={t("Invoice")}
              aria-label={t("Category name")}
              onChange={(e) =>
                onChange(
                  categories.map((c, k) =>
                    k === i ? { ...c, name: e.target.value } : c,
                  ),
                )
              }
            />
            <button
              type="button"
              className="icon-btn xs danger"
              aria-label={t("Remove category")}
              onClick={() => onChange(categories.filter((_, k) => k !== i))}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <ActionListEditor
            actions={category.actions}
            idScope={`category-${i}-`}
            onChange={(actions) =>
              onChange(categories.map((c, k) => (k === i ? { ...c, actions } : c)))
            }
          />
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onChange([...categories, { name: "", actions: [] }])}
      >
        <Plus size={14} /> {t("Add a category")}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** An ordered action list: the order is the order the executor runs them in. */
function ActionListEditor({
  actions,
  onChange,
  idScope = "",
}: {
  actions: AgentAction[];
  onChange(next: AgentAction[]): void;
  /**
   * Distinguishes the fields of two lists on one form: a T1 automation holds
   * one list per category, and the same action can appear in both.
   */
  idScope?: string;
}) {
  const move = (from: number, by: number) => {
    const to = from + by;
    const a = actions[from];
    const b = actions[to];
    if (!a || !b) return;
    const next = [...actions];
    next[from] = b;
    next[to] = a;
    onChange(next);
  };
  return (
    <div className="agent-actions">
      {actions.length === 0 && <p className="hint">{t("No actions yet.")}</p>}
      {actions.map((action, i) => (
        <div className="agent-action" key={`${action.do}-${i}`}>
          <div className="agent-action-head">
            <b>{actionLabel(action.do)}</b>
            <span className="agent-action-tools">
              <button
                type="button"
                className="icon-btn xs"
                aria-label={t("Move up")}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className="icon-btn xs"
                aria-label={t("Move down")}
                disabled={i === actions.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                className="icon-btn xs danger"
                aria-label={t("Remove action")}
                onClick={() => onChange(actions.filter((_, k) => k !== i))}
              >
                <Trash2 size={13} />
              </button>
            </span>
          </div>
          <ActionParams
            action={action}
            id={`${idScope}${i}`}
            onChange={(next) => onChange(actions.map((a, k) => (k === i ? next : a)))}
          />
        </div>
      ))}
      <select
        className="select"
        value=""
        aria-label={t("Add an action")}
        onChange={(e) => {
          const name = e.target.value;
          if (name) onChange([...actions, { do: name as AgentActionName }]);
        }}
      >
        <option value="">{t("Add an action…")}</option>
        {AGENT_ACTION_SPECS.map((spec) => (
          <option key={spec.name} value={spec.name}>
            {t(spec.label)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The parameters an action's own catalogue entry declares, and no others. */
function ActionParams({
  action,
  id,
  onChange,
}: {
  action: AgentAction;
  /** The action's position in its list: two of a kind are still two fields. */
  id: string;
  onChange(next: AgentAction): void;
}) {
  const spec = agentActionSpec(action.do);
  if (!spec?.params.length) return null;
  const field = `agent-param-${id}-${action.do}`;
  return (
    <div className="agent-action-params">
      {spec.params.map((p) => (
        <div className="field" key={p.key}>
          <label htmlFor={`${field}-${p.key}`}>
            {t(AGENT_PARAM_KEY_LABELS[p.key] ?? p.key)}
            {p.required ? "" : ` · ${t("optional")}`}
          </label>
          <input
            id={`${field}-${p.key}`}
            className="input"
            type={p.kind === "number" ? "number" : "text"}
            value={paramValue(action, p.key)}
            placeholder={t(AGENT_PARAM_LABELS[p.kind])}
            onChange={(e) => onChange(setParam(action, p.key, e.target.value, p.kind))}
          />
        </div>
      ))}
    </div>
  );
}

function paramValue(action: AgentAction, key: string): string {
  const value = action.with?.[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

/**
 * One parameter written back. A blank field removes the key rather than
 * storing an empty string, because a required parameter that is "present but
 * empty" would pass the document validator and then do nothing.
 */
function setParam(
  action: AgentAction,
  key: string,
  raw: string,
  kind: AgentActionParam["kind"],
): AgentAction {
  const next: Record<string, unknown> = { ...(action.with ?? {}) };
  if (raw.trim() === "") delete next[key];
  else next[key] = kind === "number" ? Number(raw) : raw;
  const out: AgentAction = { do: action.do };
  if (Object.keys(next).length) out.with = next;
  return out;
}
