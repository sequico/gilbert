import { errorMessage } from "@gilbert/shared/errors";
import { useCallback, useEffect, useRef, useState } from "react";
import { push } from "@/jmap/push";
import {
  type FactDoc,
  fetchAgentMetrics,
  fetchGroupArchive,
  fetchGroupRuns,
  fetchGroupRunsPage,
  fetchRun,
  type RunListing,
  type RunMetrics,
  type RunSummary,
  stopRun,
} from "@/lib/agentAdmin";
import { t } from "@/lib/i18n";
import { RUN_STATE_LABELS, RunCard } from "@/views/admin/agent/RunCard";
import { metricsOf, sameRunHeader } from "./metrics";

/** How many runs one page of the listing shows, one row each. */
const RUNS_PAGE = 10;
/** How many runs one server page carries: five pages of the ten drawn. */
const RUNS_PAGE_SERVER = RUNS_PAGE * 5;

/**
 * Stop one run, and say where it is drawn whether the stop took.
 *
 * One button for both surfaces that offer it — the group's runs and the
 * installation's current runs — because stopping a run is one action with one
 * refusal, not two spellings of it.
 */
export function StopRun({
  group,
  id,
  onStopped,
}: {
  group: string;
  id: string;
  onStopped?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setBusy(true);
          setError(null);
          void stopRun(group, id)
            .then(() => onStopped?.())
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        {t("Stop")}
      </button>
      {error && <span className="hint">{error}</span>}
    </>
  );
}

/**
 * The document behind one row, read when the row opens.
 *
 * The listing carries the header alone — a year of plans and outcomes is not
 * what a list draws — so the full record is one request for the one row a
 * person asks about, working set or archived drawer.
 */
