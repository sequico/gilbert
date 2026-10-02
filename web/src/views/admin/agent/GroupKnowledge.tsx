/**
 * What a group's agent read, planned and found in the knowledge base (ADR 0024
 * Q23).
 *
 * A multi-document change and a consistency check are the fleet's, and their
 * record rides the run's own job into the audit trail — one entry per page with
 * its outcome, basedOn and intended body, and a review's findings. This tab
 * reads the same trail `GroupAudit` does, filtered to the runs that carried
 * either, so "what did it propose, and what did it find" is a surface of its
 * own rather than a column nobody can read.
 */
import { useEffect } from "react";
import { formatListDate } from "@/lib/format";
import { groupAccessSentence } from "@/lib/groupAccess";
import { t } from "@/lib/i18n";
import { agentViewKey, groupOperation, useAgents } from "@/store/agents";
import { automationText, outcomeText } from "@/views/agent/agentText";

/** The outcome of one page of a plan, in the reader's words. */
function pageOutcomeText(outcome: string): string {
  switch (outcome) {
    case "created":
      return t("created");
    case "written":
      return t("written");
    case "moved":
      return t("refused — the page had changed");
    case "failed":
      return t("failed");
    default:
      return outcome;
  }
}

export function GroupKnowledge({ group, known }: { group: string; known: boolean }) {
  const groupViews = useAgents((s) => s.groupViews);
  const busyReads = useAgents((s) => s.busy);
  const problems = useAgents((s) => s.problems);
  const loadGroup = useAgents((s) => s.loadGroup);

  const op = group ? groupOperation(group) : "";
  const view = group ? groupViews[agentViewKey(group)] : undefined;
  const loading = op ? busyReads[op] === true : false;
  const problem = op ? (problems[op] ?? null) : null;

  useEffect(() => {
    if (group && known) void loadGroup(group);
  }, [group, known, loadGroup]);

  const entries = view?.granted
    ? [...view.audit].sort((a, b) => (a.at < b.at ? 1 : -1))
    : [];
  // Only the runs that carried a plan or a review: the rest belong to Activity.
  const knowledge = entries.filter(
    (e) => (e.plan?.pages.length ?? 0) > 0 || (e.findings?.length ?? 0) > 0,
  );
  const nameOf = (ruleId: string) =>
    view?.granted
      ? automationText(view.rules.find((r) => r.id === ruleId) ?? { trigger: undefined })
      : "";

  return (
    <section>
      <h2>{t("Knowledge base")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "The knowledge base changes this group's agent proposed — a multi-page plan, page by page — and the findings of its consistency checks. A plan writes drafts; an administrator approves them.",
        )}
      </p>
      {!group ? (
        <p className="hint">
          {t("No group is picked, so there is nothing to read here.")}
        </p>
      ) : !known ? (
        <div className="warn-box">{groupAccessSentence("agent documents")}</div>
      ) : problem ? (
        <div className="error-box">{problem}</div>
      ) : !view ? (
        <p className="hint">
          {loading ? t("Loading…") : t("This group's agent record could not be read.")}
        </p>
      ) : knowledge.length === 0 ? (
        <p className="hint">
          {t("This group's agent has not planned or reviewed the knowledge base yet.")}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {knowledge.map((entry, i) => (
            <article key={`${entry.jobId}-${i}`} className="card" style={{ padding: 14 }}>
              <div
                className="row"
                style={{ gap: 8, flexWrap: "wrap", alignItems: "baseline" }}
              >
                <strong>{nameOf(entry.ruleId) || entry.ruleId}</strong>
                <span className="chip">{outcomeText(entry.outcome)}</span>
                <span className="hint">{formatListDate(entry.at)}</span>
                {entry.by && (
                  <span className="hint">{t("by {who}", { who: entry.by })}</span>
                )}
              </div>

              {entry.findings && entry.findings.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="hint" style={{ marginBottom: 4 }}>
                    {t("Findings")}
                  </div>
                  {entry.findings.map((finding, k) => (
                    <p key={k} style={{ margin: "0 0 6px", whiteSpace: "pre-wrap" }}>
                      {finding}
                    </p>
                  ))}
                </div>
              )}

              {entry.plan && entry.plan.pages.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="hint" style={{ marginBottom: 4 }}>
                    {t("Plan — {count} page(s)", { count: entry.plan.pages.length })}
                  </div>
                  <table className="sessions-table">
                    <thead>
                      <tr>
                        <th>{t("Page")}</th>
                        <th>{t("Outcome")}</th>
                        <th>{t("Read at")}</th>
                        <th>{t("Intended change")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.plan.pages.map((page, k) => (
                        <tr key={`${page.folder}-${k}`}>
                          <td>{page.title || page.folder}</td>
                          <td>{pageOutcomeText(page.outcome)}</td>
                          <td>{page.basedOn ? formatListDate(page.basedOn) : "—"}</td>
                          <td
                            style={{
                              maxWidth: 420,
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {page.intent || page.detail || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {entry.detail && <p className="hint">{entry.detail}</p>}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
