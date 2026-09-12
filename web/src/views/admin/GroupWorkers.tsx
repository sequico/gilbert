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
 * One group at a time, and the picker under the title is how a person says
 * which: the automations the group's agent runs, what is waiting on a person
 * there, which workers hold its account and which grants it lost are all facts
 * about one group, and a page that answered about every group at once answered
 * about none.
 *
 * **Which groups there are** is not a setting here: the agent's membership is
 * decided in Stalwart's own administration, and the Agents section's Groups tab
 * is the one place that reads and explains it — this section reuses that same
 * read (`status.groups`, one store) rather than a second table saying the same
 * thing, and the picker is a pick over it, never a write. And the change
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
  /*
   * The group every tab below answers about. It is a pick and not a setting:
   * the list it picks from is Stalwart's own membership, read here and written
   * nowhere, and the tabs are handed the name so each reads the group's own
   * account rather than scanning every group it can reach.
   */
  const [group, setGroup] = useState("");
  const groups = agentGroups(status).map((entry) => entry.name);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // The membership is read live, so the pick follows it: a group the agent no
  // longer holds is not a selection, and the first one it does hold is.
  useEffect(() => {
    if (!groups.includes(group)) setGroup(groups[0] ?? "");
  }, [groups, group]);

  return (
    <div>
      <h1>{t("Group workers")}</h1>
      <p className="lead">
        {t(
          "What the agent does inside the group it has been granted, one group at a time: the automations it runs there, what is waiting on a person, and the workers carrying them out. Grants and the installation's own identity live in Agents.",
        )}
      </p>
      {groups.length === 0 ? (
        <p className="hint" style={{ marginBottom: 16 }}>
          {t(
            "The agent is not in a group this session can see, so there is no group to pick here. Give it a group in Stalwart's own administration: the tabs below answer about one group, and the fleet they read is the installation's own.",
          )}
        </p>
      ) : (
        <div className="field" style={{ maxWidth: 380, marginBottom: 16 }}>
          <label htmlFor="agent-worker-group">{t("Group")}</label>
          <select
            id="agent-worker-group"
            className="select"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            {groups.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
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
      {part === "automations" && <RuleEditor groups={groups} group={group} />}
      {part === "approvals" && <AgentApprovals group={group} />}
      {part === "workers" && <Workers status={status} group={group} />}
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
function Workers({ status, group }: { status: AgentStatus | null; group: string }) {
  /*
   * Who is serving this group. The claim is per account, so a worker holds the
   * groups whose accounts it has claimed and names them in its heartbeat: the
   * picker cuts the fleet to the group being asked about, and a worker holding
   * somebody else's group is simply not on this list.
   */
  const serving = (status?.workers ?? []).filter((w) => w.groups.includes(group));
  // The grants withdrawn in this group: the withdrawal names the group it
  // happened in, so it follows the picker the same way the workers do.
  const withdrawals = (status?.withdrawals ?? []).filter((w) => w.group === group);
  /*
   * What an empty list means, which is three different facts — and the one a
   * person most needs is the last: workers that are up and holding everything
   * but this group read exactly like a fleet that is not running, unless the
   * surface says which it is.
   */
  const nothingServing = !group
    ? t("No group is picked, so there is no group's workers to read here.")
    : status && status.workers.length > 0
      ? t(
          "The installation's {count} workers are reporting and none of them holds {group}: nothing is serving this group right now.",
          { count: status.workers.length, group },
        )
      : t(
          "No worker has reported in. A worker leaves a heartbeat while it runs, so an empty list means none is serving this installation.",
        );
  return (
    <section>
      <h2>{t("Workers")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "A worker is its own process, not a copy of the web tier: it claims the account it serves by lease and writes a heartbeat while it runs. Nothing here starts or stops one — workers are declared where the installation is deployed.",
        )}
      </p>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "A worker claims a group's own account, and its heartbeat names the groups it holds: this is who is serving the group picked above, and a worker holding another group is not on it.",
        )}
      </p>
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : serving.length === 0 ? (
        <p className="hint">{nothingServing}</p>
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
            {serving.map((w) => (
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
      {withdrawals.length > 0 && (
        <div className="error-box" style={{ marginTop: 12 }}>
          <strong>{t("Grants withdrawn")}</strong>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {withdrawals.map((w) => (
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
