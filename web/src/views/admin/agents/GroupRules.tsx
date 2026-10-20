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
import {
  RULE_SURFACES,
  RULE_VERSION,
  type RuleDoc,
  type RuleSurfaces,
  type SurfaceMode,
} from "@gilbert/agent/rule";
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

/** The name each surface goes by, in the order a rule's matrix keeps. */
const SURFACE_LABEL: Record<(typeof RULE_SURFACES)[number], string> = {
  chat: "Chat",
  mail: "Mail",
  knowledge: "KB",
  workorder: "Workorders",
  files: "Files",
  calendar: "Calendar",
};

/** The three modes, and the sentence each stands for (ADR 0035). */
const MODES: readonly SurfaceMode[] = ["off", "watch", "ondemand"];

/** The word a mode goes by, translated where it is drawn. */
function modeLabel(mode: SurfaceMode): string {
  if (mode === "off") return t("Off");
  if (mode === "watch") return t("Watch");
  return t("On demand");
}

/** The matrix a new rule starts from: mail and chat wake it, files are on demand. */
const NEW_RULE_SURFACES: RuleSurfaces = {
  chat: "watch",
  mail: "watch",
  files: "ondemand",
  knowledge: "off",
  workorder: "off",
  calendar: "off",
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
  const writeRule = async (rule: RuleDoc, create: boolean) => {
    try {
      await saveRule(group, rule, prose?.state, { create });
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
      // The list's own state, so a rule somebody corrected in between is not
      // removed by a decision taken against the old list.
      await deleteRule(group, id, prose?.state);
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
                    surfaces: { ...NEW_RULE_SURFACES },
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

/** The document's name for a rule, from the name a person typed. */
function ruleIdFrom(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/-{2,}/g, "-");
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
  onSave(rule: RuleDoc, create: boolean): Promise<void>;
  onDelete?(): Promise<void>;
  onCancel?(): void;
}) {
  const existing = Boolean(onDelete);
  const [id, setId] = useState(initial.id);
  const [surfaces, setSurfaces] = useState<RuleSurfaces>(initial.surfaces);
  const [instruction, setInstruction] = useState(initial.instruction);
  const [sends, setSends] = useState(initial.sends);
  /*
   * The name is a person's; the id is the document's file name, derived from it
   * so a space or an accent is never something the reader has to work around.
   */
  const ruleId = existing ? id : ruleIdFrom(id);
  /** A name with a letter or a digit in it can become a rule. */
  const validId = ruleId.length > 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setMode = (
    surface: Exclude<(typeof RULE_SURFACES)[number], "chat">,
    mode: SurfaceMode,
  ) => {
    setSurfaces((held) => ({ ...held, [surface]: mode }));
  };

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
          <input
            id="new-rule-id"
            value={id}
            placeholder={t("All freight")}
            onChange={(e) => setId(e.target.value)}
          />
          {validId && ruleId !== id && (
            <span className="hint">{t("Saved as {id}", { id: ruleId })}</span>
          )}
        </div>
      )}
      <div className="field" style={{ marginTop: 8 }}>
        <label>{t("Surfaces")}</label>
        <p className="hint">
          {t(
            "Watch wakes the rule; On demand acts only when a run is already open; Off is none of its business.",
          )}
        </p>
        <div style={{ display: "grid", gap: 6 }}>
          {RULE_SURFACES.map((surface) => (
            <div key={surface} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ minWidth: 90 }}>{t(SURFACE_LABEL[surface])}</span>
              {surface === "chat" ? (
                <span className="hint">{t("Chat is always watched")}</span>
              ) : (
                <select
                  value={surfaces[surface]}
                  aria-label={t(SURFACE_LABEL[surface])}
                  onChange={(e) => setMode(surface, e.target.value as SurfaceMode)}
                >
                  {MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {modeLabel(mode)}
                    </option>
                  ))}
                </select>
              )}
            </div>
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
          disabled={busy || !validId}
          onClick={() =>
            act(async () => {
              await onSave(
                {
                  v: RULE_VERSION,
                  id: ruleId,
                  surfaces,
                  instruction,
                  sends,
                },
                !existing,
              );
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
