/**
 * The per-group automation authoring surface (ADR 0003, ADR 0006).
 *
 * The automations of a group live in the group's own account — that is why
 * members can read them — and writing them carries ADR 0005's membership rule:
 * an admin who is not a member of the group has no act-as-the-group path, so the
 * surface says which membership it needs instead of failing at the door.
 *
 * The grant itself is never written here. Membership of the agent is granted in
 * Stalwart's own administration; this surface verifies it and, when it is
 * missing, says what that costs.
 *
 * The group is handed in rather than picked here: the section this editor lives
 * in owns one pick for all of its tabs, and a second picker inside a tab was a
 * second answer to the same question.
 *
 * **One automation per trigger** is enforced here as it is on the server
 * (`rulesProblem`), and for the same reason: an automation carries no filter,
 * so the executor runs every enabled automation on a trigger against every item
 * that trigger produces. A second one would answer the same arrival twice. The
 * editor therefore does not offer a trigger that is already taken, and spells
 * out the pair when a group already carries one.
 */
import {
  AGENT_TRIGGERS,
  type AgentJob,
  type AgentRule,
  type AgentTriggerOn,
  ruleProblems,
  rulesProblem,
} from "@gilbert/agent/documents";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { runAgentRule } from "@/lib/agents";
import { formatListDate, uid } from "@/lib/format";
import { groupAccessSentence } from "@/lib/groupAccess";
import { t } from "@/lib/i18n";
import { agentViewKey, groupOperation, useAgents } from "@/store/agents";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import {
  automationText,
  jobStateText,
  meterText,
  ruleInstruction,
  triggerText,
} from "@/views/agent/agentText";
import { blankRule, RuleForm } from "./RuleForm";

