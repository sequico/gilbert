/**
 * The pending-approval queue, across every group (ADR 0003 "Admin surfaces"
 * and resolution 10, cross-group per ADR 0014).
 *
 * A run that pauses for a person opens a decision document in the group's own
 * account and posts its proposal in the group's chat. The human answers in
 * words, in the chat: there is no Approve button here, and adding one would be
 * the wrong gate — the chat is where the conversation, the draft and the
 * arbiter live.
 *
 * So this queue is oversight, and the escape hatch for a decision nobody has
 * looked at — read across every group at once, because "what is waiting on a
 * person" is a cross-group question by nature: an administrator does not
 * think in one group at a time when asking it.
 */
import { useEffect } from "react";
import { Link } from "wouter";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";

export function AgentApprovals() {
  const approvals = useAgents((s) => s.approvals);
  const loadApprovals = useAgents((s) => s.loadApprovals);
  const problem = useAgents((s) => s.problems.approvals);
  const reading = useAgents((s) => s.busy.approvals);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  return (
    <section>
      <h2>{t("Waiting for a person")}</h2>
      <p className="lead">
        {t(
          "An automation that pauses posts what it proposes in its group's chat, and a member answers there in words. Approving therefore happens in the chat, not here — this queue is the oversight across every group, and the way to see what has been waiting in any of them.",
        )}
      </p>
      {problem ? (
        <div className="error-box">{problem}</div>
      ) : approvals.length === 0 ? (
        <p className="hint">
          {reading ? t("Loading…") : t("Nothing is waiting for a person.")}
        </p>
      ) : (
        <table className="sessions-table">
          <thead>
            <tr>
              <th>{t("Group")}</th>
              <th>{t("What it proposes")}</th>
              <th>{t("Confidence")}</th>
              <th>{t("Raised")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={`${a.group}:${a.decisionId}`}>
                <td className="notranslate" translate="no">
                  {a.group}
                </td>
                <td>{a.summary}</td>
                <td>{`${Math.round(a.confidence * 100)}%`}</td>
                <td>{formatListDate(a.createdAt)}</td>
                <td style={{ textAlign: "right" }}>
                  <Link
                    href="/mail"
                    className="btn btn-sm btn-ghost"
                    title={t("Open {group} and its chat", { group: a.group })}
                  >
                    {t("Open the group's mailbox")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
