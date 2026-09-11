/**
 * What the worker does in each group (ADR 0003).
 *
 * A group's agent work, in the order a person asks about it: the automations it
 * runs there (Automations, moved in from Agents — an automation is exactly a
 * per-group thing), what is waiting on a person across every group (Approvals,
 * moved in for the same reason), and the workers themselves (Workers — a worker
 * is a process of its own, and the process list is where it becomes visible
 * that one is not reporting). The installation's own identity and its models
 * stay in Agents; this section is what the fleet does once it is working in a
 * group.
 *
 * Two things are deliberately not here. **Which groups those are** is not a
 * setting either: the agent's membership is decided in Stalwart's own
 * administration, and the Agents section's Groups tab is the one place that
 * reads and explains it — this section reuses that same read (`status.groups`,
 * one store) rather than a second table saying the same thing. And the change
 * reaches the **worker** when it starts, not the moment it is saved — the web
 * tier reads the record live, the worker reads it at boot, and the surface says
 * which is which.
 */
import { useEffect, useState } from "react";
import type { AgentStatus, AgentStatusGroup } from "@/lib/agents";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { AgentApprovals } from "./agent/AgentApprovals";
import { RuleEditor } from "./agent/RuleEditor";

const WORKER_PARTS = [
  { id: "automations", label: "Automations" },
  { id: "approvals", label: "Approvals" },
  { id: "workers", label: "Workers" },
] as const;

type WorkerPart = (typeof WORKER_PARTS)[number]["id"];

export function GroupWorkers() {
  const status = useAgents((s) => s.status);
  const loadStatus = useAgents((s) => s.loadStatus);
  const [part, setPart] = useState<WorkerPart>("automations");

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <div>
      <h1>{t("Group workers")}</h1>
      <p className="lead">
        {t(
          "What the agent does inside each group it has been granted: the automations it runs, what is waiting on a person, and the workers carrying them out. Grants and the installation's own identity live in Agents.",
        )}
      </p>
      <div
        className="segmented"
        role="group"
        aria-label={t("Group worker sections")}
        style={{ marginBottom: 16 }}
      >
        {WORKER_PARTS.map((entry) => (
          <button
            key={entry.id}
            className={part === entry.id ? "active" : ""}
            aria-pressed={part === entry.id}
            onClick={() => setPart(entry.id)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      {part === "automations" && (
        <RuleEditor groups={agentGroups(status).map((group) => group.name)} />
      )}
      {part === "approvals" && <AgentApprovals />}
      {part === "workers" && <Workers status={status} />}
    </div>
  );
}

/**
 * The groups the agent works in — the ones an automation can run in.
 *
 * The status carries the agent's own membership as its session shows it, so
 * there is nothing to filter here: a group in the list is a group the agent is
 * in.
 */
function agentGroups(status: AgentStatus | null): AgentStatusGroup[] {
  return status?.groups ?? [];
}

/* ------------------------------------------------------------------ */
/* Workers: the fleet's own heartbeat                                  */
/* ------------------------------------------------------------------ */

/**
 * Which workers are serving this installation, and whether they still are.
 *
 * A worker is its own process, not a copy of the web tier: it claims the account
 * it serves by lease and writes a heartbeat while it runs. Nothing here starts
 * or stops one — workers are declared where the installation is deployed — and
 * a worker that has gone quiet is stated plainly, because a fleet whose silence
 * is hidden is a fleet nobody fixes.
 */
function Workers({ status }: { status: AgentStatus | null }) {
  return (
    <section>
      <h2>{t("Workers")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "A worker is its own process, not a copy of the web tier: it claims the account it serves by lease and writes a heartbeat while it runs. Nothing here starts or stops one — workers are declared where the installation is deployed.",
        )}
      </p>
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : status.workers.length === 0 ? (
        <p className="hint">
          {t(
            "No worker has reported in. A worker leaves a heartbeat while it runs, so an empty list means none is serving this installation.",
          )}
        </p>
      ) : (
        <table className="sessions-table">
          <thead>
            <tr>
              <th>{t("Worker")}</th>
              <th>{t("Last heartbeat")}</th>
              <th>{t("Version")}</th>
              <th>{t("State")}</th>
            </tr>
          </thead>
          <tbody>
            {status.workers.map((w) => (
              <tr key={w.id}>
                <td className="notranslate" translate="no">
                  {w.address}
                </td>
                <td>{formatListDate(w.heartbeatAt)}</td>
                <td className="mono small">{w.version}</td>
                <td>
                  {/* A worker that is not reporting is stated plainly: a
                      fleet whose silence is hidden is a fleet nobody fixes. */}
                  {w.alive ? (
                    <span className="agent-state ok">{t("Alive")}</span>
                  ) : (
                    <span className="agent-state off">{t("Not reporting")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* A grant that is gone is a fleet fact, and it is said where the fleet
          is read. The worker reports what it was serving for the group when it
          noticed — the group's own trail is unreadable from that moment, so the
          surface says what is known rather than what would be nice to know. */}
      {status && status.withdrawals.length > 0 && (
        <div className="error-box" style={{ marginTop: 12 }}>
          <strong>{t("Grants withdrawn")}</strong>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {status.withdrawals.map((w) => (
              <li key={`${w.account}-${w.at}`}>
                {t(
                  "The agent lost its grant on “{group}” on {when}: nothing has served that group since the pass noticed.",
                  {
                    group: w.group || w.account,
                    when: formatListDate(w.at),
                  },
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
