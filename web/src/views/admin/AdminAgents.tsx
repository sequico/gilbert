/**
 * The Gilbert admin "Agents" section (ADR 0003 "Admin surfaces").
 *
 * The installation's own agent, the one model it runs on, and what the fleet
 * has spent live here, split into three questions asked in the order a person
 * actually asks them: is there an agent and how does it sign in (Overview),
 * which model serves it (Model) — the installation's own configuration, settled
 * once — and which groups it works in and what each one tells it (Groups), last
 * because it follows Stalwart's directory rather than anything written here.
 * What a group's agent actually *does* — its automations, the approvals waiting
 * on a person, the facts it remembers, and the agents serving them — lives in
 * Group Agents instead: that section already reads one group at a time, and an
 * automation is exactly that.
 *
 * Nothing here grants anything, and nothing here names the agent. The
 * deployment names it in the environment it starts with, and a group's
 * membership is given in Stalwart's own administration; both are read back,
 * the groups through the agent's own session, which is the only witness to
 * membership there is. So this list follows Stalwart by itself and keeps no
 * record of its own to fall out of step.
 */
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { type AgentStatus, fetchAgentAuditExport } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { fleetMeterLines, fleetReasonText } from "@/views/agent/agentText";
import { AgentProviders } from "./agent/AgentProviders";
import { GroupInstruction } from "./agent/GroupInstruction";
import { GroupMemory } from "./agent/GroupMemory";

