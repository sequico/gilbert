/**
 * The approval queue for one group (ADR 0003 "Admin surfaces" and resolution 10).
 *
 * A run that pauses for a person opens a decision document in the group's own
 * account and posts its proposal in the group's chat. The human answers in
 * words, in the chat: there is no Approve button here, and adding one would be
 * the wrong gate — the chat is where the conversation, the draft and the
 * arbiter live.
 *
 * So this queue is oversight, and the escape hatch for a decision nobody has
 * looked at.
 *
 * The group is the section's own pick, and the queue is cut to it here rather
 * than asked for again: the read already walks every group the agent holds, and
 * one group's rows are a filter over that answer. The walk is the agent's own
 * session, so it is complete by construction — a group the agent does not hold
 * has no decision to show, and there is no listing that could have fallen short
 * of it.
 */
import { useEffect } from "react";
import { Link } from "wouter";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";

export function AgentApprovals({ group }: { group: string }) {
  const approvals = useAgents((s) => s.approvals);
  const loadApprovals = useAgents((s) => s.loadApprovals);
  // This section's own line in the store. A queue nobody could read is not an
  // empty queue, and the difference is what this panel has to show.
  const problem = useAgents((s) => s.problems.approvals);
  const reading = useAgents((s) => s.busy.approvals);
  /** The picked group's own rows, out of the queue the read returned. */
  const queue = approvals.filter((a) => a.group === group);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  return (
    <section>
      <h2>{t("Waiting for a person")}</h2>
      <p className="lead">
        {t(
          "An automation that pauses posts what it proposes in the group's chat, and a member answers there in words. Approving therefore happens in the chat, not here — this queue is the oversight for the group picked above, and the way to see what has been waiting in it.",
        )}
      </p>
      {problem ? (
        <div className="error-box">{problem}</div>
      ) : queue.length === 0 ? (
        <p className="hint">
          {reading
            ? t("Loading…")
            : group
              ? t("Nothing is waiting for a person in {group}.", { group })
              : t("No group is picked, so there is no queue to read here.")}
        </p>
      ) : (
        <table className="sessions-table">
          <thead>
            <tr>
              <th>{t("What it proposes")}</th>
              <th>{t("Confidence")}</th>
              <th>{t("Raised")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {queue.map((a) => (
              <tr key={`${a.group}:${a.decisionId}`}>
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