export function RuleEditor({
  groups,
  group,
}: {
  groups: readonly string[];
  group: string;
}) {
  const groupViews = useAgents((s) => s.groupViews);
  const busyReads = useAgents((s) => s.busy);
  const loadGroup = useAgents((s) => s.loadGroup);
  const grant = useAgents((s) => s.grant);
  const loadGrant = useAgents((s) => s.loadGrant);
  const saveRules = useAgents((s) => s.saveRules);
  // This group's own line, not a global one: a provider read in another panel
  // must not turn this panel's read failure into "Loading…".
  const loading = group ? busyReads[groupOperation(group)] === true : false;
  /** The rule being edited; null means the list is showing. */
  const [draft, setDraft] = useState<AgentRule | null>(null);
  /** What it held when it was opened: the line "changed" is measured from. */
  const [baseline, setBaseline] = useState<AgentRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The rule being asked for right now, and the one whose ask just landed: two
  // facts about one ask, and the surface says both rather than leaving a press
  // with nothing to show for it.
  const [asking, setAsking] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);

  const view = group ? groupViews[agentViewKey(group)] : undefined;
  const known = group !== "" && groups.includes(group);
  const rules = view?.granted ? view.rules : [];
  /** The runs of this group that are still open, by the rule that asked for them. */
  const openJobs: readonly AgentJob[] = view?.jobs ?? [];
  /** A scheduled rule's next due instant, read from the group's own scheduler document. */
  const schedule = view?.granted ? view.schedule : [];
  // Why the document would be refused as it stands, if it would: the server's
  // own reason, so the form cannot drift from what the executor accepts
  // (ADR 0003, `ruleProblem`).
  const draftProblem = draft ? problemOf(draft) : null;
  // Saving a rule that is identical to the one it was opened from writes back
  // what is already stored, which is not something to offer: a new automation
  // has no baseline and is always something to save, an edited one is compared
  // with the copy it started from.
  const changed = draft !== null && draft !== baseline;
  /** The triggers this group's enabled automations already hold. */
  const taken = new Set<AgentTriggerOn>(
    rules.filter((rule) => rule.enabled).map((rule) => rule.trigger.on),
  );
  /** The pair already sharing a trigger, when the group carries one. */
  const doubled = rulesProblem(rules);
  const freeTriggers = AGENT_TRIGGERS.filter((on) => !taken.has(on));

  // The grant catalogue is the server's, published with the rule schema: the
  // form builds its allowlist from it rather than from a list of its own.
  useEffect(() => {
    void loadGrant();
  }, [loadGrant]);

  /*
   * The rules are a document in the group's own account; reading them is a
   * session on that account, which is exactly what the grant is. The group is
   * the section's own pick, so the read follows it — and a draft belongs to the
   * group it was opened in, so switching drops it rather than carrying one
   * group's automation into another's document.
   */
  useEffect(() => {
    setDraft(null);
    setBaseline(null);
    setProblem(null);
    setAsked(null);
    setAsking(null);
    if (group) void loadGroup(group);
  }, [group, loadGroup]);

  /**
   * Ask for one automation, now.
   *
   * What comes back is a job in the group's own account, which the agent that
   * holds the group picks up: nothing runs in this process, and the terms are
   * the rule's own — its grant and the group's policy still decide, and a run
   * the policy pauses still waits for a person. So the ask is marked rather than
   * awaited, and the read follows it: a run already taken up reads as open, and
   * one already finished leaves the group's audit as its record.
   */
  const ask = async (rule: AgentRule) => {
    if (!group) return;
    setAsking(rule.id);
    setAsked(null);
    setProblem(null);
    try {
      await runAgentRule(group, { ruleId: rule.id });
      setAsked(rule.id);
      void loadGroup(group);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(null);
    }
  };

  const save = async () => {
    if (!group || !draft) return;
    const refused = problemOf(draft);
    if (refused) {
      setProblem(
        t("This automation cannot run as it stands: {reason}", { reason: refused }),
      );
      return;
    }
    const existing = rules.find((r) => r.id === draft.id);
    const next: AgentRule = draft;
    const sending = existing
      ? rules.map((r) => (r.id === next.id ? next : r))
      : [...rules, next];
    // The server validates every document in the list it is handed, so one
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
      title: t("Delete the {name}?", { name: automationText(rule) }),
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
          "What the agent does in a group: when it reacts, and what it is asked to do about what it finds. The automation is stored in the group's own account, so every member can read it.",
        )}
      </p>
      <p className="hint" style={{ marginBottom: 12 }}>
        {groupAccessSentence("automations")}
      </p>
      {/* What this group's runs have cost, read from the same trail the panel
          below shows: the counts ride the entries, so the two cannot disagree
          (ADR 0003). */}
      {view?.granted && (
        <p className="hint" style={{ marginBottom: 12 }}>
          {meterText(view.meter)}
        </p>
      )}
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "One automation per trigger: the agent runs every enabled automation on a trigger against everything that trigger produces, so a second one on the same trigger answers the same event twice. The branching between one case and another belongs in the instruction.",
        )}
      </p>

      {group && !known && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "The agent is not in this group, so there is nothing to author here: no automation runs, and nobody can mention it in the group's chat. Give it the group in Stalwart's own administration, then come back.",
          )}
        </div>
      )}

      {doubled && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "This group carries more than one enabled automation on a trigger, which this build does not accept: {reason}",
            { reason: doubled },
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
              <RuleForm
                rule={draft}
                group={group}
                grant={grant}
                taken={taken}
                onChange={setDraft}
              />
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
                    run={
                      asking === rule.id ? "asking" : asked === rule.id ? "asked" : "idle"
                    }
                    openJob={openJobs.find((job) => job.ruleId === rule.id)}
                    nextDue={schedule.find((s) => s.ruleId === rule.id)?.at}
                    onRun={() => void ask(rule)}
                    onEdit={() => {
                      setProblem(null);
                      setDraft(rule);
                      setBaseline(rule);
                    }}
                    onDelete={() => void remove(rule)}
                  />
                ))
              )}
              {/*
               * A new automation starts on a trigger nothing holds: the four
               * are the whole of what an automation can stand on, and offering
               * one that is taken would be offering a save the server refuses.
               */}
              <button
                className="btn"
                disabled={busy || freeTriggers.length === 0}
                title={
                  freeTriggers.length === 0
                    ? t("Every trigger already has an automation in this group.")
                    : undefined
                }
                onClick={() => {
                  setProblem(null);
                  /*
                   * A new automation gets its id here rather than in the form:
                   * the form edits a document, and an id is what the group's
                   * document list names it by.
                   *
                   * `uid` and not `crypto.randomUUID`: the latter exists only in
                   * a secure context, and the administration is reachable over
                   * plain http too (by server IP, which is the whole point of it
                   * being reachable at all when DNS does not answer). There, the
                   * call throws inside the click handler, React tears the panel
                   * down and the button appears to do nothing at all — a dead
                   * button with no message. `uid` is the client's own minting
                   * (a prefix, some randomness and the clock), which is what this
                   * name is: minted by the client and shown to nobody.
                   */
                  setDraft(blankRule(uid("rule-"), freeTriggers[0]));
                  setBaseline(null);
                }}
              >
                <Plus size={16} /> {t("New automation")}
              </button>
              {freeTriggers.length === 0 && (
                <p className="hint" style={{ marginTop: 8 }}>
                  {t(
                    "Every trigger already has an automation in this group. Delete or disable one to write another kind.",
                  )}
                </p>
              )}
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
 * document in it — including the one-enabled-automation-per-trigger rule — so
 * one refusal makes saving and deleting fail alike. Naming it is what turns
 * that refusal into something a person can act on, and the name is the trigger
 * the automation stands on, which is what tells them which one to change.
 */
