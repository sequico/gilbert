/**
 * The Gilbert admin "Agents" section (ADR 0003 "Admin surfaces").
 *
 * Everything about the agent fleet that a person has to see, in the order the
 * ADR names it: whether the installation has an agent and which groups have
 * granted it, which workers are running, what each group's automations do,
 * which model serves each tier, what is waiting for a person, and the one
 * secret that lets a worker sign in.
 *
 * Nothing here grants anything. The agent is a principal in Stalwart's own
 * directory and its membership of a group is granted in Stalwart's own
 * administration, so this section **verifies** the grant — a group without it
 * shows what that costs instead of a control that could not work.
 */
import { Bot } from "lucide-react";
import { useEffect } from "react";
import type { AgentStatus } from "@/lib/agents";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { areaText } from "@/views/agent/agentText";
import { AgentApprovals } from "./agent/AgentApprovals";
import { AgentProviders } from "./agent/AgentProviders";
import { AppPasswordRotate } from "./agent/AppPasswordRotate";
import { GroupInstruction } from "./agent/GroupInstruction";
import { RuleEditor } from "./agent/RuleEditor";

export function AdminAgents() {
  const status = useAgents((s) => s.status);
  // This section's own read: a save refused in another panel is that panel's
  // to report, and it has its own line here.
  const error = useAgents((s) => s.problems.status);
  const loadStatus = useAgents((s) => s.loadStatus);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <div>
      <h1>
        <Bot size={22} style={{ verticalAlign: "-3px", marginRight: 8 }} />
        {t("Agents")}
      </h1>
      <p className="lead">
        {t(
          "Gilbert's own agents act inside mail and file storage: they work on Stalwart events and on time schedules, in the groups they have been granted. This installation runs one agent, and what follows is how to see it, what each group's automations do, and how it signs in.",
        )}
      </p>
      {error && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <Registration status={status} />
      <Workers status={status} />
      <GroupInstruction groups={status?.groups ?? []} />
      <RuleEditor groups={status?.groups ?? []} />
      <AgentProviders />
      <AgentApprovals />
      <AppPasswordRotate />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Registration({ status }: { status: AgentStatus | null }) {
  return (
    <section>
      <h2>{t("Registration")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "This section checks the agent's grant, it never writes it: membership of a group is granted in Stalwart's own administration, beside the accounts, the same way a person's is.",
        )}
      </p>
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : (
        <>
          <div className="card agent-registration">
            <div className="card-head">
              <h3>{t("The installation's agent")}</h3>
              <span className={status.configured ? "agent-state ok" : "agent-state off"}>
                {status.configured ? t("Registered") : t("Not registered")}
              </span>
            </div>
            <div className="field" style={{ maxWidth: 380 }}>
              <label htmlFor="agent-address">{t("Address")}</label>
              <input
                id="agent-address"
                className="input notranslate"
                translate="no"
                value={status.address ?? ""}
                readOnly
              />
            </div>
            <p className="hint">
              {status.configured
                ? t(
                    "The worker opens its session as this address. Its reach is exactly the groups granted to it, nothing else.",
                  )
                : t(
                    "The deployment carries no agent address yet, so no worker can start. Set it where the installation is deployed, then reload this section.",
                  )}
            </p>
            {status.reason && <p className="hint">{status.reason}</p>}
          </div>
          <h3>{t("Groups")}</h3>
          {status.groups.length === 0 ? (
            <p className="hint">{t("No group mailbox is visible to this session.")}</p>
          ) : (
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>{t("Group")}</th>
                  <th>{t("Agent")}</th>
                  <th>{t("What that means")}</th>
                </tr>
              </thead>
              <tbody>
                {status.groups.map((g) => (
                  <tr key={g.name}>
                    <td className="notranslate" translate="no">
                      {g.name}
                    </td>
                    <td>
                      {g.granted ? (
                        <span className="agent-state ok">{t("Granted")}</span>
                      ) : (
                        <span className="agent-state off">{t("Not granted")}</span>
                      )}
                    </td>
                    <td className="hint">
                      {g.granted
                        ? t(
                            "The agent is in this group: it appears in the group's chat and its automations run here.",
                          )
                        : t(
                            "The agent is not in this group: nobody can mention it in the group's chat and no automation runs for it. Grant it in Stalwart's own administration to change that.",
                          )}
                    </td>
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

/* ------------------------------------------------------------------ */

function Workers({ status }: { status: AgentStatus | null }) {
  return (
    <section>
      <h2>{t("Workers")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "A worker is its own process, not a copy of the web tier: it claims the areas it serves by lease and writes a heartbeat while it runs. Nothing here starts or stops one — workers are declared where the installation is deployed.",
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
              <th>{t("Areas")}</th>
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
                <td>{w.areas.map((a) => areaText(a)).join(", ")}</td>
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
    </section>
  );
}
