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
import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { type AgentStatus, fetchAgentAuditExport, saveAgentAddress } from "@/lib/agents";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { areaText, fleetReasonText } from "@/views/agent/agentText";
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
  // One part at a time: what the installation has, what it does per group,
  // what waits on a person, which models serve it and how it signs in are five
  // questions, and every surface on one page was a page nobody read.
  const [part, setPart] = useState<AgentPart>("overview");

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

      {part === "overview" && (
        <>
          <Registration status={status} />
          <Workers status={status} />
        </>
      )}
      {part === "groups" && (
        <>
          <GroupInstruction groups={status?.groups ?? []} />
          <RuleEditor groups={status?.groups ?? []} />
        </>
      )}
      {part === "approvals" && <AgentApprovals />}
      {part === "models" && <AgentProviders />}
      {part === "credentials" && <AppPasswordRotate />}
    </div>
  );
}

/**
 * The parts of the agent section, in the order a person asks about them.
 *
 * The section holds five unrelated jobs — the installation's agent and its
 * grants, a group's instruction and automations, the queue waiting on a person,
 * the model tiers, and the credential the worker signs in with — and they were
 * one page. Separated, each is a page that can be read.
 */
const AGENT_PARTS = [
  { id: "overview", label: "Overview" },
  { id: "groups", label: "Groups" },
  { id: "approvals", label: "Approvals" },
  { id: "models", label: "Models" },
  { id: "credentials", label: "Credentials" },
] as const;

type AgentPart = (typeof AGENT_PARTS)[number]["id"];

/* ------------------------------------------------------------------ */

function Registration({ status }: { status: AgentStatus | null }) {
  // The group whose trail is being copied, and what went wrong when something
  // did: the copy is one request with its own line to report it on.
  const [copying, setCopying] = useState<string | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);

  // The identity field is a draft: the status is the truth, the field is what
  // an administrator is typing, and saving is what makes them the same.
  const loadStatus = useAgents((s) => s.loadStatus);
  const [draft, setDraft] = useState(status?.address ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The accounts on this server, as suggestions.
   *
   * The agent is an ordinary account, and typing its address from memory is how
   * a typo becomes an agent that does nothing. A refused directory leaves the
   * list empty: the field still takes an address typed by hand.
   */
  const [accounts, setAccounts] = useState<string[]>([]);

  useEffect(() => {
    setDraft(status?.address ?? "");
  }, [status?.address]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch<{ users: Array<{ name: string }> }>(
          "/api/admin/users",
        );
        if (live) setAccounts(res.users.map((user) => user.name).filter(Boolean));
      } catch {
        /* suggestion only */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /** Name the agent, or clear the name and fall back to the deployment's. */
  async function save(address: string) {
    setSaving(true);
    setProblem(null);
    setSaved(false);
    try {
      await saveAgentAddress(address);
      setSaved(true);
      await loadStatus();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

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
              <label htmlFor="agent-address">{t("Agent address")}</label>
              <input
                id="agent-address"
                className="input notranslate"
                translate="no"
                list="agent-address-choices"
                placeholder="gilbert@example.com"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <datalist id="agent-address-choices">
                {accounts.map((account) => (
                  <option key={account} value={account} />
                ))}
              </datalist>
            </div>
            <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
              <button
                className="btn btn-primary"
                type="button"
                disabled={saving}
                onClick={() => void save(draft)}
              >
                {saving ? t("Saving…") : t("Save")}
              </button>
              {status.addressSource === "policy" && (
                <button
                  className="btn"
                  type="button"
                  disabled={saving}
                  onClick={() => void save("")}
                >
                  {t("Use the deployment's address")}
                </button>
              )}
              {saved && <span className="hint">{t("Saved.")}</span>}
            </div>
            <p className="hint">
              {status.addressSource === "policy"
                ? t(
                    "Named here, and in force from the next request: the installation records it, so it survives a restart.",
                  )
                : status.addressSource === "deployment"
                  ? t(
                      "Set by the deployment (GILBERT_AGENT_ADDRESS). Naming one here overrides it, for this product and for the worker.",
                    )
                  : t(
                      "Nothing names an agent yet: name one here, or set GILBERT_AGENT_ADDRESS where the installation is deployed.",
                    )}
            </p>
            <p className="hint">
              {t(
                "Gilbert acts as this address by impersonating it from your own administrator session, so this field needs no password. A worker signs in as it, with an app password deployed beside the address, and reads this one when it starts.",
              )}
            </p>
            {status.address && !status.hasSecret && (
              <div className="warn-box" style={{ marginBottom: 12 }}>
                {t(
                  "No app password for this address is deployed, so no worker can sign in as it: automations will not run until one is. The Credentials section mints one.",
                )}
              </div>
            )}
            {problem && (
              <div className="error-box" style={{ marginBottom: 12 }}>
                {problem}
              </div>
            )}
            {status.reason && <p className="hint">{fleetReasonText(status.reason)}</p>}
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
                  <th>{t("Audit trail")}</th>
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
                    <td>
                      <button
                        className="btn"
                        type="button"
                        disabled={copying === g.name}
                        onClick={() => void copyAudit(g.name)}
                      >
                        {copying === g.name ? t("Copying…") : t("Download as JSON")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {copyProblem && <p className="error-box">{copyProblem}</p>}
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
                  "The agent lost its grant on “{group}” on {when}: it served {areas} for that group until the pass noticed, and nothing has served it since.",
                  {
                    group: w.group || w.account,
                    when: formatListDate(w.at),
                    areas: w.heldAreas.length
                      ? w.heldAreas.map((a) => areaText(a)).join(", ")
                      : t("no area"),
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
