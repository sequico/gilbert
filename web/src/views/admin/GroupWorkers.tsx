/**
 * What the worker does in each group (ADR 0003, ADR 0003).
 *
 * A group's agent work, in the order a person asks about it: which areas it
 * is narrowed to (Areas), the automations it runs there (Automations, moved
 * in from Agents — an automation is exactly a per-group thing), and what is
 * waiting on a person across every group (Approvals, moved in for the same
 * reason), and the workers themselves (Workers — a worker is a process of its
 * own, and the process list is where it becomes visible that one is not
 * reporting). The installation's own identity and its models stay in Agents;
 * this section is what the fleet does once it is working in a group.
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
import { AGENT_AREAS } from "@gilbert/agent/documents";
import { useEffect, useState } from "react";
import {
  type AgentStatus,
  type AgentStatusGroup,
  saveAgentGroupAreas,
} from "@/lib/agents";
import { formatListDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { areaText, fleetReasonText } from "@/views/agent/agentText";
import { AgentApprovals } from "./agent/AgentApprovals";
import { RuleEditor } from "./agent/RuleEditor";

const WORKER_PARTS = [
  { id: "areas", label: "Areas" },
  { id: "automations", label: "Automations" },
  { id: "approvals", label: "Approvals" },
  { id: "workers", label: "Workers" },
] as const;

type WorkerPart = (typeof WORKER_PARTS)[number]["id"];

export function GroupWorkers() {
  const status = useAgents((s) => s.status);
  const loadStatus = useAgents((s) => s.loadStatus);
  const [part, setPart] = useState<WorkerPart>("areas");

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <div>
      <h1>{t("Group workers")}</h1>
      <p className="lead">
        {t(
          "What the agent does inside each group it has been granted: the areas it is narrowed to, the automations it runs, what is waiting on a person, and the workers carrying them out. Grants and the installation's own identity live in Agents.",
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
      {part === "areas" && <Areas status={status} />}
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
/* Areas: which areas the worker is narrowed to, per group             */
/* ------------------------------------------------------------------ */

