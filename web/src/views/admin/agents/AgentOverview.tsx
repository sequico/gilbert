import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useState } from "react";
import { type AgentStatus, fetchAgentStatus, fetchGroupRuns } from "@/lib/agentAdmin";
import { formatFullDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { metricsOf, type RunMetrics } from "./metrics";

/** Where the agent is, and what its runs have spent: the installation's numbers. */
export function AgentOverview({
  groups,
  facts,
}: {
  groups: readonly MailAccountInfo[];
  facts: number;
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [perGroup, setPerGroup] = useState<Array<{ name: string; metrics: RunMetrics }>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchAgentStatus(),
      Promise.all(
        groups.map(async (group) => ({
          name: group.name,
          metrics: metricsOf(await fetchGroupRuns(group.name)),
        })),
      ),
    ])
      .then(([agent, rows]) => {
        if (!live) return;
        setStatus(agent);
        setPerGroup(rows);
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [groups.map((group) => group.name).join("\n")]);

  const total = perGroup.reduce((sum, row) => add(sum, row.metrics), empty());

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <section>
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
        <div className="metrics-grid">
          <Metric label={t("Runs")} value={total.runs} />
          <Metric label={t("Steps")} value={total.steps} />
          <Metric label={t("Model calls")} value={total.calls} />
          <Metric label={t("Refused steps")} value={total.refused} />
          <Metric label={t("Work time")} value={formatMs(total.ms)} />
          <Metric label={t("Prompt tokens")} value={total.promptTokens} />
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
          <table className="table">
            <thead>
              <tr>
                <th>{t("Group")}</th>
                <th>{t("Runs")}</th>
                <th>{t("Model calls")}</th>
                <th>{t("Refused steps")}</th>
                <th>{t("Work time")}</th>
                <th>{t("Tokens")}</th>
                <th>{t("Running")}</th>
              </tr>
            </thead>
            <tbody>
              {perGroup.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.metrics.runs}</td>
                  <td>{row.metrics.calls}</td>
                  <td>{row.metrics.refused}</td>
                  <td>{formatMs(row.metrics.ms)}</td>
                  <td>{row.metrics.promptTokens + row.metrics.completionTokens}</td>
                  <td>{row.metrics.running}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
    refused: a.refused + b.refused,
    running: a.running + b.running,
    done: a.done + b.done,
    blocked: a.blocked + b.blocked,
    outOfBudget: a.outOfBudget + b.outOfBudget,
  };
}