function RunDetail({
  group,
  id,
  month,
  facts,
  version,
}: {
  group: string;
  id: string;
  month: string;
  facts: readonly FactDoc[];
  /** The row's header, so a running run's open detail follows the poll. */
  version: string;
}) {
  const [listed, setListed] = useState<RunListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    void fetchRun(group, id, month || undefined)
      .then((one) => {
        if (alive) setListed(one);
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [group, id, month, version]);
  if (error) return <div className="error-box">{error}</div>;
  if (!listed) return <p className="hint">{t("Loading…")}</p>;
  return <RunCard listed={listed} facts={facts} />;
}

/** One row of the listing: its header, and its document when it opens. */
function RunRow({
  group,
  row,
  month,
  facts,
  onStopped,
}: {
  group: string;
  row: RunSummary;
  month: string;
  facts: readonly FactDoc[];
  onStopped: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="run-row" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="run-row-id">{row.id}</span>
        <span className={`run-state run-state-${row.problem ? "unreadable" : row.state}`}>
          {row.problem || !row.state ? t("Not readable") : t(RUN_STATE_LABELS[row.state])}
        </span>
        {row.problem && <span className="run-row-meta">{row.problem}</span>}
        {row.rule && <span className="run-row-meta">{row.rule}</span>}
        {row.state && (
          <span className="run-row-meta">
            {t("{steps} steps · {calls} calls", {
              steps: row.spent.steps,
              calls: row.spent.calls,
            })}
          </span>
        )}
        {!month && row.state === "running" && (
          <StopRun group={group} id={row.id} onStopped={onStopped} />
        )}
      </summary>
      <div className="run-row-body">
        {open &&
          (row.problem ? (
            <div className="error-box">{row.problem}</div>
          ) : (
            <RunDetail
              group={group}
              id={row.id}
              month={month}
              facts={facts}
              version={`${row.state}:${row.steps}:${row.spent.calls}:${row.spent.ms}:${row.refused}:${row.ended?.at ?? ""}`}
            />
          ))}
      </div>
    </details>
  );
}

/** The runs one group has worked, as its own account carries them. */
export function GroupRuns({
  group,
  accountId,
  facts,
  live = false,
}: {
  group: string;
  /** The group's own account, for the push stream that wakes the live list. */
  accountId?: string;
  facts: readonly FactDoc[];
  /** Keep the list current while it is on screen, for a run still in flight. */
  live?: boolean;
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  /** A month of the archive to read instead of the working set, or "". */
  const [month, setMonth] = useState("");
  /** The runs in flight at the last poll: a different set means the list moved. */
  const runningIds = useRef("");
  /** Whether the server holds more runs after the list in hand. */
  const [more, setMore] = useState(false);
  /** The month's cursor: the last row drawn, as the server named it. */
  const cursor = useRef<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** The group's whole tally, computed by the server over every run it holds. */
  const [totals, setTotals] = useState<RunMetrics | null>(null);

  const load = useCallback(async () => {
    try {
      const page = month
        ? await fetchGroupArchive(group, month)
        : await fetchGroupRunsPage(group, { offset: 0, limit: RUNS_PAGE_SERVER });
      setRuns(page.runs);
      setMore(page.more);
      cursor.current = month ? page.after : null;
      setError(null);
      /*
       * The tally is the server's whole one, and it is an administrator's read:
       * this panel is drawn in a member's chat too, where the route refuses it.
       * A member's list still loads, and the line falls back to what is drawn.
       */
      try {
        const metrics = await fetchAgentMetrics([group]);
        setTotals(metrics.groups[0]?.metrics ?? null);
      } catch {
        setTotals(null);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [group, month]);

  /** The next server page, appended to the list in hand. */
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (loadingMore) return false;
    setLoadingMore(true);
    try {
      const page = month
        ? await fetchGroupArchive(group, month, cursor.current)
        : await fetchGroupRunsPage(group, {
            offset: runs?.length ?? 0,
            limit: RUNS_PAGE_SERVER,
          });
      setRuns((held) => [...(held ?? []), ...page.runs]);
      setMore(page.more);
      if (month) cursor.current = page.after;
      setError(null);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setLoadingMore(false);
    }
  }, [group, loadingMore, month, runs?.length]);

  useEffect(() => {
    let alive = true;
    setRuns(null);
    setError(null);
    setPage(0);
    setMore(false);
    setLoadingMore(false);
    cursor.current = null;
    setTotals(null);
    runningIds.current = "";
    void load();
    if (!live || month)
      return () => {
        alive = false;
      };
    /*
     * The poll asks for the runs in flight alone. While the set is unchanged,
     * their fresh headers are merged into the list; when a run starts or ends
     * the set moved, and the one full read keeps the page and the numbers true.
     */
    const poll = () => {
      void (async () => {
        try {
          const running = await fetchGroupRuns(group, "running");
          if (!alive) return;
          const ids = running
            .map((one) => one.id)
            .sort()
            .join(",");
          setError(null);
          if (ids !== runningIds.current) {
            runningIds.current = ids;
            await load();
            return;
          }
          setRuns((held) => {
            if (!held) return running;
            const fresh = new Map(running.map((one) => [one.id, one]));
            let changed = false;
            const next = held.map((one) => {
              const now = fresh.get(one.id);
              if (!now || sameRunHeader(now, one)) return one;
              changed = true;
              return now;
            });
            // The same list is the same array: a poll that found nothing does
            // not re-render the page or recompute its numbers.
            return changed ? next : held;
          });
        } catch (err) {
          if (alive) setError(errorMessage(err));
        }
      })();
    };
    /*
     * The stream is the clock and the interval is the safety net: a FileNode
     * change in the group's account asks for the runs in flight, with a second
     * of coalescing for the agent's own writes, and the ten-second poll keeps
     * the panel honest if the stream is down.
     */
    const fallback = window.setInterval(poll, 10_000);
    let scheduled: number | null = null;
    const stopPush = accountId
      ? push.subscribe((changed, type) => {
          if (!alive || type !== "FileNode" || changed !== accountId) return;
          if (scheduled !== null) return;
          scheduled = window.setTimeout(() => {
            scheduled = null;
            poll();
          }, 1_000);
        })
      : () => {};
    return () => {
      alive = false;
      window.clearInterval(fallback);
      stopPush();
      if (scheduled !== null) window.clearTimeout(scheduled);
    };
  }, [accountId, load, live, month]);

  // The numbers are the server's tally over every run the group holds, not the
  // page drawn: a list of fifty is not the group's history. A member's chat
  // cannot ask for that tally, so it falls back to the runs it was given.
  const metrics = totals ?? (runs ? metricsOf(runs) : null);
  /*
   * Most recent first, by the instant the run was opened (or, for a document
   * written before that field existed, when it ended). A live list is about what
   * is happening: the runs in flight sit above the history, each group in the
   * same order.
   */
  const whenOf = (listed: RunSummary) => listed.startedAt ?? listed.ended?.at ?? "";
  const sorted = [...(runs ?? [])].sort((a, b) => whenOf(b).localeCompare(whenOf(a)));
  const ordered = live
    ? [
        ...sorted.filter((one) => one.state === "running"),
        ...sorted.filter((one) => one.state !== "running"),
      ]
    : sorted;
  const pages = Math.max(1, Math.ceil(ordered.length / RUNS_PAGE));
  /*
   * A poll can reload a shorter list (a run ended, or an archive month changed):
   * the page the reader was on may no longer exist. It is clamped rather than
   * left on an empty page, and the clamp is an effect so the render that first
   * sees the shorter list still uses the old page for one frame.
   */
  useEffect(() => {
    setPage((current) => Math.min(current, pages - 1));
  }, [pages]);
  const shown = ordered.slice(page * RUNS_PAGE, page * RUNS_PAGE + RUNS_PAGE);

  return (
    <section>
      <h2>{t("Runs")}</h2>
      {metrics && (
        <p className="hint">
          {t(
            "{runs} runs · {calls} model calls · {refused} refused steps · {tokens} tokens",
            {
              runs: metrics.runs,
              calls: metrics.calls,
              refused: metrics.refused,
              tokens: metrics.promptTokens + metrics.completionTokens,
            },
          )}
        </p>
      )}
      <label className="run-archive">
        <span className="hint">{t("Archived")}</span>
        <input
          type="month"
          value={month}
          aria-label={t("Archived")}
          onChange={(event) => setMonth(event.target.value)}
        />
        {month && (
          <button type="button" className="btn btn-ghost" onClick={() => setMonth("")}>
            {t("Current runs")}
          </button>
        )}
      </label>
      {error && <div className="error-box">{error}</div>}
      {!error && !runs && <p className="hint">{t("Loading…")}</p>}
      {runs && runs.length === 0 && <p className="hint">{t("Nothing here yet.")}</p>}
      <div style={{ marginTop: 12 }}>
        {shown.map((row) => (
          <RunRow
            key={row.id}
            group={group}
            row={row}
            month={month}
            facts={facts}
            onStopped={() => void load()}
          />
        ))}
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            {t("Previous")}
          </button>
          <span className="hint">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={(page >= pages - 1 && !more) || loadingMore}
            onClick={() => {
              if (page >= pages - 1 && more) {
                void loadMore().then((loaded) => {
                  if (loaded) setPage((p) => p + 1);
                });
                return;
              }
              setPage((p) => Math.min(pages - 1, p + 1));
            }}
          >
            {t("Next")}
          </button>
        </div>
      )}
    </section>
  );
}
