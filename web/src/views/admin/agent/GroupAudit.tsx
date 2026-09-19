/**
 * A group's audit trail, as an administrator reads it (ADR 0003).
 *
 * The same bounded document the member panel already reads
 * (`AgentGroupSurface.audit`, read once with the rest of the group's agent
 * documents via `loadGroup`) — reused here rather than re-fetched or
 * re-rendered differently, so "what has this group's agent done" reads the
 * same wherever it is asked (`GroupAgentPanel.tsx`). The month-by-month export
 * stays the copy an administrator takes before the oldest month is pruned;
 * this table is for reading without downloading anything.
 */
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchAgentAuditExport } from "@/lib/agents";
import { downloadFile } from "@/lib/download";
import { formatListDate } from "@/lib/format";
import { groupAccessSentence } from "@/lib/groupAccess";
import { t } from "@/lib/i18n";
import { agentViewKey, groupOperation, useAgents } from "@/store/agents";
import { automationText, outcomeText } from "@/views/agent/agentText";

/** How many of the most recent entries this table shows before pointing at the export. */
const MAX_ROWS = 200;

export function GroupAudit({ group, known }: { group: string; known: boolean }) {
  const groupViews = useAgents((s) => s.groupViews);
  const busyReads = useAgents((s) => s.busy);
  const problems = useAgents((s) => s.problems);
  const loadGroup = useAgents((s) => s.loadGroup);
  const [downloading, setDownloading] = useState(false);
  const [downloadProblem, setDownloadProblem] = useState<string | null>(null);

  const op = group ? groupOperation(group) : "";
  const view = group ? groupViews[agentViewKey(group)] : undefined;
  const loading = op ? busyReads[op] === true : false;
  const problem = op ? (problems[op] ?? null) : null;

  useEffect(() => {
    if (group && known) void loadGroup(group);
  }, [group, known, loadGroup]);

  // Newest first: the same order the member panel reads its own window in.
  const entries = view?.granted
    ? [...view.audit].sort((a, b) => (a.at < b.at ? 1 : -1))
    : [];
  // The name of the automation a line belongs to: derived from the trigger the
  // rule carries, or from the entry's own detail when the rule is gone (the
  // trail already names what it was).
  const nameOf = (ruleId: string) =>
    view?.granted
      ? automationText(view.rules.find((r) => r.id === ruleId) ?? { trigger: undefined })
      : "";

  async function download() {
    if (!group) return;
    setDownloading(true);
    setDownloadProblem(null);
    try {
      const trail = await fetchAgentAuditExport(group);
      downloadFile(
        JSON.stringify(trail, null, 2),
        "application/json",
        `${group.replace(/[^\w.-]+/g, "_")}.audit.json`,
      );
    } catch (err) {
      setDownloadProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section>
      <h2>{t("Audit trail")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "What this group's agent has done, newest first — the same document its own members read beside the chat. Kept twelve months, pruned a month at a time.",
        )}
      </p>
      {!group ? (
        <p className="hint">
          {t("No group is picked, so there is no audit trail to read here.")}
        </p>
      ) : !known ? (
        <div className="warn-box">{groupAccessSentence("agent documents")}</div>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ marginBottom: 12 }}
            disabled={downloading}
            onClick={() => void download()}
            title={t("Download every retained month of this group's audit trail as JSON")}
          >
            <Download size={14} />{" "}
            {downloading ? t("Copying…") : t("Download every retained month as JSON")}
          </button>
          {downloadProblem && (
            <div className="error-box" style={{ marginBottom: 12 }}>
              {downloadProblem}
            </div>
          )}
          {problem ? (
            <div className="error-box">{problem}</div>
          ) : !view ? (
            <p className="hint">
              {loading ? t("Loading…") : t("This group's audit trail could not be read.")}
            </p>
          ) : entries.length === 0 ? (
            <p className="hint">{t("This group's agent has not done anything yet.")}</p>
          ) : (
            <>
              <table className="sessions-table">
                <thead>
                  <tr>
                    <th>{t("When")}</th>
                    <th>{t("Outcome")}</th>
                    <th>{t("Automation")}</th>
                    <th>{t("By")}</th>
                    <th>{t("Detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.slice(0, MAX_ROWS).map((entry, i) => (
                    <tr key={`${entry.jobId}-${i}`}>
                      <td>{formatListDate(entry.at)}</td>
                      <td>{outcomeText(entry.outcome)}</td>
                      <td>{nameOf(entry.ruleId) || entry.ruleId}</td>
                      <td>{entry.by ?? "—"}</td>
                      <td>{entry.detail ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {entries.length > MAX_ROWS && (
                <p className="hint" style={{ marginTop: 8 }}>
                  {t(
                    "Showing the most recent {shown} of {total}. Download every retained month above for the rest.",
                    { shown: MAX_ROWS, total: entries.length },
                  )}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
