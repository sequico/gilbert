/**
 * What the agents do in each group (ADR 0003, restructured by ADR 0014).
 *
 * One group at a time, behind a single picker that drives every tab below it:
 * the automations the group's agent runs (Automations), its standing
 * instruction and its notebook of facts (Standing instruction, Memory — moved
 * here from Master, beside the rule documents they belong with), what it has
 * done (Audit trail), and the agents themselves (Agents — the process list,
 * where it becomes visible that one is not reporting).
 *
 * **Which groups there are** is not a setting here: the Master's membership is
 * decided in Stalwart's own administration, and Master's own section is the
 * one place that reads and explains it — this section reuses that same read
 * (`status.groups`, one store) rather than a second table saying the same
 * thing, and the picker is a pick over it, never a write.
 *
 * Cross-group oversight — what is waiting for a person and what the fleet has
 * done, across every group at once — lives in Approvals instead: a question
 * about one group and a question about all of them are two different pages,
 * and a page that tried to answer both was harder to read than either.
 */
import { CheckCircle2, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { type AgentStatus, type AgentStatusGroup, addAgentLabels } from "@/lib/agents";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { agentViewKey, useAgents } from "@/store/agents";
import { toast } from "@/ui/toast";
import { GroupAudit } from "./agent/GroupAudit";
import { GroupInstruction } from "./agent/GroupInstruction";
import { GroupMemory } from "./agent/GroupMemory";
import { RuleEditor } from "./agent/RuleEditor";

// Short tab labels on purpose: each panel's own heading says the full name
// ("Standing instruction", "Audit trail") — the tab strip is a nav, not the
// second place to read the sentence.
const GROUP_PARTS = [
  { id: "automations", label: "Automations" },
  { id: "instruction", label: "Instruction" },
  { id: "memory", label: "Memory" },
  { id: "audit", label: "Audit" },
  { id: "fleet", label: "Agents" },
] as const;

type GroupPart = (typeof GROUP_PARTS)[number]["id"];

export function GroupAgents() {
  const status = useAgents((s) => s.status);
  const loadStatus = useAgents((s) => s.loadStatus);
  const loadGroup = useAgents((s) => s.loadGroup);
  const groupViews = useAgents((s) => s.groupViews);
  const approvals = useAgents((s) => s.approvals);
  const [part, setPart] = useState<GroupPart>("automations");

  /*
   * The group every tab below answers about. Master's Groups list can deep-link
   * here with `?group=name` (ADR 0014) — read once, on mount, as the starting
   * pick; after that the picker below is the one source of truth.
   */
  const search = useSearch();
  const [group, setGroup] = useState(
    () => new URLSearchParams(search).get("group") ?? "",
  );
  const groups = agentGroups(status).map((entry) => entry.name);
  const known = group !== "" && groups.includes(group);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // The membership is read live, so the pick follows it: a group the agent no
  // longer holds is not a selection, and the first one it does hold is.
  useEffect(() => {
    if (groups.length === 0) return;
    if (!groups.includes(group)) setGroup(groups[0] ?? "");
  }, [groups, group]);

  // The group's own documents, read once per group so the status strip below
  // and the Audit tab have them without waiting for a particular tab to ask.
  useEffect(() => {
    if (group && known) void loadGroup(group);
  }, [group, known, loadGroup]);

  const view = known ? groupViews[agentViewKey(group)] : undefined;
  const rulesEnabled = view?.granted ? view.rules.filter((r) => r.enabled).length : 0;
  const rulesTotal = view?.granted ? view.rules.length : 0;
  const pendingHere = approvals.filter((a) => a.group === group).length;
  const servingHere = (status?.workers ?? []).filter((w) =>
    w.groups.includes(group),
  ).length;

  return (
    <div>
      <h1>{t("Group Agents")}</h1>
      <p className="lead">
        {t(
          "What the agent does inside the group it has been granted, one group at a time: its automations, its standing instruction and memory, what it has done, and the agents carrying it out. Grants and the installation's own identity live in Master; what is waiting across every group lives in Approvals.",
        )}
      </p>
      {groups.length === 0 ? (
        <p className="hint" style={{ marginBottom: 16 }}>
          {t(
            "The agent is not in a group this session can see, so there is no group to pick here. Give it a group in Stalwart's own administration: the tabs below answer about one group, and the fleet they read is the installation's own.",
          )}
        </p>
      ) : (
        <>
          <div className="field" style={{ maxWidth: 380, marginBottom: 12 }}>
            <label htmlFor="agent-fleet-group">{t("Group")}</label>
            <select
              id="agent-fleet-group"
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
          {known && (
            <GroupGlance
              rulesEnabled={rulesEnabled}
              rulesTotal={rulesTotal}
              pending={pendingHere}
              serving={servingHere}
            />
          )}
          {known && <LabelSetup group={group} />}
        </>
      )}
      <div
        className="segmented"
        role="group"
        aria-label={t("Group agent sections")}
        style={{ marginBottom: 16 }}
      >
        {GROUP_PARTS.map((entry) => (
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
      {part === "instruction" && <GroupInstruction group={group} />}
      {part === "memory" && <GroupMemory group={group} known={known} />}
      {part === "audit" && <GroupAudit group={group} known={known} />}
      {part === "fleet" && <Fleet status={status} group={group} />}
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
/* At a glance: three counts before the tabs                           */
/* ------------------------------------------------------------------ */

/**
 * The three facts an administrator asks first about one group, before
 * choosing a tab: how much of it is armed, whether anything here is waiting
 * for a person, and whether an agent is actually serving it right now.
 */
function GroupGlance({
  rulesEnabled,
  rulesTotal,
  pending,
  serving,
}: {
  rulesEnabled: number;
  rulesTotal: number;
  pending: number;
  serving: number;
}) {
  return (
    <div className="row" style={{ gap: 20, flexWrap: "wrap", marginBottom: 16 }}>
      <span className="hint">
        {t("{enabled} of {total} automations enabled", {
          enabled: rulesEnabled,
          total: rulesTotal,
        })}
      </span>
      <span className="hint">
        {pending > 0
          ? t("{n} waiting for a person in this group", { n: pending })
          : t("Nothing waiting for a person here")}
      </span>
      <span className="hint">
        {serving > 0
          ? t("{n} agents serving this group", { n: serving })
          : t("No agent is serving this group right now")}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Group setup: the reserved label catalogue                           */
/* ------------------------------------------------------------------ */

/**
 * The reserved `G-` labels a group's agent files mail under
 * (`G-needattention`, `G-processed`, `G-awaiting`, `G-rejected`) — created
 * from here once the grant exists (ADR 0003 *Admin surfaces*), idempotently:
 * asking again when the catalogue is already complete adds nothing and says so.
 */
function LabelSetup({ group }: { group: string }) {
  const [busy, setBusy] = useState(false);

  const ensure = async () => {
    setBusy(true);
    try {
      const added = await addAgentLabels(group);
      toast.success(
        added.length > 0
          ? t("Added: {labels}", { labels: added.join(", ") })
          : t("This group's label catalogue already has every reserved label."),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row" style={{ gap: 8, alignItems: "baseline", marginBottom: 16 }}>
      <p className="hint" style={{ margin: 0 }}>
        <Tags size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
        {t(
          "This group's agent marks what it has done with a message using four reserved labels.",
        )}{" "}
        <span className="mono notranslate" translate="no">
          G-needattention, G-processed, G-awaiting, G-rejected
        </span>
      </p>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={busy}
        onClick={() => void ensure()}
      >
        <CheckCircle2 size={13} /> {busy ? t("Checking…") : t("Make sure they exist")}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Agents: the fleet's own heartbeat, for this group                   */
/* ------------------------------------------------------------------ */

/**
 * Which agents are serving this installation, and whether they still are.
 *
 * An agent is its own process, not a copy of the web tier: it claims the
 * account it serves by lease and writes a heartbeat while it runs. Nothing
 * here starts or stops one — agents are declared where the installation is
 * deployed — and one that has gone quiet is stated plainly, because a fleet
 * whose silence is hidden is a fleet nobody fixes.
 */
function Fleet({ status, group }: { status: AgentStatus | null; group: string }) {
  /*
   * Who is serving this group. The claim is per account, so an agent holds the
   * groups whose accounts it has claimed and names them in its heartbeat: the
   * picker cuts the fleet to the group being asked about, and an agent holding
   * somebody else's group is simply not on this list.
   */
  const serving = (status?.workers ?? []).filter((w) => w.groups.includes(group));
  // The grants withdrawn in this group: the withdrawal names the group it
  // happened in, so it follows the picker the same way the agents do.
  const withdrawals = (status?.withdrawals ?? []).filter((w) => w.group === group);
  const nothingServing = !group
    ? t("No group is picked, so there is no group's agents to read here.")
    : status && status.workers.length > 0
      ? t(
          "The installation's {count} agents are reporting and none of them holds {group}: nothing is serving this group right now.",
          { count: status.workers.length, group },
        )
      : t(
          "No agent has reported in. An agent leaves a heartbeat while it runs, so an empty list means none is serving this installation.",
        );
  return (
    <section>
      <h2>{t("Agents")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "An agent is its own process, not a copy of the web tier: it claims the account it serves by lease and writes a heartbeat while it runs. Nothing here starts or stops one — agents are declared where the installation is deployed.",
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
              <th>{t("Agent")}</th>
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
      {withdrawals.length > 0 && (
        <div className="error-box" style={{ marginTop: 12 }}>
          <strong>{t("Grants withdrawn")}</strong>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {withdrawals.map((w) => (
              <li key={`${w.account}-${w.at}`}>
                {t(
                  "The agent lost its grant on “{group}” on {when}: nothing has served that group since the pass noticed.",
                  { group: w.group || w.account, when: formatListDate(w.at) },
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