function Areas({ status }: { status: AgentStatus | null }) {
  const loadStatus = useAgents((s) => s.loadStatus);
  // What each group is narrowed to, as an editor's draft: the record is what
  // the status answers, this is what an administrator is changing, and saving
  // is what makes them agree.
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A group the agent is not in has no worker to narrow, so only the groups it
  // works in are offered here. Which ones those are, and how to add one, is the
  // Agents section's Groups tab; this table works from the same read.
  const groups = agentGroups(status);
  const deployment = status?.defaultAreas ?? [...AGENT_AREAS];
  const configured = (name: string): string[] =>
    groups.find((group) => group.name === name)?.areas ?? deployment;
  /** The draft of one group: its own narrowing, or everything the deployment serves. */
  const draftOf = (name: string): string[] => drafts[name] ?? configured(name);
  const touched = Object.keys(drafts);

  function edit(name: string, areas: string[]) {
    setDrafts((current) => ({ ...current, [name]: areas }));
    setSaved(false);
  }

  function toggleArea(name: string, area: string, on: boolean) {
    const current = draftOf(name);
    edit(name, on ? [...current, area] : current.filter((one) => one !== area));
  }

  function toggleSelected(name: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  /** Give every selected group the areas in the bulk bar, in one gesture. */
  function applyBulk() {
    if (!selected.size) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const name of selected) next[name] = [...bulk];
      return next;
    });
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setProblem(null);
    setSaved(false);
    try {
      // Only the groups somebody touched travel: a group nobody changed is not
      // a decision, and naming it would write one anyway.
      await saveAgentGroupAreas(
        Object.fromEntries(touched.map((name) => [name, drafts[name] ?? []])),
      );
      setDrafts({});
      setSaved(true);
      await loadStatus();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>{t("Areas")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "The areas below are the fleet's reach in each group the agent works in, and the deployment serves them all unless a group is narrowed. Only those groups are listed: add another to the Gilbert user in Stalwart's own administration and it appears here.",
        )}
      </p>
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : !status.operational ? (
        <div className="warn-box">
          {status.reason ? fleetReasonText(status.reason) : t("Not operational")}
        </div>
      ) : groups.length === 0 ? (
        <p className="hint">
          {t(
            "The agent is not in a group yet. Add a group to the Gilbert user in Stalwart's own administration, then narrow its areas here.",
          )}
        </p>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 12, marginBottom: 12 }}>
            <button
              className="btn"
              type="button"
              onClick={() => setSelected(new Set(groups.map((group) => group.name)))}
            >
              {t("Select all")}
            </button>
            <button className="btn" type="button" onClick={() => setSelected(new Set())}>
              {t("Select none")}
            </button>
            <span className="hint">{t("{n} selected", { n: selected.size })}</span>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-head">
              <h3>{t("Give the selected groups these areas")}</h3>
            </div>
            <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
              {AGENT_AREAS.map((area) => (
                <label key={area} className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={bulk.includes(area)}
                    onChange={(event) => {
                      setBulk((current) =>
                        event.target.checked
                          ? [...current, area]
                          : current.filter((one) => one !== area),
                      );
                      setSaved(false);
                    }}
                  />
                  {areaText(area)}
                </label>
              ))}
            </div>
            <button
              className="btn"
              type="button"
              disabled={!selected.size}
              onClick={applyBulk}
            >
              {selected.size
                ? t("Apply to {n} selected group(s)", { n: selected.size })
                : t("Select groups first")}
            </button>
            <p className="hint" style={{ marginTop: 8 }}>
              {t(
                'An empty selection of areas means the group is served as the deployment says; it never means "do nothing here".',
              )}
            </p>
          </div>

          <table className="sessions-table">
            <thead>
              <tr>
                <th />
                <th>{t("Group")}</th>
                <th>{t("Areas the worker serves here")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.name}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={group.name}
                      checked={selected.has(group.name)}
                      onChange={(event) =>
                        toggleSelected(group.name, event.target.checked)
                      }
                    />
                  </td>
                  <td className="notranslate" translate="no">
                    {group.name}
                  </td>
                  <td>
                    <div className="row wrap" style={{ gap: 10 }}>
                      {AGENT_AREAS.map((area) => (
                        <label key={area} className="row" style={{ gap: 4 }}>
                          <input
                            type="checkbox"
                            checked={draftOf(group.name).includes(area)}
                            onChange={(event) =>
                              toggleArea(group.name, area, event.target.checked)
                            }
                          />
                          {areaText(area)}
                          {!deployment.includes(area) && (
                            <span className="hint">{t("(not served here)")}</span>
                          )}
                        </label>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row wrap" style={{ gap: 12, marginTop: 12 }}>
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving || touched.length === 0}
              onClick={() => void save()}
            >
              {saving
                ? t("Saving…")
                : touched.length
                  ? t("Save {n} changed group(s)", { n: touched.length })
                  : t("Nothing changed")}
            </button>
            {touched.length > 0 && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setDrafts({});
                  setSaved(false);
                }}
              >
                {t("Discard changes")}
              </button>
            )}
            {saved && <span className="hint">{t("Saved.")}</span>}
          </div>
          {problem && (
            <div className="error-box" style={{ marginTop: 12 }}>
              {problem}
            </div>
          )}
          <p className="hint" style={{ marginTop: 12 }}>
            {t(
              "The worker reads this record when it starts, so a change reaches automations at the next restart of the worker; this surface reads it immediately.",
            )}
          </p>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Workers: the fleet's own heartbeat                                  */
/* ------------------------------------------------------------------ */

/**
 * Which workers are serving this installation, and whether they still are.
 *
 * A worker is its own process, not a copy of the web tier: it claims the areas
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
