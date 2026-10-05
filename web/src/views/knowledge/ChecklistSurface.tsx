/**
 * The checklist template surface (ADR 0030).
 *
 * A checklist template is a **process**, not a form: **variants** a workorder
 * picks once, and ordered **sections** of **steps**, each carrying an optional
 * **condition** on a variant value and a section an optional **repeat**. This
 * renders that process in the app's own UI — a structured, read-only view when
 * the page is read, a purpose-built builder over the same model when it is
 * edited. No form-builder library and no schema stand between the controls and
 * the stored rules, so a template is exactly what the author sees.
 *
 * The module is a lazy chunk: authoring is loaded when a template opens, never
 * with the app's first paint (ADR 0030).
 */
import { ChevronDown, ChevronUp, Plus, Trash2, X } from "lucide-react";
import { t } from "@/lib/i18n";
import {
  conditionClause,
  type KnowledgeChecklist,
  type KnowledgeCondition,
  type KnowledgeItemField,
  type KnowledgeRepeat,
  type KnowledgeSection,
  type KnowledgeStep,
  type KnowledgeVariant,
  type KnowledgeVariantValue,
} from "@/lib/knowledge";

/** A label turned into a key: lower-case words joined by dashes. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * A key minted from a label, made unique against the keys already in scope.
 *
 * A step's key is its stable identity inside the template (a workorder keys its
 * state on `section.step`), so a key is minted once and then left alone even
 * when the label changes; only a collision with a sibling takes the next free
 * suffix.
 */
function mintKey(label: string, taken: Iterable<string>, fallback: string): string {
  const base = slugify(label) || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** One item's label input, the same shape everywhere in the builder. */
function LabelInput({
  value,
  placeholder,
  onChange,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** Called on blur or Enter, where a key is derived from the settled label. */
  onCommit?: () => void;
}) {
  return (
    <input
      className="input sm grow"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit?.();
        }
      }}
    />
  );
}

/** The stable key derived from a label, shown read-only beside it. */
function KeyHint({ value }: { value: string }) {
  if (!value) return null;
  return (
    <span className="hint mono nowrap" title={t("Key")}>
      {value}
    </span>
  );
}

/**
 * The condition on a section or a step: which variant, and which value.
 *
 * A condition sits on both, so it is one control; a section or step with no
 * condition is shown always ("Always"). Changing the variant resets the value
 * to its first one, and choosing "Always" removes the condition.
 */
