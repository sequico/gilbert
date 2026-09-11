/**
 * The per-group automation authoring surface (ADR 0003 "Admin surfaces").
 *
 * The rules of a group live in the group's own account — that is why members
 * can read them — and writing them carries ADR 0005's membership rule: an
 * admin who is not a member of the group has no act-as-the-group path, so the
 * surface says which membership it needs instead of failing at the door.
 *
 * The grant itself is never written here. Membership of the agent is granted in
 * Stalwart's own administration; this surface verifies it and, when it is
 * missing, says what that costs.
 */
import { type AgentRule, ruleProblems } from "@gilbert/agent/documents";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { groupAccessSentence } from "@/lib/groupAccess";
import { t } from "@/lib/i18n";
import { agentViewKey, groupOperation, useAgents } from "@/store/agents";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import {
  actionText,
  reviewText,
  ruleActions,
  tierText,
  triggerText,
} from "@/views/agent/agentText";
import { RuleForm } from "./RuleForm";

export function RuleEditor({ groups }: { groups: readonly string[] }) {
  const groupViews = useAgents((s) => s.groupViews);
  const busyReads = useAgents((s) => s.busy);
  const loadGroup = useAgents((s) => s.loadGroup);
  const saveRules = useAgents((s) => s.saveRules);
  const [group, setGroup] = useState<string | null>(null);
  // This group's own line, not a global one: a provider read in another panel
  // must not turn this panel's read failure into "Loading…".
  const loading = group ? busyReads[groupOperation(group)] === true : false;
  /** The rule being edited; null means the list is showing. */
  const [draft, setDraft] = useState<AgentRule | null>(null);
  /** What it held when it was opened: the line "changed" is measured from. */
  const [baseline, setBaseline] = useState<AgentRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const view = group ? groupViews[agentViewKey(group)] : undefined;
  const known = group !== null && groups.includes(group);
  const rules = view?.granted ? view.rules : [];
  // Why the document would be refused as it stands, if it would: the server's
  // own reason, so the form cannot drift from what the executor accepts
  // (ADR 0003 §4, `ruleProblem`).
  const draftProblem = draft ? problemOf(draft) : null;
  // Saving a rule that is identical to the one it was opened from writes back
  // what is already stored, which is not something to offer: a new automation
  // has no baseline and is always something to save, an edited one is compared
  // with the copy it started from.
  const changed = draft !== null && draft !== baseline;

  const pick = (name: string) => {
    setGroup(name);
    setDraft(null);
    setBaseline(null);
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
    const owed = problemOf(next);
    if (owed) {
      // Caught here rather than at the server: the schema is the same one the
      // server enforces, so the round trip would only repeat this answer.
      setProblem(owed);
      return;
    }
    const sending = existing
      ? rules.map((r) => (r.id === next.id ? next : r))
      : [...rules, next];
    // The server validates every document in the list it is handed, so an
    // automation that cannot run anywhere in it refuses this save as well.
    const neighbour = listProblem(sending);
    if (neighbour) {
      setProblem(neighbour);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      // The store rejects with the server's reason when the save is refused,
      // and keeps the saved document — with the version the server stamped —
      // for the surface to show.
      await saveRules(group, sending);
      setDraft(null);
      setBaseline(null);
      toast.success(t("Automation saved"));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rule: AgentRule) => {
    if (!group) return;
    const sending = rules.filter((r) => r.id !== rule.id);
    // The same check the form makes, over the whole list this delete sends: one
    // automation that cannot run anywhere in the group refuses every write of
    // it, so a delete would fail with a server error that names nothing.
    const refused = listProblem(sending);
    if (refused) {
      setProblem(refused);
      return;
    }
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
      await saveRules(group, sending);
      setDraft(null);
      setBaseline(null);
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
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "Two automations that write to the same message have no order between them — not even inside one kind of work — so write each one to hold whatever order it gets. The audit names the rule and its version per run, so the order they actually took can be read back afterwards.",
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
          {groups.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {group && !known && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "The agent is not in this group, so there is nothing to author here: no automation runs, and nobody can mention it in the group's chat. Give it the group in Stalwart's own administration, then come back.",
          )}
        </div>
      )}

      {group && known && (
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
              {view.need && groupAccessSentence(view.need)}
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
                  disabled={busy || draftProblem !== null || !changed}
                  onClick={() => void save()}
                >
                  {busy ? t("Saving…") : t("Save")}
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setBaseline(null);
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
                      setBaseline(rule);
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
                  setBaseline(null);
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
 * What the form still owes before the document is valid.
 *
 * The same check the server runs on save — the published schema plus the
 * cross-field rules — so the editor refuses in the same words the server
 * would, and a rule that passes here does not come back rejected.
 */
function problemOf(rule: AgentRule): string | null {
  const refused = ruleProblems(rule);
  return refused.length ? refused.join("; ") : null;
}

/**
 * Why a whole list of automations would be refused, naming the one at fault.
 *
 * Every write hands the server the complete list, and it validates every
 * document in it, so one automation that cannot run makes saving and deleting
 * fail alike. Naming it is what turns that refusal into something a person can
 * act on — and the check is the server's own, so it is answered here instead of
 * by a round trip that says no more.
 */
function listProblem(rules: AgentRule[]): string | null {
  for (const rule of rules) {
    const owed = problemOf(rule);
    if (owed)
      return t("“{name}” cannot be saved as it stands: {reason}", {
        name: rule.name || t("Untitled automation"),
        reason: owed,
      });
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
        {tierText(rule.tier)} · {triggerText(rule.trigger)}
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
 * events, at the tier that calls no model at all.
 */
function blankRule(): AgentRule {
  return {
    v: 1,
    id: `rule-${crypto.randomUUID()}`,
    version: 1,
    name: "",
    enabled: false,
    trigger: { on: "email" },
    tier: "T0",
    review: { mode: "threshold", threshold: 0.7 },
    actions: [],
    capabilities: [],
  };
}
