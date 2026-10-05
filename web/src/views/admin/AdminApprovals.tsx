/**
 * Cross-group oversight: what is waiting for a person, and what the fleet has
 * done — across every group the Master holds, at once (ADR 0003).
 *
 * Both tabs are **read-only by construction**, and stay that way: an operator
 * answers a paused run as a member, in the group's own chat (ADR 0003
 * "Members see, never change") — never through this admin surface. A future
 * change that wants an approve/reject control here supersedes ADR 0003
 * explicitly rather than adding one quietly.
 *
 * Neither tab adds a server route. Pending reads the same cross-group queue
 * `fetchPendingApprovals` already answered; Audit merges the same per-group
 * documents the Group Agents workspace reads (`fetchAgentGroup`, one call per
 * granted group), client-side, tagged with the group each entry belongs to.
 */
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { agentGroupNames, agentViewKey, groupOperation, useAgents } from "@/store/agents";
import {
  AGENT_OUTCOME_LABELS,
  automationText,
  lookupText,
  outcomeText,
} from "@/views/agent/agentText";
import { AgentApprovals } from "./agent/AgentApprovals";

const PARTS = [
  { id: "pending", label: "Pending" },
  { id: "audit", label: "Audit" },
] as const;

type Part = (typeof PARTS)[number]["id"];

export function AdminApprovals() {
  const [part, setPart] = useState<Part>("pending");
  const loadStatus = useAgents((s) => s.loadStatus);
  const approvals = useAgents((s) => s.approvals);
  const loadApprovals = useAgents((s) => s.loadApprovals);

  useEffect(() => {
    void loadStatus();
    void loadApprovals();
  }, [loadStatus, loadApprovals]);

  return (
    <div>
      <h1>
        <Bell size={20} style={{ verticalAlign: "-3px", marginRight: 8 }} />
        {t("Approvals")}
      </h1>
      <p className="lead">
        {t(
          "What is waiting for a person, and what the fleet has done, across every group the agent holds — read-only oversight. An operator answers a paused run in the group's own chat, never here.",
        )}
      </p>
      <div
        className="segmented"
        role="group"
        aria-label={t("Approvals sections")}
        style={{ marginBottom: 16 }}
      >
        {PARTS.map((entry) => (
          <button
            key={entry.id}
            className={part === entry.id ? "active" : ""}
            aria-pressed={part === entry.id}
            onClick={() => setPart(entry.id)}
          >
            {t(entry.label)}
            {entry.id === "pending" && approvals.length > 0 && (
              <span className="badge" style={{ marginLeft: 6 }}>
                {approvals.length}
              </span>
            )}
          </button>
        ))}
      </div>
      {part === "pending" && <AgentApprovals />}
      {part === "audit" && <CrossGroupAudit />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Audit: every granted group's trail, merged                          */
/* ------------------------------------------------------------------ */

function CrossGroupAudit() {
  const status = useAgents((s) => s.status);
  const groupViews = useAgents((s) => s.groupViews);
  const busy = useAgents((s) => s.busy);
  const problems = useAgents((s) => s.problems);
  const loadGroup = useAgents((s) => s.loadGroup);
  const [groupFilter, setGroupFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");

  const groups = agentGroupNames(status);

  // One read per granted group, reusing the same store and the same
  // documents the Group Agents workspace reads — not a second store, and not
  // a new server route. Depending on `groupViews` is what makes this converge:
  // each pass requests only the groups still missing a view, and a group that
  // already has one is skipped, so a re-run costs nothing once every group has
  // landed. A group whose read failed stays missing from `groupViews` forever
  // (the store never writes one on a rejected fetch), so this asks again on
  // every mount rather than looping tightly: `busy`/`problems` below are what
  // tell "still in flight" apart from "gave up, and here is why".
  useEffect(() => {
    for (const g of status?.groups ?? []) {
      if (!groupViews[agentViewKey(g.name)]) void loadGroup(g.name);
    }
  }, [status, groupViews, loadGroup]);

  const unreadable = groups.filter((name) => {
    const op = groupOperation(name);
    return !groupViews[agentViewKey(name)] && busy[op] !== true && problems[op];
  });
  const stillLoading = groups.some((name) => {
    const key = agentViewKey(name);
    const op = groupOperation(name);
    return !groupViews[key] && (busy[op] === true || !problems[op]);
  });

  const entries = groups
    .flatMap((name) => {
      const view = groupViews[agentViewKey(name)];
      if (!view?.granted) return [];
      return view.audit.map((entry) => ({
        group: name,
        // The name of the automation a line belongs to, derived from the
        // trigger it names — the same words the group's own panels show.
        ruleName: automationText(
          view.rules.find((r) => r.id === entry.ruleId) ?? { trigger: undefined },
        ),
        ...entry,
      }));
    })
    .filter((e) => !groupFilter || e.group === groupFilter)
    .filter((e) => !outcomeFilter || e.outcome === outcomeFilter)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 300);

  return (
    <section>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "Every granted group's audit trail, merged and sorted newest first. A group's own Audit tab in Group Agents reads the same document with its own export.",
        )}
      </p>
      {groups.length === 0 ? (
        <p className="hint">
          {t("The agent is not in a group this installation can see.")}
        </p>
      ) : (
        <>
          <div className="row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div className="field" style={{ maxWidth: 260 }}>
              <label htmlFor="audit-filter-group">{t("Group")}</label>
              <select
                id="audit-filter-group"
                className="select"
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
              >
                <option value="">{t("Every group")}</option>
                {groups.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label htmlFor="audit-filter-outcome">{t("Outcome")}</label>
              <select
                id="audit-filter-outcome"
                className="select"
                value={outcomeFilter}
                onChange={(e) => setOutcomeFilter(e.target.value)}
              >
                <option value="">{t("Every outcome")}</option>
                {Object.keys(AGENT_OUTCOME_LABELS).map((code) => (
                  <option key={code} value={code}>
                    {outcomeText(code)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {stillLoading && <p className="hint">{t("Reading every group's trail…")}</p>}
          {unreadable.length > 0 && (
            <p className="hint">
              {t(
                "The audit of {groups} could not be read, so it is missing from this list.",
                { groups: unreadable.join(", ") },
              )}
            </p>
          )}
          {entries.length === 0 ? (
            !stillLoading && <p className="hint">{t("Nothing matches here yet.")}</p>
          ) : (
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>{t("Group")}</th>
                  <th>{t("When")}</th>
                  <th>{t("Outcome")}</th>
                  <th>{t("Automation")}</th>
                  <th>{t("Read")}</th>
                  <th>{t("By")}</th>
                  <th>{t("Detail")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={`${entry.group}-${entry.jobId}-${i}`}>
                    <td className="notranslate" translate="no">
                      {entry.group}
                    </td>
                    <td>{formatListDate(entry.at)}</td>
                    <td>{outcomeText(entry.outcome)}</td>
                    <td>{entry.ruleName}</td>
                    <td>{(entry.lookups ?? []).map(lookupText).join(", ") || "—"}</td>
                    <td>{entry.by ?? "—"}</td>
                    <td>{entry.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