function ConditionField({
  condition,
  variants,
  onChange,
}: {
  condition: KnowledgeCondition | undefined;
  variants: KnowledgeVariant[];
  onChange: (condition: KnowledgeCondition | undefined) => void;
}) {
  // A condition branches on a variant; with no variant and no existing
  // condition there is nothing to offer. A condition whose variant was removed
  // is still shown, so it can be cleared.
  if (!variants.length && !condition) return null;
  const variantKey = condition?.variant ?? "";
  const selected = variants.find((v) => v.key === variantKey);
  // A condition can name a variant that was removed; the select still offers it
  // rather than silently falling back to "Always".
  const options: KnowledgeVariant[] =
    variantKey && !selected
      ? [...variants, { key: variantKey, label: variantKey, values: [] }]
      : variants;
  return (
    <div className="row wrap gap-8 mt-8">
      <span className="hint nowrap">{t("Show when")}</span>
      <select
        className="select"
        style={{ width: "auto" }}
        value={variantKey}
        aria-label={t("Condition variant")}
        onChange={(e) => {
          const key = e.target.value;
          if (!key) {
            onChange(undefined);
            return;
          }
          const first = variants.find((v) => v.key === key)?.values[0]?.value ?? "";
          onChange({ variant: key, equals: first });
        }}
      >
        <option value="">{t("Always")}</option>
        {options.map((v) => (
          <option key={v.key} value={v.key}>
            {v.label || v.key}
          </option>
        ))}
      </select>
      {variantKey && (
        <select
          className="select"
          style={{ width: "auto" }}
          value={condition?.equals ?? ""}
          aria-label={t("Condition value")}
          onChange={(e) => onChange({ variant: variantKey, equals: e.target.value })}
        >
          <option value="">{t("Choose a value")}</option>
          {(selected?.values ?? []).map((v) => (
            <option key={v.value} value={v.value}>
              {v.label || v.value}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** The read-only rendering of a template's process. */
function StructuredView({ checklist }: { checklist: KnowledgeChecklist }) {
  const { variants, sections } = checklist;
  if (!variants.length && !sections.length)
    return <p className="hint">{t("No process defined yet.")}</p>;
  return (
    <>
      {variants.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>{t("Variants")}</h3>
          </div>
          <div className="row wrap gap-8" style={{ alignItems: "flex-start" }}>
            {variants.map((v) => (
              <span className="chip" key={v.key || v.label}>
                {v.label || v.key}
                {v.values.length > 0 &&
                  `: ${v.values.map((x) => x.label || x.value).join(", ")}`}
              </span>
            ))}
          </div>
        </div>
      )}
      {sections.map((section) => (
        <div className="card" key={section.key || section.label}>
          <div className="card-head">
            <h3>{section.label || section.key}</h3>
            <span className="spacer" />
            {section.repeat && (
              <span className="hint nowrap">
                {t("per {item}", { item: section.repeat.item })}
              </span>
            )}
            {section.condition && (
              <span className="hint nowrap">{conditionClause(section.condition)}</span>
            )}
          </div>
          {section.steps.length === 0 ? (
            <p className="hint">{t("No steps.")}</p>
          ) : (
            <div className="col gap-4 mt-8">
              {section.steps.map((step) => (
                <div className="row gap-8" key={step.key || step.label}>
                  <span>{step.label || step.key}</span>
                  {step.condition && (
                    <span className="hint nowrap">{conditionClause(step.condition)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The purpose-built process builder.
 *
 * The model is the checklist itself: every control writes a `KnowledgeChecklist`
 * through `onChange`, and keys are minted from labels once, so the stored rules
 * are exactly what the panels show.
 */
function ProcessBuilder({
  checklist,
  onChange,
}: {
  checklist: KnowledgeChecklist;
  onChange: (checklist: KnowledgeChecklist) => void;
}) {
  const { variants, sections } = checklist;
  const emit = (next: KnowledgeChecklist) => onChange(next);
  const setVariants = (next: KnowledgeVariant[]) =>
    emit({ ...checklist, variants: next });
  const setSections = (next: KnowledgeSection[]) =>
    emit({ ...checklist, sections: next });

  const patchVariant = (i: number, patch: Partial<KnowledgeVariant>) =>
    setVariants(variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const addVariant = () => setVariants([...variants, { key: "", label: "", values: [] }]);
  const removeVariant = (i: number) => setVariants(variants.filter((_, j) => j !== i));
  const deriveVariantKey = (i: number) => {
    const variant = variants[i];
    if (!variant || variant.key) return;
    const taken = variants.filter((_, j) => j !== i).map((v) => v.key);
    patchVariant(i, { key: mintKey(variant.label, taken, "variant") });
  };

  const valuesOf = (i: number) => variants[i]?.values ?? [];
  const patchValue = (i: number, k: number, patch: Partial<KnowledgeVariantValue>) =>
    patchVariant(i, {
      values: valuesOf(i).map((v, j) => (j === k ? { ...v, ...patch } : v)),
    });
  const addValue = (i: number) =>
    patchVariant(i, { values: [...valuesOf(i), { value: "", label: "" }] });
  const removeValue = (i: number, k: number) =>
    patchVariant(i, { values: valuesOf(i).filter((_, j) => j !== k) });
  const deriveValueKey = (i: number, k: number) => {
    const value = valuesOf(i)[k];
    if (!value || value.value) return;
    const taken = valuesOf(i)
      .filter((_, j) => j !== k)
      .map((v) => v.value);
    patchValue(i, k, { value: mintKey(value.label, taken, "value") });
  };

  const patchSection = (i: number, patch: Partial<KnowledgeSection>) =>
    setSections(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addSection = () => setSections([...sections, { key: "", label: "", steps: [] }]);
  const removeSection = (i: number) => setSections(sections.filter((_, j) => j !== i));
  const moveSection = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    next[i] = b;
    next[j] = a;
    setSections(next);
  };
  const deriveSectionKey = (i: number) => {
    const section = sections[i];
    if (!section || section.key) return;
    const taken = sections.filter((_, j) => j !== i).map((s) => s.key);
    patchSection(i, { key: mintKey(section.label, taken, "section") });
  };

  const patchRepeat = (i: number, patch: Partial<KnowledgeRepeat>) => {
    const repeat = sections[i]?.repeat;
    if (!repeat) return;
    patchSection(i, { repeat: { ...repeat, ...patch } });
  };
  const toggleRepeat = (i: number) => {
    const section = sections[i];
    if (!section) return;
    patchSection(i, { repeat: section.repeat ? undefined : { item: "", fields: [] } });
  };
  const addField = (i: number) => {
    const repeat = sections[i]?.repeat;
    if (!repeat) return;
    patchRepeat(i, { fields: [...repeat.fields, { key: "", label: "" }] });
  };
  const patchField = (i: number, k: number, patch: Partial<KnowledgeItemField>) => {
    const repeat = sections[i]?.repeat;
    if (!repeat) return;
    patchRepeat(i, {
      fields: repeat.fields.map((f, j) => (j === k ? { ...f, ...patch } : f)),
    });
  };
  const removeField = (i: number, k: number) => {
    const repeat = sections[i]?.repeat;
    if (!repeat) return;
    patchRepeat(i, { fields: repeat.fields.filter((_, j) => j !== k) });
  };
  const deriveFieldKey = (i: number, k: number) => {
    const repeat = sections[i]?.repeat;
    const field = repeat?.fields[k];
    if (!repeat || !field || field.key) return;
    const taken = repeat.fields.filter((_, j) => j !== k).map((f) => f.key);
    patchField(i, k, { key: mintKey(field.label, taken, "field") });
  };

  const patchStep = (i: number, k: number, patch: Partial<KnowledgeStep>) => {
    const section = sections[i];
    if (!section) return;
    patchSection(i, {
      steps: section.steps.map((s, j) => (j === k ? { ...s, ...patch } : s)),
    });
  };
  const addStep = (i: number) => {
    const section = sections[i];
    if (!section) return;
    patchSection(i, { steps: [...section.steps, { key: "", label: "" }] });
  };
  const removeStep = (i: number, k: number) => {
    const section = sections[i];
    if (!section) return;
    patchSection(i, { steps: section.steps.filter((_, j) => j !== k) });
  };
  const deriveStepKey = (i: number, k: number) => {
    const section = sections[i];
    const step = section?.steps[k];
    if (!section || !step || step.key) return;
    const taken = section.steps.filter((_, j) => j !== k).map((s) => s.key);
    patchStep(i, k, { key: mintKey(step.label, taken, "step") });
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>{t("Variants")}</h3>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={addVariant}>
            <Plus size={14} /> {t("Add variant")}
          </button>
        </div>
        <p className="hint">
          {t(
            "A workorder picks one value per variant; a section or a step shows only where the chosen value matches its condition.",
          )}
        </p>
        {variants.length === 0 ? (
          <p className="hint">{t("No variants yet.")}</p>
        ) : (
          variants.map((variant, i) => (
            <div className="field" key={variant.key || `variant-${i}`}>
              <div className="row gap-8">
                <LabelInput
                  value={variant.label}
                  placeholder={t("Variant")}
                  onChange={(value) => patchVariant(i, { label: value })}
                  onCommit={() => deriveVariantKey(i)}
                />
                <KeyHint value={variant.key} />
                <button
                  type="button"
                  className="icon-btn sm danger"
                  aria-label={t("Remove variant")}
                  title={t("Remove variant")}
                  onClick={() => removeVariant(i)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="col gap-8">
                {variant.values.map((value, k) => (
                  <div className="row gap-8" key={value.value || `value-${k}`}>
                    <LabelInput
                      value={value.label}
                      placeholder={t("Value")}
                      onChange={(label) => patchValue(i, k, { label })}
                      onCommit={() => deriveValueKey(i, k)}
                    />
                    <KeyHint value={value.value} />
                    <button
                      type="button"
                      className="icon-btn sm danger"
                      aria-label={t("Remove value")}
                      title={t("Remove value")}
                      onClick={() => removeValue(i, k)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => addValue(i)}
                >
                  <Plus size={14} /> {t("Add value")}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>{t("Sections")}</h3>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={addSection}>
            <Plus size={14} /> {t("Add section")}
          </button>
        </div>
        <p className="hint">
          {t("Sections run in order, and each holds the steps carried out inside it.")}
        </p>
        {sections.length === 0 ? (
          <p className="hint">{t("No sections yet.")}</p>
        ) : (
          sections.map((section, i) => (
            <div className="card" key={section.key || `section-${i}`}>
              <div className="card-head">
                <LabelInput
                  value={section.label}
                  placeholder={t("Section")}
                  onChange={(label) => patchSection(i, { label })}
                  onCommit={() => deriveSectionKey(i)}
                />
                <KeyHint value={section.key} />
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={t("Move up")}
                  title={t("Move up")}
                  disabled={i === 0}
                  onClick={() => moveSection(i, -1)}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={t("Move down")}
                  title={t("Move down")}
                  disabled={i === sections.length - 1}
                  onClick={() => moveSection(i, 1)}
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn sm danger"
                  aria-label={t("Remove section")}
                  title={t("Remove section")}
                  onClick={() => removeSection(i)}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <ConditionField
                condition={section.condition}
                variants={variants}
                onChange={(condition) => patchSection(i, { condition })}
              />

              <label className="row gap-8 mt-8">
                <input
                  type="checkbox"
                  className="select-all"
                  checked={Boolean(section.repeat)}
                  onChange={() => toggleRepeat(i)}
                />
                {t("Repeat for each item")}
              </label>

              {section.repeat && (
                <div className="field mt-8" style={{ marginLeft: 24 }}>
                  <input
                    className="input sm"
                    value={section.repeat.item}
                    placeholder={t("Item, e.g. Container")}
                    aria-label={t("Item")}
                    onChange={(e) => patchRepeat(i, { item: e.target.value })}
                  />
                  {section.repeat.fields.map((field, k) => (
                    <div className="row gap-8" key={field.key || `field-${k}`}>
                      <LabelInput
                        value={field.label}
                        placeholder={t("Item field")}
                        onChange={(label) => patchField(i, k, { label })}
                        onCommit={() => deriveFieldKey(i, k)}
                      />
                      <KeyHint value={field.key} />
                      <button
                        type="button"
                        className="icon-btn sm danger"
                        aria-label={t("Remove field")}
                        title={t("Remove field")}
                        onClick={() => removeField(i, k)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => addField(i)}
                  >
                    <Plus size={14} /> {t("Add field")}
                  </button>
                </div>
              )}

              <div className="row gap-8 mt-16">
                <span className="hint grow">{t("Steps")}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => addStep(i)}
                >
                  <Plus size={14} /> {t("Add step")}
                </button>
              </div>
              {section.steps.map((step, k) => (
                <div
                  className="field"
                  key={step.key || `step-${k}`}
                  style={{ marginLeft: 24, marginBottom: 8 }}
                >
                  <div className="row gap-8">
                    <LabelInput
                      value={step.label}
                      placeholder={t("Step")}
                      onChange={(label) => patchStep(i, k, { label })}
                      onCommit={() => deriveStepKey(i, k)}
                    />
                    <KeyHint value={step.key} />
                    <button
                      type="button"
                      className="icon-btn sm danger"
                      aria-label={t("Remove step")}
                      title={t("Remove step")}
                      onClick={() => removeStep(i, k)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <ConditionField
                    condition={step.condition}
                    variants={variants}
                    onChange={(condition) => patchStep(i, k, { condition })}
                  />
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}

export default function ChecklistSurface({
  checklist,
  editable,
  onChange,
}: {
  checklist: KnowledgeChecklist;
  editable: boolean;
  onChange?: (checklist: KnowledgeChecklist) => void;
}) {
  if (!editable || !onChange) return <StructuredView checklist={checklist} />;
  return <ProcessBuilder checklist={checklist} onChange={onChange} />;
}
