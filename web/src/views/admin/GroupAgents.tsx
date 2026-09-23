/**
 * The agent, as one group sees it (ADR 0003).
 *
 * The installation runs **one** agent, and this page is that agent *in a
 * single group*: how it behaves there, what it follows, what it remembers and
 * what it has done. The group is picked once, in the header, and the header
 * also names the agent and says what it is doing here, so the page reads as
 * one subject before any section is opened.
 *
 * Its four sections are the group's agent at four reaches, in the order a
 * person asks about them:
 *
 * - **Behaviour** — the standing instruction every call carries, and the
 *   policy its runs stop for (ADR 0019, ADR 0006);
 * - **Automations** — one rule per trigger, each with its own instruction and
 *   its own allowlist (ADR 0006);
 * - **Memory** — the notebook its calls are given;
 * - **Activity** — the audit trail and the agents serving this group.
 *
 * `agent/rules.json` is a document of its own rather than a field of the
 * group's configuration: it holds up to four independent rules (email, file,
 * chat, schedule), each pinned by `ruleId`/`ruleVersion` on the jobs and the
 * audit that reference it, and each readable by the group's own members. It is
 * a section of the agent's behaviour, not a peer of the instruction and the
 * policy, and **Automations** is where it is shown.
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
import { Bot, CheckCircle2, Tags } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useSearch } from "wouter";
import { type AgentStatus, type AgentStatusGroup, addAgentLabels } from "@/lib/agents";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { agentViewKey, useAgents } from "@/store/agents";
import { toast } from "@/ui/toast";
import { GroupAudit } from "./agent/GroupAudit";
import { GroupInstruction } from "./agent/GroupInstruction";
import { GroupMemory } from "./agent/GroupMemory";
import { GroupPolicy } from "./agent/GroupPolicy";
import { RuleEditor } from "./agent/RuleEditor";

// Short tab labels on purpose: each panel's own heading says the full name
// ("Standing instruction", "Audit trail") — the tab strip is a nav, not the
// second place to read the sentence. Behaviour and Activity each hold two
// documents that belong together; Automations and Memory are one each.
const GROUP_PARTS = [
  { id: "behaviour", label: "Behaviour" },
  { id: "automations", label: "Automations" },
  { id: "memory", label: "Memory" },
  { id: "activity", label: "Activity" },
] as const;

type GroupPart = (typeof GROUP_PARTS)[number]["id"];

export function GroupAgents() {
  const status = useAgents((s) => s.status);
  const loadStatus = useAgents((s) => s.loadStatus);
  const loadGroup = useAgents((s) => s.loadGroup);
  const groupViews = useAgents((s) => s.groupViews);
  const approvals = useAgents((s) => s.approvals);

  /*
   * The group and the tab below are in the URL, read once on mount: Master's
   * Groups list deep-links here with `?group=name` (ADR 0003), and keeping the
   * tab there too means a refresh, a bookmark or a back button reopens the
   * same group at the same section instead of dropping the reader back on the
   * first one. After mount the picker and the tablist are the sources of truth.
   */
  const search = useSearch();
  const initial = new URLSearchParams(search);
  const initialTab = initial.get("tab");
  const [part, setPart] = useState<GroupPart>(() =>
    GROUP_PARTS.some((entry) => entry.id === initialTab)
      ? (initialTab as GroupPart)
      : "behaviour",
  );
  const [group, setGroup] = useState(() => initial.get("group") ?? "");
  const groups = agentGroups(status).map((entry) => entry.name);
  const known = group !== "" && groups.includes(group);

  // Keep the address bar in step, so the URL is always a link to what is on
  // screen rather than only to the group. The router is not asked to re-render:
  // nothing below reads the search back.
  useEffect(() => {
    // Merged into whatever is already there rather than rebuilt: another
    // parameter on this route is not this component's to drop.
    const params = new URLSearchParams(window.location.search);
    if (group) params.set("group", group);
    else params.delete("group");
    if (part !== "behaviour") params.set("tab", part);
    else params.delete("tab");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, [group, part]);

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

  /*
   * Arrow-key movement across the tab strip, the way the tab ARIA pattern asks
   * for: the strip is one stop in the tab order and the arrows move between the
   * tabs, instead of every tab being its own stop.
   */
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = GROUP_PARTS.findIndex((entry) => entry.id === part);
    const next = GROUP_PARTS[(at + step + GROUP_PARTS.length) % GROUP_PARTS.length];
    if (!next) return;
    setPart(next.id);
    document.getElementById(`agent-tab-${next.id}`)?.focus();
  };

  return (
    <div>
      <h1>
        <Bot size={22} style={{ verticalAlign: "-3px", marginRight: 8 }} />
        {t("The agent in this group")}
      </h1>
      <p className="lead">
        {t(
          "The agent, as this group sees it: how it behaves, what it follows, what it remembers, and what it has done. It is one agent for the whole installation — which groups it holds, the model it runs on and the rules that hold everywhere live in Master.",
        )}
      </p>
      {groups.length === 0 ? (
        <p className="hint" style={{ marginBottom: 16 }}>
          {t(
            "The agent is not in a group this session can see, so there is no group to pick here. Give it a group in Stalwart's own administration: the tabs below answer about one group, and the fleet they read is the installation's own.",
          )}
        </p>
      ) : (
        // One bar for the group's own facts: which group, what it is doing at a
        // glance, and the one setup step its reserved labels need. The sections
        // below it are the documents, so nothing about the group is a section.
        <div className="card agent-group-bar">
          <div className="field" style={{ maxWidth: 380, margin: 0 }}>
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
          {known && (view?.agentAddress || status?.address) && (
            // The header names the subject: one agent, working here. The group
            // surface carries the address the group is served under; the fleet
            // status is the fallback while that read is still in flight.
            <p className="hint" style={{ margin: 0 }}>
              <Bot size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
              {t("Working in this group as {address}.", {
                address: view?.agentAddress || status?.address || "",
              })}
            </p>
          )}
          {known && (
            <GroupGlance
              rulesEnabled={rulesEnabled}
              rulesTotal={rulesTotal}
              rulesUnreadable={view?.granted === true && view.rulesUnreadable === true}
              pending={pendingHere}
              serving={servingHere}
            />
          )}
          {known && <LabelSetup group={group} />}
        </div>
      )}
      <div
        className="segmented agent-tabs"
        role="tablist"
        aria-label={t("Group agent sections")}
        onKeyDown={onTabKey}
      >
        {GROUP_PARTS.map((entry) => (
          <button
            key={entry.id}
            id={`agent-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={part === entry.id}
            // One shared panel, so only the selected tab names it: a reference
            // from an inactive tab would point at a panel that is not its own.
            aria-controls={part === entry.id ? "agent-tabpanel" : undefined}
            tabIndex={part === entry.id ? 0 : -1}
            className={part === entry.id ? "active" : ""}
            onClick={() => setPart(entry.id)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="agent-tabpanel"
        aria-labelledby={`agent-tab-${part}`}
        tabIndex={-1}
      >
        {part === "behaviour" && (
          <>
            {/* The two documents a run is held to before any automation is:
                what the agent is told (the standing instruction) and who its
                runs stop for (the policy). One section, because they answer
                one question — how the agent behaves here. */}
            <GroupInstruction group={group} />
            <GroupPolicy group={group} />
          </>
        )}
        {part === "automations" && <RuleEditor groups={groups} group={group} />}
        {part === "memory" && <GroupMemory group={group} known={known} />}
        {part === "activity" && (
          <>
            {/* What it has done, and who is doing it: the trail and the agents
                serving this group, read together because the second explains
                the gaps in the first. */}
            <GroupAudit group={group} known={known} />
            <Fleet status={status} group={group} />
          </>
        )}
      </div>
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
  rulesUnreadable,
  pending,
  serving,
}: {
  rulesEnabled: number;
  rulesTotal: number;
  /** The document is there but does not read, so the counts mean nothing. */
  rulesUnreadable: boolean;
  pending: number;
  serving: number;
}) {
  return (
    <div className="agent-glance">
      <span className="hint">
        {rulesUnreadable
          ? t("The automations document cannot be read.")
          : t("{enabled} of {total} automations enabled", {
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
    <div className="agent-label-setup">
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
      <h2>{t("Agents serving this group")}</h2>
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
                  {w.alive === null ? (
                    <span className="agent-state">{t("Not this server's to say")}</span>
                  ) : w.alive ? (
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
