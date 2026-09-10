/**
 * The group's agent, as a member sees it (ADR 0003 "Members see, never change").
 *
 * Next to the group chat, this panel answers the three questions a member has:
 * which agent is active here (its address), what instructions it carries (the
 * group's rule documents), and what it has done (the audit, and the jobs still
 * open).
 *
 * It is read-only by construction. The group's own `gilbert/` folder is
 * writable by a member by construction — that is how the chat works — so this
 * is a UI convention and an accepted trust inside the group, not a server ACL.
 * Authoring and configuration stay in the administration, and the member's two
 * actions are approving an action and addressing the agent, both in the chat.
 */
import { AGENT_JOB_OPEN_STATES, type AgentRule } from "@gilbert/agent/documents";
import { Bot, X } from "lucide-react";
import { useEffect } from "react";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { agentViewKey, useAgents } from "@/store/agents";
import {
  actionText,
  areaText,
  jobStateText,
  outcomeText,
  reviewText,
  ruleActions,
  tierText,
  triggerText,
} from "@/views/agent/agentText";

export function GroupAgentPanel({
  name,
  onClose,
}: {
  /** The group's address, which is how its documents are reached. */
  name: string;
  onClose(): void;
}) {
  const groupViews = useAgents((s) => s.groupViews);
  const loading = useAgents((s) => s.loading);
  const error = useAgents((s) => s.error);
  const loadGroup = useAgents((s) => s.loadGroup);

  // The store holds one entry per group, under `agentViewKey(name)`.
  const view = groupViews[agentViewKey(name)];

  useEffect(() => {
    // Only when there is nothing to show: the chat panel loads the group's view
    // for the mention picker already, and this is the retry after it failed.
    if (!view) void loadGroup(name);
  }, [name, loadGroup, view]);

  // Newest first, and bounded: the audit is one document per month per group,
  // and a panel is not the place to read a year of it.
  const recentAudit = view?.granted
    ? [...view.audit].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12)
    : [];
  const openJobs = view?.granted
    ? view.jobs.filter((j) => AGENT_JOB_OPEN_STATES.includes(j.state))
    : [];

  return (
    <div className="chat-agent" role="region" aria-label={t("The group's agent")}>
      <div className="chat-agent-head">
        <span className="chat-agent-title">
          <Bot size={14} /> {t("The group's agent")}
        </span>
        <button
          type="button"
          className="icon-btn xs"
          aria-label={t("Close")}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      {!view ? (
        <p className="hint">
          {loading
            ? t("Loading…")
            : (error ?? t("No agent is registered for this installation."))}
        </p>
      ) : !view.granted ? (
        <p className="hint">
          {t(
            "No agent works in this group: it has not been granted here, so it carries no instructions and does nothing. That grant happens in the mail server's own administration, not in the product.",
          )}{" "}
          {view.reason}
        </p>
      ) : (
        <>
          <p className="hint">
            {t(
              "Active in this group as {address}. Read-only: what it follows is authored in the administration, and you answer it in this chat.",
              { address: view.agentAddress ?? view.group },
            )}
          </p>
          <h4>{t("What it follows")}</h4>
          {view.rules.length === 0 ? (
            <p className="hint">{t("No automation is set up for this group.")}</p>
          ) : (
            view.rules.map((rule) => <RuleFacts key={rule.id} rule={rule} />)
          )}
          <h4>{t("Still open")}</h4>
          {openJobs.length === 0 ? (
            <p className="hint">{t("Nothing is running and nothing is waiting.")}</p>
          ) : (
            <>
              {openJobs.map((job) => (
                <p className="hint" key={job.id}>
                  {jobStateText(job.state)} · {formatListDate(job.trigger.at)}
                  {job.proposal && <> · {job.proposal.summary}</>}
                </p>
              ))}
              <p className="hint">
                {t(
                  "When one of these waits for a person, the agent asks here in the chat — that is where you answer.",
                )}
              </p>
            </>
          )}
          <h4>{t("What it has done")}</h4>
          {recentAudit.length === 0 ? (
            <p className="hint">{t("It has not done anything yet.")}</p>
          ) : (
            recentAudit.map((entry, i) => (
              <p className="hint" key={`${entry.jobId}-${i}`}>
                {outcomeText(entry.outcome)} · {formatListDate(entry.at)}
                {entry.by && <> · {entry.by}</>}
                {entry.detail && <> · {entry.detail}</>}
              </p>
            ))
          )}
        </>
      )}
    </div>
  );
}

/** One automation as a member reads it: what wakes it, and what it then does. */
function RuleFacts({ rule }: { rule: AgentRule }) {
  const actions = ruleActions(rule);
  return (
    <div className="chat-agent-rule">
      <div className="agent-rule-head">
        <b>{rule.name || t("Untitled automation")}</b>
        {!rule.enabled && <span className="agent-state off">{t("Disabled")}</span>}
      </div>
      <p className="hint">
        {areaText(rule.area)} · {tierText(rule.tier)}
      </p>
      <p className="hint">{triggerText(rule.trigger)}</p>
      <p className="hint">{reviewText(rule.review)}</p>
      {rule.tier === "T2" && rule.instruction && (
        <p className="agent-readonly-text">{rule.instruction}</p>
      )}
      {rule.tier === "T1" &&
        (rule.categories ?? []).map((category, i) => (
          <p className="hint" key={`${category.name}-${i}`}>
            <b>{category.name}</b>
            {category.actions.length > 0 && (
              <> — {category.actions.map((a) => actionText(a)).join(" · ")}</>
            )}
          </p>
        ))}
      {rule.tier === "T0" && actions.length > 0 && (
        <p className="hint">{actions.map((a) => actionText(a)).join(" · ")}</p>
      )}
    </div>
  );
}