export function AdminAgents() {
  const status = useAgents((s) => s.status);
  // This section's own read: a save refused in another panel is that panel's
  // to report, and it has its own line here.
  const error = useAgents((s) => s.problems.status);
  const loadStatus = useAgents((s) => s.loadStatus);
  // One part at a time: the installation's own health, which models serve each
  // tier, and what each group has granted and told it are three questions, and
  // every surface on one page was a page nobody read.
  const [part, setPart] = useState<AgentPart>("overview");

  useEffect(() => {
    void loadStatus();
    /*
     * Membership is given in Stalwart's own administration, so the list has to
     * follow it without being asked: a modest poll while the section is open,
     * and a read on every return to the tab, which is the one signal a
     * backgrounded client is guaranteed to get.
     */
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadStatus();
    }, STATUS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadStatus]);

  return (
    <div>
      <h1>
        <Bot size={22} style={{ verticalAlign: "-3px", marginRight: 8 }} />
        {t("Agents")}
      </h1>
      <p className="lead">
        {t(
          "Gilbert's own agent acts inside mail and file storage: it works on Stalwart events and on time schedules, in the groups it has been granted. This installation runs one agent — this is how to see it, which groups it works in, which models serve it, and how it signs in.",
        )}
      </p>
      {error && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div
        className="segmented"
        role="group"
        aria-label={t("Agent sections")}
        style={{ marginBottom: 16 }}
      >
        {AGENT_PARTS.map((entry) => (
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

      {part === "overview" && <Registration status={status} />}
      {part === "models" && <AgentProviders />}
      {part === "groups" && <Groups status={status} />}
    </div>
  );
}

/**
 * The parts of the agent section, in the order a person asks about them.
 */
const AGENT_PARTS = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "groups", label: "Groups" },
] as const;

type AgentPart = (typeof AGENT_PARTS)[number]["id"];

/**
 * How often the fleet is re-read while this section is open.
 *
 * The one thing an administrator changes elsewhere is a group's membership in
 * Stalwart's own administration, and the surface has no way to hear about it:
 * a poll is what makes that change appear without a reload.
 */
const STATUS_POLL_MS = 30_000;

/* ------------------------------------------------------------------ */
/* Overview: the installation's own agent                             */
/* ------------------------------------------------------------------ */

function Registration({ status }: { status: AgentStatus | null }) {
  return (
    <section>
      <h2>{t("The Master")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "This section checks the agent's grant, it never writes it: membership of a group is granted in Stalwart's own administration, beside the accounts, the same way a person's is.",
        )}
      </p>
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : (
        <div className="card agent-registration">
          <div className="card-head">
            <h3>{t("Identity")}</h3>
            <span className={status.operational ? "agent-state ok" : "agent-state off"}>
              {status.operational ? t("Operational") : t("Not operational")}
            </span>
          </div>
          <div className="field">
            <span className="hint">{t("Agent address")}</span>
            <p className="mono notranslate" translate="no" style={{ margin: 0 }}>
              {status.address || t("None")}
            </p>
          </div>
          <p className="hint" style={{ marginTop: 12 }}>
            {t(
              "The deployment names the agent and this reads it back: GILBERT_AGENT_ADDRESS and GILBERT_AGENT_PASSWORD live in the environment of whoever starts the server and its agent, so there is one place they come from. Nothing here mints a secret, reads one back, or stores one.",
            )}
          </p>
          {/* What the installation has spent, read from every group the agent
              holds — the fleet's own total, with the split per agent (ADR
              0010). */}
          {status.operational && (
            <div className="field" style={{ marginTop: 12 }}>
              <span className="hint">{t("What the fleet has spent")}</span>
              {fleetMeterLines(status.meter).map((line) => (
                <p key={line} className="hint" style={{ margin: 0 }}>
                  {line}
                </p>
              ))}
            </div>
          )}
          {!status.operational && status.reason && (
            <div className="error-box" style={{ marginTop: 12 }}>
              {fleetReasonText(status.reason)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Groups: which groups the agent works in, and what each one tells it */
/* ------------------------------------------------------------------ */

function Groups({ status }: { status: AgentStatus | null }) {
  // The group whose trail is being copied, and what went wrong when something
  // did: the copy is one request with its own line to report it on.
  const [copying, setCopying] = useState<string | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);

  /**
   * Take the copy of a group's audit trail, as JSON named for the group.
   *
   * Nothing is kept here: the file is the group's own documents, handed over
   * so an administrator holds them before the oldest month is pruned.
   */
  async function copyAudit(name: string) {
    setCopying(name);
    setCopyProblem(null);
    try {
      const trail = await fetchAgentAuditExport(name);
      const blob = new Blob([JSON.stringify(trail, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name.replace(/[^\w.-]+/g, "_")}.audit.json`;
      a.click();
    } catch (err) {
      setCopyProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setCopying(null);
    }
  }

  return (
    <section>
      <h2>{t("Groups")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "The groups the agent works in, read from Stalwart: it is a member of a group exactly when the group appears here, and this list follows the directory on its own. To give it a group, add the group to the Gilbert user in Stalwart's own administration.",
        )}
      </p>
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : status.groups.length === 0 ? (
        <p className="hint">
          {t(
            "The agent is not in a group this installation can see. Add a group to the Gilbert user in Stalwart's own administration and it appears here.",
          )}
        </p>
      ) : (
        <>
          <table className="sessions-table" style={{ marginBottom: 20 }}>
            <thead>
              <tr>
                <th>{t("Group")}</th>
                <th>{t("What that means")}</th>
                <th>{t("Audit trail")}</th>
              </tr>
            </thead>
            <tbody>
              {status.groups.map((g) => (
                <tr key={g.name}>
                  <td className="notranslate" translate="no">
                    {g.name}
                  </td>
                  <td className="hint">
                    {t(
                      "The agent is in this group: it appears in the group's chat and its automations run here.",
                    )}
                  </td>
                  <td>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={copying === g.name}
                      onClick={() => void copyAudit(g.name)}
                      title={t(
                        "Download every retained month of this group's audit trail as JSON",
                      )}
                    >
                      {copying === g.name ? t("Copying…") : t("Download as JSON")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {copyProblem && (
            <p className="error-box" style={{ marginBottom: 20 }}>
              {copyProblem}
            </p>
          )}
          <GroupInstruction groups={status.groups.map((g) => g.name)} />
          <GroupMemory groups={status.groups.map((g) => g.name)} />
        </>
      )}
    </section>
  );
}
