import { errorMessage } from "@gilbert/shared/errors";
import { byRecency, isInFlight } from "@gilbert/shared/run";
import { useEffect, useMemo, useState } from "react";
import { push } from "@/jmap/push";
import {
  type AgentStatus,
  type FactView,
  fetchAgentMetrics,
  fetchAgentStatus,
  fetchAgentSwitch,
  fetchGroupRuns,
  type RunSummary,
  setAgentSwitch,
} from "@/lib/agentAdmin";
import { formatFullDate, formatMs } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { Switch } from "@/ui/misc";
import { RUN_STATE_LABELS } from "@/views/admin/agent/RunCard";
import { RunDetail, StopAll, StopRun } from "./GroupRuns";
import {
  addMetrics,
  emptyMetrics,
  type MetricsPeriod,
  periodSince,
  type RunMetrics,
} from "./metrics";

/** Where the agent is, and what its runs have spent: the installation's numbers. */
export function AgentOverview({
  groups,
  facts,
  memory,
}: {
  groups: readonly MailAccountInfo[];
  facts: number;
  /** The memory's own list, so a run's recounted facts are drawn by their sheet. */
  memory: readonly FactView[];
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [perGroup, setPerGroup] = useState<Array<{ name: string; metrics: RunMetrics }>>(
    [],
  );
  const [period, setPeriod] = useState<MetricsPeriod>("day");
  const [on, setOn] = useState<boolean | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [live, setLive] = useState<Array<{ group: string; runs: RunSummary[] }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAgentSwitch()
      .then((found) => setOn(found.enabled))
      .catch((err) => setSwitchError(errorMessage(err)));
  }, []);

  const groupKey = groups.map((group) => `${group.name}:${group.accountId}`).join("\n");

  /*
   * One reader for the page, two rhythms: the whole history every sixty
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
      /*
       * The numbers are the server's tally, not every run downloaded and added
       * here: a group's history grows with the installation, and sixty seconds
       * was re-reading a year of documents for ten totals.
       */
      const [agent, metrics] = await Promise.all([
        fetchAgentStatus(),
        fetchAgentMetrics(
          groups.map((group) => group.name),
          periodSince(period)?.toISOString(),
        ),
      ]);
      if (!live) return;
      setStatus(agent);
      setPerGroup(metrics.groups);
      setError(null);
    };
    const loadRunning = async () => {
      const rows = await Promise.all(
        groups.map(async (group) => ({
          group: group.name,
          runs: await fetchGroupRuns(group.name, "live"),
        })),
      );
      if (!live) return;
      setLive(rows);
      setError(null);
    };
    void loadAll().catch(fail);
    void loadRunning().catch(fail);
    const full = window.setInterval(() => void loadAll().catch(fail), 60_000);
    /*
     * The runs in flight follow the stream: a FileNode change in a group's
     * account asks for them after a second of coalescing, and the ten-second
     * poll is the safety net for a stream that is down.
     */
    let scheduled: number | null = null;
    const scheduleRunning = () => {
      if (scheduled !== null) return;
      scheduled = window.setTimeout(() => {
        scheduled = null;
        void loadRunning().catch(fail);
      }, 1_000);
    };
    const stopPush = push.subscribe((changed, type) => {
      if (type !== "FileNode") return;
      if (!groups.some((group) => group.accountId === changed)) return;
      scheduleRunning();
    });
    const running = window.setInterval(() => void loadRunning().catch(fail), 10_000);
    return () => {
      live = false;
      window.clearInterval(full);
      window.clearInterval(running);
      stopPush();
      if (scheduled !== null) window.clearTimeout(scheduled);
    };
  }, [groupKey, period]);

  const running = live
    .flatMap((entry) =>
      entry.runs
        .filter((listed) => listed.state != null && isInFlight(listed.state))
        .map((listed) => ({ group: entry.group, listed })),
    )
    .sort((a, b) => byRecency(a.listed, b.listed));

  /** The runs in flight, under the group each belongs to, in the table's order. */
  const inFlight = groups
    .map((group) => ({
      group: group.name,
      rows: running.filter((one) => one.group === group.name),
    }))
    .filter((entry) => entry.rows.length > 0);

  // The numbers are over the history, which only the sixty-second read moves:
  // a live-row update must not walk every run again.
  const rows = perGroup;
  const total = useMemo(
    () => perGroup.reduce((sum, row) => addMetrics(sum, row.metrics), emptyMetrics()),
    [perGroup],
  );

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      {switchError && <div className="error-box">{switchError}</div>}
      {/*
       * One line for the switch and where the agent stands: two sections for
       * one question spent a heading and a screen of white space on it.
       */}
      <section
        className="row"
        style={{ gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}
      >
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
        <span className="hint">
          {status?.claim
            ? t("Held by {who} since {when}, and believed until {until}.", {
                who: status.claim.holder,
                when: formatFullDate(status.claim.takenAt),
                until: formatFullDate(status.claim.expires),
              })
            : t("Nobody holds the agent.")}
          {status ? ` ${t("A pass every {n} s.", { n: status.passSeconds })}` : ""}
        </span>
      </section>
      {/*
       * What the pump did, on its own line: a pass is not an event and the log
       * does not carry one, so without this an agent that is working and one that
       * has stopped look the same. The last ending is the answer to "what was its
       * last act" without opening a group's list; its sentence is the hover.
       *
       * A document that is there and cannot be read is not "no pass has run":
       * saying so is the one answer the document exists to give.
       */}
      {status?.lastPassProblem && (
        <p className="hint" style={{ marginTop: 0 }}>
          {status.lastPassProblem}
        </p>
      )}
      {status?.lastPass && (
        <p className="hint" style={{ marginTop: 0 }}>
          {t(
            "The last pass was at {when}: {changes} changes, {runs} runs and {due} due, in {ms} ms.",
            {
              when: formatFullDate(status.lastPass.at),
              changes: status.lastPass.changes,
              runs: status.lastPass.runs,
              due: status.lastPass.due,
              ms: status.lastPass.ms,
            },
          )}
          {status.lastPass.gaps.length
            ? ` ${t("It could not cover: {gaps}", {
                gaps: status.lastPass.gaps.join("; "),
              })}`
            : ""}
          {status.lastPass.lastEnded ? (
            <span title={status.lastPass.lastEnded.why}>
              {" "}
              {t("Last run ended: {ending} ({id}).", {
                ending: t(RUN_STATE_LABELS[status.lastPass.lastEnded.ending]),
                id: status.lastPass.lastEnded.id.slice(0, 8),
              })}
            </span>
          ) : (
            ""
          )}
        </p>
      )}
      {on === false && (
        <p className="hint">
          {t(
            "AI agents are turned off. No pass works anything and no model call is made.",
          )}
        </p>
      )}

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
          <Metric label={t("Steps taken")} value={total.steps} />
          <Metric label={t("Model calls")} value={total.calls} />
          <Metric label={t("Failed steps")} value={total.failed} />
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
                  <th className="num">{t("Failed steps")}</th>
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
                    <td className="num">{row.metrics.failed}</td>
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

      {/*
       * What is being worked, under the numbers it is counted in: a run that is
       * moving or waiting on a person is the one thing a reader of this page can
       * act on, and stopping it is that act.
       */}
      {inFlight.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2>{t("Runs in flight")}</h2>
          {inFlight.map((entry) => (
            <div key={entry.group} style={{ marginBottom: 16 }}>
              <div className="run-group-head">
                <h3 style={{ margin: "8px 0 6px" }}>{entry.group}</h3>
                <StopAll
                  group={entry.group}
                  onStopped={(answer) =>
                    /*
                     * Only the rows the server says it closed leave the list: a
                     * sweep can leave one moving, and a page that blanked the
                     * group would be claiming an outcome nobody observed. The
                     * next read settles whatever is left.
                     */
                    setLive((held) =>
                      held.map((row) =>
                        row.group === entry.group
                          ? {
                              ...row,
                              runs: row.runs.filter(
                                (listed) => !answer.runs.includes(listed.id),
                              ),
                            }
                          : row,
                      ),
                    )
                  }
                />
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {entry.rows.map(({ listed }) => (
                  <LiveRunCard
                    key={listed.id}
                    group={entry.group}
                    listed={listed}
                    memory={memory}
                    onStopped={() =>
                      setLive((held) =>
                        held.map((row) =>
                          row.group === entry.group
                            ? {
                                ...row,
                                runs: row.runs.filter((one) => one.id !== listed.id),
                              }
                            : row,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * One run in flight, as a row that opens the same document the group's history
 * opens: the plan with the step it is on, the tally and what it has touched.
 *
 * The document is read when the row is opened and not before: a collapsed row
 * costs the header the list already carries, so a page watching six running runs
 * does not fetch six records on every poll.
 */
function LiveRunCard({
  group,
  listed,
  memory,
  onStopped,
}: {
  group: string;
  listed: RunSummary;
  memory: readonly FactView[];
  onStopped: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="run-current"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={`run-state run-state-${listed.state}`}>
          {listed.state && t(RUN_STATE_LABELS[listed.state])}
        </span>
        <span className="run-row-id">{listed.id}</span>
        {listed.startedAt && (
          <span className="run-row-meta">{formatFullDate(listed.startedAt)}</span>
        )}
        <StopRun group={group} id={listed.id} onStopped={onStopped} />
        {/*
         * Why the run exists, in the words of the thing that woke it, and who set
         * it off: the header a person reads before deciding whether to stop it.
         */}
        {(listed.about ?? listed.woke) && (
          <span
            className="hint"
            style={{ margin: "4px 0 0", flexBasis: "100%", display: "block" }}
            title={listed.about ?? listed.woke ?? undefined}
          >
            {listed.by
              ? t("{what} — from {who}", {
                  what: listed.about ?? listed.woke ?? "",
                  who: listed.by,
                })
              : (listed.about ?? listed.woke)}
          </span>
        )}
      </summary>
      <div className="run-current-body">
        {open && (
          <RunDetail
            group={group}
            id={listed.id}
            month=""
            facts={memory}
            version={`${listed.state}:${listed.steps}:${listed.spent.calls}:${listed.spent.ms}:${listed.failed}:${listed.ended?.at ?? ""}`}
          />
        )}
      </div>
    </details>
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
