/**
 * The Gilbert admin "Master" section (ADR 0003 "Admin surfaces", restructured
 * by ADR 0003).
 *
 * The installation's own agent, the one model it runs on, the rules that hold
 * everywhere, and the groups it has been granted — configured once, and rarely
 * returned to. Everything that is a fact about *one* group (its automations,
 * its standing instruction, its policy, its memory, what it has done, the
 * agents serving it) lives in Group Agents instead; what is waiting across
 * every group lives in Approvals. This page answers four short questions in the
 * order a person asks them — is there an agent and how does it sign in, which
 * model serves it, what does it hold true everywhere, which groups does it work
 * in — as one page rather than tabs, because each answer is now short enough to
 * read at a glance.
 *
 * Nothing here grants anything, and nothing here names the agent. The
 * deployment names it in the environment it starts with, and a group's
 * membership is given in Stalwart's own administration; both are read back,
 * the groups through the agent's own session, which is the only witness to
 * membership there is. So this list follows Stalwart by itself and keeps no
 * record of its own to fall out of step.
 */
import { ArrowRight, Bot } from "lucide-react";
import { useEffect } from "react";
import { Link } from "wouter";
import type { AgentStatus } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { pollWhileVisible } from "@/lib/visiblePoll";
import { useAgents } from "@/store/agents";
import { fleetMeterLines, fleetReasonText, rosterText } from "@/views/agent/agentText";
import { AgentProviders } from "./agent/AgentProviders";
import { ProsePanel } from "./agent/ProsePanel";

/**
 * How often the fleet is re-read while this section is open.
 *
 * The one thing an administrator changes elsewhere is a group's membership in
 * Stalwart's own administration, and the surface has no way to hear about it:
 * a poll is what makes that change appear without a reload.
 */
const STATUS_POLL_MS = 30_000;

export function AdminAgents() {
  const status = useAgents((s) => s.status);
  // This section's own read: a save refused in another panel is that panel's
  // to report, and it has its own line here.
  const error = useAgents((s) => s.problems.status);
  const loadStatus = useAgents((s) => s.loadStatus);

  useEffect(() => {
    void loadStatus();
    /*
     * Membership is given in Stalwart's own administration, so the list has to
     * follow it without being asked: a modest poll while the section is open,
     * and a read on every return to the tab, which is the one signal a
     * backgrounded client is guaranteed to get. The policy lives once, in
     * `lib/visiblePoll.ts`.
     */
    return pollWhileVisible(() => void loadStatus(), STATUS_POLL_MS);
  }, [loadStatus]);

  return (
    <div>
      <h1>
        <Bot size={22} style={{ verticalAlign: "-3px", marginRight: 8 }} />
        {t("Master")}
      </h1>
      <p className="lead">
        {t(
          "Gilbert's own agent acts inside mail and file storage: it works on Stalwart events and on time schedules, in the groups it has been granted. This installation runs one agent — this is how to see it, which model serves it, and which groups it works in. What it does inside a group lives in Group Agents.",
        )}
      </p>
      {error && (
        <div className="error-box" style={{ marginBottom: 20 }}>
          {error}
        </div>
      )}

      <Identity status={status} />
      <section style={{ marginTop: 28 }}>
        <AgentProviders />
      </section>
      <section style={{ marginTop: 28 }}>
        <ProsePanel
          scope=""
          heading={t("Rules")}
          lead={t(
            "What holds everywhere: the rules the agent carries into every call of every group, before anything is true of a group or of one automation. Written once here instead of repeated in each group's instruction, and read as data — a run's permission is its own capability list, and nothing written here widens it.",
          )}
          label={t("How this installation's agent works")}
          placeholder={t(
            "Always answer in the language the message was written in, and never send anything outside the group without a person.",
          )}
          readingAbout={t("the installation's own rules")}
          canRead={false}
        />
      </section>
      <section style={{ marginTop: 28 }}>
        <Groups status={status} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Identity: the installation's own agent                              */
/* ------------------------------------------------------------------ */

function Identity({ status }: { status: AgentStatus | null }) {
  return (
    <section>
      <h2>{t("Identity")}</h2>
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
            <h3>{t("The Master")}</h3>
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
              holds — the fleet's own total, with the split per agent (ADR 0003). */}
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
          {/*
           * Whether a group's members can be read at all. It belongs here and
           * not in the chat: the chat is opened by every member and a member
           * cannot grant anything, while this line names the permission an
           * operator gives the Master — and it is empty where the installation
           * works as designed.
           */}
          {rosterText(status.roster) && (
            <p className="hint" style={{ marginTop: 12 }}>
              {rosterText(status.roster)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Groups: which groups the agent works in, read only                  */
/* ------------------------------------------------------------------ */

function Groups({ status }: { status: AgentStatus | null }) {
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
        <table className="sessions-table">
          <thead>
            <tr>
              <th>{t("Group")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.groups.map((g) => (
              <tr key={g.name}>
                <td className="notranslate" translate="no">
                  {g.name}
                </td>
                <td style={{ textAlign: "right" }}>
                  <Link
                    href={`/admin/group-agents?group=${encodeURIComponent(g.name)}`}
                    className="btn btn-sm btn-ghost"
                    title={t(
                      "Open this group's automations, standing instruction, memory and audit trail",
                    )}
                  >
                    {t("Open in Group Agents")} <ArrowRight size={14} />
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
