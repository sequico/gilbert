/**
 * The group's agent, as a member sees it (ADR 0003 "Members see, never change").
 *
 * Next to the group chat, this panel answers the questions a member has: which
 * agent is active here (its address), what it is told to do (the group's
 * standing instruction), what it does here (the automations), and what it has
 * done (the audit, and the jobs still open).
 *
 * It reads the member door (`/api/agent/group/:name`) rather than the admin one:
 * this route needs a session on the group and nothing more, so the panel shows
 * the same thing to every member, and an administrator reads it the way every
 * other member does. It is read-only by construction. The group's own `gilbert/`
 * folder is writable by a member by construction — that is how the chat works —
 * so this is a UI convention and an accepted trust inside the group, not a
 * server ACL. The pen stays in the administration, which is what the panel says
 * out loud; the member's two actions are approving an action and addressing the
 * agent, both in the chat.
 */
import { AGENT_JOB_OPEN_STATES } from "@gilbert/agent/documents";
import { Bot, X } from "lucide-react";
import { useEffect } from "react";
import type { GroupInstructionView, MemberAgentRule } from "@/lib/agents";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { agentViewKey, memberOperation, useAgents } from "@/store/agents";
import {
  jobStateText,
  outcomeText,
  reviewText,
  ruleInstruction,
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
  const memberViews = useAgents((s) => s.memberViews);
  const busyReads = useAgents((s) => s.busy);
  const problems = useAgents((s) => s.problems);
  const loadMemberView = useAgents((s) => s.loadMemberView);

  // The store holds one entry per group, under `agentViewKey(name)`; the panel
  // reads the line for **this** group, so another group's read in flight does
  // not make this one look like it is still loading.
  const operation = memberOperation(name);
  const view = memberViews[agentViewKey(name)];
  const loading = busyReads[operation] === true;
  const error = problems[operation] ?? null;

  useEffect(() => {
    // Only when there is nothing to show: the chat panel loads the group's view
    // for the mention picker already, and this is the retry after it failed.
    if (!view) void loadMemberView(name);
  }, [name, loadMemberView, view]);

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
          )}
        </p>
      ) : (
        <>
          <p className="hint">
            {t(
              "Active in this group as {address}. Read-only: what it follows is authored in the administration, and you answer it in this chat.",
              { address: view.agentAddress ?? view.group },
            )}
          </p>
          <p className="hint">
            {t(
              "Only an administrator of this group changes its instruction and its automations; every member reads them here.",
            )}
          </p>
          <h4>{t("Standing instruction")}</h4>
          <Instruction instruction={view.instruction} />
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

/**
 * The group's standing instruction: one text as it was left, never a field.
 *
 * It is what the agent carries into every model call, so a member who cannot
 * read it cannot judge what the agent does in their name — and a member who can
 * edit it would be configuring the agent, which is the administrator's job. The
 * group that has none says so in words: a blank block would read the same as an
 * instruction nobody managed to write.
 */
function Instruction({ instruction }: { instruction: GroupInstructionView }) {
  const text = instruction.text.trim();
  return (
    <div className="chat-agent-instruction">
      {text ? (
        <p className="agent-readonly-text">{instruction.text}</p>
      ) : (
        <p className="hint">
          {t("No standing instruction has been written for this group.")}
        </p>
      )}
      {text && instruction.updatedAt && (
        <p className="hint">
          {t("Last written by {who} on {when}.", {
            who: instruction.updatedBy ?? t("an administrator"),
            when: formatListDate(instruction.updatedAt),
          })}
        </p>
      )}
    </div>
  );
}

/** One automation as a member reads it: what wakes it, and what it is asked to do. */
function RuleFacts({ rule }: { rule: MemberAgentRule }) {
  const instruction = ruleInstruction(rule);
  return (
    <div className="chat-agent-rule">
      <div className="agent-rule-head">
        <b>{rule.name || t("Untitled automation")}</b>
        {!rule.enabled && <span className="agent-state off">{t("Disabled")}</span>}
      </div>
      <p className="hint">{triggerText(rule.trigger)}</p>
      <p className="hint">{reviewText(rule.review)}</p>
      {instruction && <p className="agent-readonly-text">{instruction}</p>}
    </div>
  );
}
