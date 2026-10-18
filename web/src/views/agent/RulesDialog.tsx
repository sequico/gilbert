/**
 * A group's prose, edited (ADR 0035): the standing instruction and the rules.
 *
 * A member writes both with the group's session, so the panel asks the mail
 * server directly (`@/lib/agentProse`) — there is no route, because there is no
 * Master privilege in play: the group's account is one the member already holds.
 * The standing instruction is one field; a rule is its name, the surfaces it
 * watches, and what should happen, which is also one field. A rule that is
 * already filed keeps its name: renaming is a new rule and a deleted one, not a
 * document moved under a name the agent may already be carrying.
 */
import { RULE_SURFACES, RULE_VERSION, type RuleDoc } from "@gilbert/agent/rule";
import { errorMessage } from "@gilbert/shared/errors";
import { useCallback, useEffect, useState } from "react";
import {
  deleteRule,
  type GroupProse,
  readGroupProse,
  saveInstruction,
  saveRule,
} from "@/lib/agentProse";
import { isStateMismatch } from "@/lib/appFolder";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { confirmDialog, Dialog } from "@/ui/dialog";

/** The name each surface goes by, in the order a rule's list keeps. */
const SURFACE_LABEL: Record<(typeof RULE_SURFACES)[number], string> = {
  chat: "Chat",
  mail: "Mail",
  knowledge: "KB",
  workorder: "Workorders",
  files: "Files",
};

export function RulesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups = groupMailboxAccounts(useMail((s) => s.mailAccounts));
  const [accountId, setAccountId] = useState(groups[0]?.accountId ?? "");
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
    if (open && accountId) void load(accountId);
  }, [open, accountId, load]);

  const saveStanding = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveInstruction(accountId, instruction, prose?.state);
      setSaved(true);
    } catch (err) {
      setError(await conflictOr(err, accountId));
    } finally {
      setBusy(false);
    }
  };

  /**
   * A write the account refused because something moved under it: say so and
   * read again, rather than showing the mail server's own sentence.
   */
  const conflictOr = async (err: unknown, id: string): Promise<string> => {
    if (!isStateMismatch(err)) return errorMessage(err);
    await load(id);
    return t(
      "Somebody else changed this group's prose. The list has been reloaded, and your edit was not saved.",
    );
  };

  /** Write one rule and reload, so the list is what the account now holds. */
  const writeRule = async (rule: RuleDoc) => {
    try {
      await saveRule(accountId, rule, prose?.state);
    } catch (err) {
      setError(await conflictOr(err, accountId));
      return;
    }
    setAdding(false);
    await load(accountId);
  };

  const removeRule = async (id: string) => {
    const sure = await confirmDialog({
      title: t("Delete “{title}”?", { title: id }),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!sure) return;
    try {
      await deleteRule(accountId, id);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    await load(accountId);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("Rules")} size="lg">
      <div className="field" style={{ maxWidth: "28rem" }}>
        <label htmlFor="rules-group">{t("Group")}</label>
        <select
          id="rules-group"
          className="select"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {groups.map((g) => (
            <option key={g.accountId} value={g.accountId}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
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
            {prose.unreadable.length > 0 && (
              <div className="error-box" style={{ marginTop: 12 }}>
                <strong>{t("Unreadable documents")}</strong>
                {prose.unreadable.map((item) => (
                  <div key={item.name}>
                    {item.name}: {item.problem}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </Dialog>
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