function listProblem(rules: AgentRule[]): string | null {
  for (const rule of rules) {
    const owed = problemOf(rule);
    if (owed)
      return t("The {name} cannot be saved as it stands: {reason}", {
        name: automationText(rule),
        reason: owed,
      });
  }
  return rulesProblem(rules);
}

/** One automation, as the admin reads it before opening the form. */
function RuleItem({
  rule,
  busy,
  run,
  openJob,
  nextDue,
  onRun,
  onEdit,
  onDelete,
}: {
  rule: AgentRule;
  busy: boolean;
  /** Whether this rule is being asked for right now, or was just asked for. */
  run: "idle" | "asking" | "asked";
  /** The run of this rule that is still open, if one is. */
  openJob: AgentJob | undefined;
  /** This rule's next due instant, for a schedule trigger, when one is armed. */
  nextDue: string | undefined;
  onRun(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const instruction = ruleInstruction(rule);
  return (
    <div className="card agent-rule-item">
      <div className="card-head">
        <h3>{automationText(rule)}</h3>
        {rule.enabled ? (
          <span className="agent-state ok">{t("Enabled")}</span>
        ) : (
          <span className="agent-state off">{t("Disabled")}</span>
        )}
        {/* The person-shaped door into an automation about mail: the agent
            that holds this group runs it on its next pass, on the terms the
            rule already carries. */}
        <button
          className="btn btn-sm btn-ghost"
          disabled={busy || run === "asking"}
          onClick={onRun}
          title={t("Run this automation now, on the newest message in the group's inbox")}
        >
          {run === "asking" ? t("Asking…") : t("Run now")}
        </button>
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
      <p className="hint">{triggerText(rule.trigger)}</p>
      {rule.trigger.on === "schedule" && (
        <p className="hint">
          {nextDue
            ? t("Next due: {when}", { when: formatListDate(nextDue) })
            : rule.enabled
              ? t(
                  "Not yet scheduled — the agent holding this group arms it on its next pass.",
                )
              : t("Not scheduled while disabled.")}
        </p>
      )}
      {instruction && <p className="agent-readonly-text">{instruction}</p>}
      {/* What became of an ask: the run while it is open, and where its outcome
          is read once it is not — the group's chat hears from the agent, and
          the audit keeps the line. */}
      {openJob ? (
        <p className="hint">
          {t("Asked for: a run is open ({state}).", {
            state: jobStateText(openJob.state),
          })}
        </p>
      ) : run === "asked" ? (
        <p className="hint">
          {t(
            "Asked for. The agent holding this group picks it up on its next pass — a minute by default — and the group's audit is where what it did is read.",
          )}
        </p>
      ) : null}
    </div>
  );
}
