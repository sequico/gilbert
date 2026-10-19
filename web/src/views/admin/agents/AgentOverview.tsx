import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useMemo, useState } from "react";
import {
  type AgentStatus,
  fetchAgentStatus,
  fetchAgentSwitch,
  fetchGroupRuns,
  type RunListing,
  setAgentSwitch,
} from "@/lib/agentAdmin";
import { formatFullDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { Switch } from "@/ui/misc";
import { StopRun } from "./GroupRuns";
import { type MetricsPeriod, metricsOf, periodSince, type RunMetrics } from "./metrics";

/** Where the agent is, and what its runs have spent: the installation's numbers. */
export function AgentOverview({
  groups,
  facts,
}: {
  groups: readonly MailAccountInfo[];
  facts: number;
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [perGroup, setPerGroup] = useState<Array<{ name: string; runs: RunListing[] }>>(
    [],
  );
  const [period, setPeriod] = useState<MetricsPeriod>("week");
  const [on, setOn] = useState<boolean | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [live, setLive] = useState<Array<{ group: string; runs: RunListing[] }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAgentSwitch()
      .then((found) => setOn(found.enabled))
      .catch((err) => setSwitchError(errorMessage(err)));
  }, []);

  const groupKey = groups.map((group) => group.name).join("\n");

  /*
   * One reader for the page, two rhythms: the whole history every thirty
   * seconds (the numbers), and the runs in flight every three (the live list).
   * The running answer is a few rows, so a poll every three seconds does not
   * carry a year of documents.
   */
  useEffect(() => {
    let live = true;
    const fail = (err: unknown) => {
      if (live) setError(errorMessage(err));
    };
    const loadAll = async () => {
      const [agent, rows] = await Promise.all([
        fetchAgentStatus(),
        Promise.all(
          groups.map(async (group) => ({
            name: group.name,
            runs: await fetchGroupRuns(group.name),
          })),
        ),
      ]);
      if (!live) return;
      setStatus(agent);
      setPerGroup(rows);
      setError(null);
    };
    const loadRunning = async () => {
      const rows = await Promise.all(
        groups.map(async (group) => ({
          group: group.name,
          runs: await fetchGroupRuns(group.name, "running"),
        })),
      );
      if (!live) return;
      setLive(rows);
      setError(null);
    };
    void loadAll().catch(fail);
    void loadRunning().catch(fail);
    const full = window.setInterval(() => void loadAll().catch(fail), 30_000);
    const running = window.setInterval(() => void loadRunning().catch(fail), 3_000);
    return () => {
      live = false;
      window.clearInterval(full);
      window.clearInterval(running);
    };
  }, [groupKey]);

  const running = live
    .flatMap((entry) =>
      entry.runs
        .filter((listed) => listed.run?.state === "running")
        .map((listed) => ({ group: entry.group, listed })),
    )
    .sort((a, b) =>
      (b.listed.run?.startedAt ?? "").localeCompare(a.listed.run?.startedAt ?? ""),
    );

  // The numbers are over the history, which only the thirty-second read moves:
  // a live-row update must not walk every run again.
  const rows = useMemo(() => {
    const since = periodSince(period);
    return perGroup.map((row) => ({
      name: row.name,
      metrics: metricsOf(row.runs, since),
    }));
  }, [perGroup, period]);
  const total = useMemo(
    () => rows.reduce((sum, row) => add(sum, row.metrics), empty()),
    [rows],
  );

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      {switchError && <div className="error-box">{switchError}</div>}
      {running.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2>{t("Current runs")}</h2>
          <div style={{ display: "grid", gap: 6 }}>
            {running.map(({ group, listed }) => (
              <div key={`${group}:${listed.id}`} className="run-current">
                <span className="run-state run-state-running">{t("Running")}</span>
                <span className="run-row-id">{listed.id}</span>
                <span className="run-row-meta">{group}</span>
                {listed.run?.startedBy.rule && (
                  <span className="run-row-meta">{listed.run.startedBy.rule}</span>
                )}
                {listed.run?.startedBy.woke && (
                  <span className="run-row-meta">{listed.run.startedBy.woke}</span>
                )}
                <StopRun
                  group={group}
                  id={listed.id}
                  onStopped={() =>
                    setLive((held) =>
                      held.map((entry) =>
                        entry.group === group
                          ? {
                              ...entry,
                              runs: entry.runs.filter((one) => one.id !== listed.id),
                            }
                          : entry,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <Switch
          checked={on !== false}
          disabled={on === null}
          onChange={(next) => {
            setOn(next);
            setAgentSwitch(next).catch((err) => {
              setOn(!next);
              setSwitchError(errorMessage(err));
            });
          }}
          label={t("Agents on")}
        />
        {on === false && (
          <p className="hint">
            {t(
              "AI agents are turned off. No pass works anything and no model call is made.",
            )}
          </p>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t("Status")}</h2>
        <p className="hint">
          {status?.claim
            ? t("Held by {who} since {when}, and believed until {until}.", {
                who: status.claim.holder,
                when: formatFullDate(status.claim.takenAt),
                until: formatFullDate(status.claim.expires),
              })
            : t("Nobody holds it.")}
        </p>
        {status && (
          <p className="hint">{t("A pass every {n} s.", { n: status.passSeconds })}</p>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t("Work")}</h2>
        <div className="field" style={{ maxWidth: "34rem" }}>
          <span className="hint">{t("Period")}</span>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
            {(
              [
                ["day", t("Day")],
                ["week", t("Week")],
                ["month", t("Month")],
                ["all", t("All time")],
              ] as Array<[MetricsPeriod, string]>
            ).map(([id, label]) => (
              <label key={id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="radio"
                  name="agent-metrics-period"
                  value={id}
                  checked={period === id}
                  onChange={() => setPeriod(id)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="metrics-grid">
          <Metric label={t("Runs")} value={total.runs} />
          <Metric label={t("Steps")} value={total.steps} />
          <Metric label={t("Model calls")} value={total.calls} />
          <Metric label={t("Refused steps")} value={total.refused} />
          <Metric label={t("Work time")} value={formatMs(total.ms)} />
          <Metric label={t("Prompt tokens")} value={total.promptTokens} />
          <Metric label={t("Cached tokens")} value={total.cachedTokens} />
          <Metric
            label={t("Uncached tokens")}
            value={Math.max(0, total.promptTokens - total.cachedTokens)}
          />
          <Metric label={t("Completion tokens")} value={total.completionTokens} />
          <Metric label={t("Facts")} value={facts} />
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t("By group")}</h2>
        {perGroup.length === 0 && (
          <p className="hint">{t("No group mailbox in this session.")}</p>
        )}
        {perGroup.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>{t("Group")}</th>
                  <th className="num">{t("Runs")}</th>
                  <th className="num">{t("Model calls")}</th>
                  <th className="num">{t("Refused steps")}</th>
                  <th className="num">{t("Work time")}</th>
                  <th className="num">{t("Tokens")}</th>
                  <th className="num">{t("Running")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td className="num">{row.metrics.runs}</td>
                    <td className="num">{row.metrics.calls}</td>
                    <td className="num">{row.metrics.refused}</td>
                    <td className="num">{formatMs(row.metrics.ms)}</td>
                    <td className="num">
                      {row.metrics.promptTokens + row.metrics.completionTokens}
                    </td>
                    <td className="num">{row.metrics.running}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span className="hint">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Seconds when that is honest, minutes and hours when it is not. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function empty(): RunMetrics {
  return metricsOf([]);
}

function add(a: RunMetrics, b: RunMetrics): RunMetrics {
  return {
    runs: a.runs + b.runs,
    steps: a.steps + b.steps,
    calls: a.calls + b.calls,
    ms: a.ms + b.ms,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    refused: a.refused + b.refused,
    running: a.running + b.running,
  };
}
