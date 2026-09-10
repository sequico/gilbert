/**
 * The per-group automation authoring surface (ADR 0003 "Admin surfaces").
 *
 * The rules of a group live in the group's own account — that is why members
 * can read them — and writing them carries ADR 0006's membership rule: an
 * admin who is not a member of the group has no act-as-the-group path, so the
 * surface says which membership it needs instead of failing at the door.
 *
 * The grant itself is never written here. Membership of the agent is granted in
 * Stalwart's own administration; this surface verifies it and, when it is
 * missing, says what that costs.
 */
import { type AgentRule, ruleProblem } from "@gilbert/agent/documents";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import {
  actionText,
  areaText,
  reviewText,
  ruleActions,
  tierText,
  triggerText,
} from "@/views/agent/agentText";
import { RuleForm } from "./RuleForm";

export function RuleEditor({
  groups,
}: {
  groups: ReadonlyArray<{ name: string; granted: boolean }>;
}) {
  const groupViews = useAgents((s) => s.groupViews);
  const loading = useAgents((s) => s.loading);
  const loadGroup = useAgents((s) => s.loadGroup);
  const saveRules = useAgents((s) => s.saveRules);
  const [group, setGroup] = useState<string | null>(null);
  /** The rule being edited; null means the list is showing. */
  const [draft, setDraft] = useState<AgentRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const view = group ? groupViews[group.trim().toLowerCase()] : undefined;
  const granted = groups.find((g) => g.name === group)?.granted === true;
  const rules = view?.granted ? view.rules : [];
  // Why the document would be refused as it stands, if it would: the server's
  // own reason, so the form cannot drift from what the executor accepts
  // (ADR 0003 §4, `ruleProblem`).
  const draftProblem = draft ? problemOf(draft) : null;

  const pick = (name: string) => {
    setGroup(name);
    setDraft(null);
    setProblem(null);
    // The rules are a document in the group's own account; reading them is a
    // session on that account, which is exactly what the grant is.
    void loadGroup(name);
  };

  const save = async () => {
    if (!group || !draft) return;
    const name = draft.name.trim();
    if (!name) {
      setProblem(t("Give the automation a name before saving it."));
      return;
    }
    const refused = problemOf(draft);
    if (refused) {
      setProblem(
        t("This automation cannot run as it stands: {reason}", { reason: refused }),
      );
      return;
    }
    const existing = rules.find((r) => r.id === draft.id);
    // `version` and the stamps belong to the server, which returns the saved
    // document; the surface therefore sends what it authored and keeps what
    // comes back.
    const next: AgentRule = { ...draft, name };
    setBusy(true);
    setProblem(null);
    try {
      // The store rejects with the server's reason when the save is refused,
      // and keeps the saved document — with the version the server stamped —
      // for the surface to show.
      await saveRules(
        group,
        existing ? rules.map((r) => (r.id === next.id ? next : r)) : [...rules, next],
      );
      setDraft(null);
      toast.success(t("Automation saved"));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rule: AgentRule) => {
    if (!group) return;
    const ok = await confirmDialog({
      title: t("Delete “{name}”?", { name: rule.name || t("Untitled automation") }),
      message: t(
        "The automation document is removed from the group's own files. A job already running keeps the version it started on.",
      ),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setProblem(null);
    try {
      await saveRules(
        group,
        rules.filter((r) => r.id !== rule.id),
      );
      setDraft(null);
      toast.success(t("Automation deleted"));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>{t("Automations")}</h2>
      <p className="lead">
        {t(
          "What the agent does in a group, as a form: when it reacts, which messages it looks at, and what it then does. The automation is stored in the group's own account, so every member can read it.",
        )}
      </p>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "Authoring a group's automations needs membership of that group: they live in the group's own files, and the mail server refuses to act as a group mailbox on an administrator's behalf.",
        )}
      </p>
      <div className="field" style={{ maxWidth: 380 }}>
        <label htmlFor="agent-rule-group">{t("Group mailbox")}</label>
        <select
          id="agent-rule-group"
          className="select"
          value={group ?? ""}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value) pick(e.target.value);
          }}
        >
          <option value="">{t("Choose a group…")}</option>
          {groups.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name}
            </option>
          ))}
        </select>
      </div>

      {group && !granted && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "The agent is not granted on this group, so there is nothing to author here: no automation runs, and nobody can mention it in the group's chat. Grant it on this group in Stalwart's own administration, then come back — this surface checks the grant, it never writes it.",
          )}
        </div>
      )}

      {group && granted && (
        <>
          {!view && (
            <p className="hint">
              {loading
                ? t("Loading…")
                : t("This group's automation document could not be read.")}
            </p>
          )}
          {view && !view.granted && (
            <div className="warn-box" style={{ marginBottom: 12 }}>
              {view.reason}
            </div>
          )}
          {view?.granted && draft ? (
            <>
              <RuleForm rule={draft} onChange={setDraft} />
              {problem && (
                <div className="warn-box" style={{ marginBottom: 12 }}>
                  {problem}
                </div>
              )}
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary"
                  disabled={busy || draftProblem !== null}
                  onClick={() => void save()}
                >
                  {busy ? t("Saving…") : t("Save")}
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setProblem(null);
                  }}
                >
                  {t("Cancel")}
                </button>
              </div>
              {draftProblem !== null && (
                <p className="hint" style={{ marginTop: 8 }}>
                  {t("Cannot be saved yet: {reason}", { reason: draftProblem })}
                </p>
              )}
            </>
          ) : view?.granted ? (
            <>
              {rules.length === 0 ? (
                <p className="hint">{t("No automation in this group yet.")}</p>
              ) : (
                rules.map((rule) => (
                  <RuleItem
                    key={rule.id}
                    rule={rule}
                    busy={busy}
                    onEdit={() => {
                      setProblem(null);
                      setDraft(rule);
                    }}
                    onDelete={() => void remove(rule)}
                  />
                ))
              )}
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setProblem(null);
                  setDraft(blankRule());
                }}
              >
                <Plus size={16} /> {t("New automation")}
              </button>
            </>
          ) : null}
        </>
      )}
      {problem && !draft && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {problem}
        </div>
      )}
    </section>
  );
}

