/**
 * One group's prose, edited from Administration (ADR 0035): the standing
 * instruction and the rules. The group is the tab the page is on.
 *
 * The editor is the administration's section now, not a dialog in the top bar:
 * a group's prose is decided by an installation administrator, and that is the
 * one place the rest of those decisions live. A rule that is already filed keeps
 * its name: renaming is a new rule and a deleted one, not a document moved under
 * a name the agent may already be carrying.
 */
import { RULE_SURFACES, RULE_VERSION, type RuleDoc } from "@gilbert/agent/rule";
import { errorMessage } from "@gilbert/shared/errors";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/jmap/client";
import {
  deleteRule,
  type GroupProse,
  readGroupProse,
  saveInstruction,
  saveRule,
} from "@/lib/agentProse";
import { t } from "@/lib/i18n";
import { confirmDialog } from "@/ui/dialog";

/** The name each surface goes by, in the order a rule's list keeps. */
const SURFACE_LABEL: Record<(typeof RULE_SURFACES)[number], string> = {
  chat: "Chat",
  mail: "Mail",
  knowledge: "KB",
  workorder: "Workorders",
  files: "Files",
};

export function GroupRules({ group }: { group: string }) {
  const [prose, setProse] = useState<GroupProse | null>(null);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    setProse(null);
    // A rule being drafted belongs to the group it was typed for.
    setAdding(false);
    try {
      const next = await readGroupProse(id);
      setProse(next);
      setInstruction(next.instruction);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(group);
  }, [group, load]);

  const saveStanding = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveInstruction(group, instruction, prose?.state);
      setSaved(true);
    } catch (err) {
      setError(await conflictOr(err, group));
    } finally {
      setBusy(false);
    }
  };

  /**
   * A write the account refused because something moved under it: say so and
   * read again, rather than showing the mail server's own sentence.
   */
  const conflictOr = async (err: unknown, id: string): Promise<string> => {
    if (!(err instanceof ApiError && err.status === 409)) return errorMessage(err);
    await load(id);
    return t(
      "Somebody else changed this group's prose. The list has been reloaded, and your edit was not saved.",
    );
  };

  /** Write one rule and reload, so the list is what the account now holds. */
  const writeRule = async (rule: RuleDoc) => {
    try {
      await saveRule(group, rule, prose?.state);
    } catch (err) {
      setError(await conflictOr(err, group));
      return;
    }
    setAdding(false);
    await load(group);
  };

  const removeRule = async (id: string) => {
    const sure = await confirmDialog({
      title: t("Delete “{title}”?", { title: id }),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!sure) return;
    try {
      await deleteRule(group, id);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    await load(group);
  };

  return (
    <div>
      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      {busy && !prose && <p className="hint">{t("Loading…")}</p>}
      {prose && (
        <>
          <section style={{ marginTop: 20 }}>
            <h2>{t("Standing instruction")}</h2>
            <p className="hint">
              {t("How the group wants its agent to work, on every call it makes.")}
            </p>
            <div className="field">
              <textarea
                rows={4}
                value={instruction}
                aria-label={t("Standing instruction")}
                onChange={(e) => {
                  setInstruction(e.target.value);
                  setSaved(false);
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={saveStanding}
              >
                {t("Save")}
              </button>
              {saved && <span className="hint">{t("Saved")}</span>}
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <h2>{t("Rules")}</h2>
            {prose.rules.length === 0 && !adding && (
              <p className="hint">{t("No rules yet.")}</p>
            )}
            <div style={{ display: "grid", gap: 12 }}>
              {prose.rules.map((rule) => (
                <RuleEditor
                  key={rule.id}
                  initial={rule}
                  onSave={writeRule}
                  onDelete={() => removeRule(rule.id)}
                />
              ))}
              {adding && (
                <RuleEditor
                  initial={{
                    v: RULE_VERSION,
                    id: "",
                    watches: ["mail"],
                    instruction: "",
                    sends: false,
                  }}
                  onSave={writeRule}
                  onCancel={() => setAdding(false)}
                />
              )}
            </div>
            {!adding && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginTop: 12 }}
                onClick={() => setAdding(true)}
              >
                {t("New rule")}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * One rule's editor: the name (only while it is new), the surfaces it watches,
 * what should happen, and whether it declares that it sends.
 */
function RuleEditor({
  initial,
  onSave,
  onDelete,
  onCancel,
}: {
  initial: RuleDoc;
  onSave(rule: RuleDoc): Promise<void>;
  onDelete?(): Promise<void>;
  onCancel?(): void;
}) {
  const existing = Boolean(onDelete);
  const [id, setId] = useState(initial.id);
  const [watches, setWatches] = useState(initial.watches);
  const [instruction, setInstruction] = useState(initial.instruction);
  const [sends, setSends] = useState(initial.sends);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (surface: (typeof RULE_SURFACES)[number]) =>
    setWatches((list) =>
      list.includes(surface) ? list.filter((s) => s !== surface) : [...list, surface],
    );

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field" style={{ border: "1px solid var(--border)", padding: 12 }}>
      {existing ? (
        <strong>{id}</strong>
      ) : (
        <div className="field">
          <label htmlFor="new-rule-id">{t("Rule name")}</label>
          <input id="new-rule-id" value={id} onChange={(e) => setId(e.target.value)} />
        </div>
      )}
      <div className="field" style={{ marginTop: 8 }}>
        <label>{t("Watches")}</label>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {RULE_SURFACES.map((surface) => (
            <label
              key={surface}
              style={{ display: "flex", gap: 4, alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={watches.includes(surface)}
                onChange={() => toggle(surface)}
              />
              {t(SURFACE_LABEL[surface])}
            </label>
          ))}
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label htmlFor={`rule-instruction-${id}`}>{t("What should happen")}</label>
        <textarea
          id={`rule-instruction-${id}`}
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </div>
      <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
        <input
          type="checkbox"
          checked={sends}
          onChange={(e) => setSends(e.target.checked)}
        />
        {t("May send")}
      </label>
      {error && (
        <div className="error-box" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await onSave({
                v: RULE_VERSION,
                id,
                watches: RULE_SURFACES.filter((s) => watches.includes(s)),
                instruction,
                sends,
              });
            })
          }
        >
          {existing ? t("Save") : t("Create")}
        </button>
        {onDelete && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => onDelete && act(onDelete)}
          >
            {t("Delete")}
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {t("Cancel")}
          </button>
        )}
      </div>
    </div>
  );
}