/**
 * What the form still owes before the document is valid: the server's own
 * reason first, then the one thing a form can leave blank that the document
 * validator refuses — a T1 category the classifier could never return.
 */
function problemOf(rule: AgentRule): string | null {
  const refused = ruleProblem(rule);
  if (refused) return refused;
  if (rule.tier === "T1" && (rule.categories ?? []).some((c) => !c.name.trim())) {
    return "a T1 category needs a name for the classifier to return";
  }
  return null;
}

/** One automation, as the admin reads it before opening the form. */
function RuleItem({
  rule,
  busy,
  onEdit,
  onDelete,
}: {
  rule: AgentRule;
  busy: boolean;
  onEdit(): void;
  onDelete(): void;
}) {
  const actions = ruleActions(rule);
  return (
    <div className="card agent-rule-item">
      <div className="card-head">
        <h3>{rule.name || t("Untitled automation")}</h3>
        {rule.enabled ? (
          <span className="agent-state ok">{t("Enabled")}</span>
        ) : (
          <span className="agent-state off">{t("Disabled")}</span>
        )}
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onEdit}>
          {t("Edit")}
        </button>
        <button
          className="icon-btn sm danger"
          aria-label={t("Delete automation")}
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <p className="hint">
        {areaText(rule.area)} · {tierText(rule.tier)} · {triggerText(rule.trigger)}
      </p>
      <p className="hint">{reviewText(rule.review)}</p>
      {actions.length > 0 && (
        <p className="hint">{actions.map((a) => actionText(a)).join(" · ")}</p>
      )}
    </div>
  );
}

/**
 * A new automation starts the way resolution 10 describes one — a confidence
 * threshold, disabled until the admin has finished describing it — on mail
 * events, in the mail area, at the tier that calls no model at all.
 */
function blankRule(): AgentRule {
  return {
    v: 1,
    id: `rule-${crypto.randomUUID()}`,
    version: 1,
    name: "",
    enabled: false,
    area: "mail",
    trigger: { on: "email" },
    tier: "T0",
    review: { mode: "threshold", threshold: 0.7 },
    actions: [],
    capabilities: [],
  };
}
