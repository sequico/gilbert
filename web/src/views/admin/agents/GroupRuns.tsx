import { errorMessage } from "@gilbert/shared/errors";
import { isInFlight } from "@gilbert/shared/run";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { push } from "@/jmap/push";
import {
  type FactView,
  fetchAgentMetrics,
  fetchGroupArchive,
  fetchGroupRuns,
  fetchGroupRunsPage,
  fetchRun,
  type RunListing,
  type RunMetrics,
  type RunSummary,
  type StopAllAnswer,
  stopAllRuns,
  stopRun,
} from "@/lib/agentAdmin";
import { formatFullDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { Empty } from "@/ui/misc";
import { RUN_STATE_LABELS, RunCard, RunPlan } from "@/views/admin/agent/RunCard";
import { metricsOf, sameRunHeader } from "./metrics";

/** How many runs one page of the listing shows, one row each. */
const RUNS_PAGE = 10;
/** How many runs one server page carries: five pages of the ten drawn. */
const RUNS_PAGE_SERVER = RUNS_PAGE * 5;

/** The cursor an archive page ended at; a working-set page carries none. */
function afterOf(page: { runs: RunSummary[]; more: boolean }): string | null {
  const after = (page as { after?: unknown }).after;
  return typeof after === "string" ? after : null;
}

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
  label,
}: {
  group: string;
  id: string;
  onStopped?: () => void;
  /** What the button says, where the press means something more specific. */
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost run-stop"
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
        {label ?? t("Stop")}
      </button>
      {error && (
        <span className="hint" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Stop every run in flight in a group: the ones working and the ones waiting on
 * a person's answer.
 *
 * A group with nineteen runs in flight is nineteen presses otherwise, and a run
 * parked on a question is the one nothing else will move — a person who wants the
 * agent to stop must be able to say so once.
 */
export function StopAll({
  group,
  onStopped,
}: {
  group: string;
  onStopped?: (answer: StopAllAnswer) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * What the sweep could not close, said rather than left to the page: a person
   * who pressed Stop all and still sees rows is owed an answer, or the rows read
   * as a command that did nothing. The numbers are the server's and the reasons
   * are the server's — the sentence states both and infers neither, and the
   * problems it answered are drawn as it wrote them.
   */
  const [note, setNote] = useState<{
    left: number;
    max: number;
    problems: string[];
  } | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setBusy(true);
          setError(null);
          setNote(null);
          void stopAllRuns(group)
            .then((answer) => {
              onStopped?.(answer);
              const problems = [
                ...answer.failed.map((one) => one.problem),
                ...answer.unreadable.map((one) => one.problem),
              ];
              if (answer.left > 0 || problems.length)
                setNote({
                  left: answer.left,
                  max: answer.max,
                  problems,
                });
            })
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        {t("Stop all")}
      </button>
      {error && <span className="hint">{error}</span>}
      {note && note.left > 0 && (
        <span className="hint">
          {t("{left} still moving; one press closes at most {max} runs.", {
            left: note.left,
            max: note.max,
          })}
        </span>
      )}
      {note?.problems.map((problem) => (
        <span className="hint" key={problem}>
          {problem}
        </span>
      ))}
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
  facts: readonly FactView[];
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
  facts: readonly FactView[];
  onStopped: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="run-row" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="run-cell run-row-id" title={row.id}>
          {row.id}
        </span>
        <span className="run-cell">
          <span
            className={`run-state run-state-${row.problem ? "unreadable" : row.state}`}
          >
            {row.problem || !row.state
              ? t("Not readable")
              : t(RUN_STATE_LABELS[row.state])}
          </span>
        </span>
        <span
          className="run-cell run-row-meta"
          title={row.about ?? row.woke ?? undefined}
        >
          {row.about ?? row.woke ?? "—"}
        </span>
        <span className="run-cell run-cell-num run-row-meta">
          {row.state
            ? t("{steps} steps · {calls} calls", {
                steps: row.steps,
                calls: row.spent.calls,
              })
            : "—"}
        </span>
        <span className="run-cell run-row-meta">
          {(row.startedAt ?? row.ended?.at)
            ? formatFullDate(row.startedAt ?? row.ended?.at ?? "")
            : "—"}
        </span>
        <span className="run-cell run-cell-action">
          {!month && row.state && isInFlight(row.state) && (
            <StopRun group={group} id={row.id} onStopped={onStopped} />
          )}
        </span>
        {row.problem && <span className="run-row-problem">{row.problem}</span>}
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
              version={`${row.state}:${row.steps}:${row.spent.calls}:${row.spent.ms}:${row.failed}:${row.ended?.at ?? ""}`}
            />
          ))}
      </div>
    </details>
  );
}

/**
 * One run in flight, in a conversation: what woke it, who set it off, when, and
 * the plan with the step it is on.
 *
 * The same marks the run's own card draws (`RunPlan`), fed by the header the
 * live list carries: a step that turns from open to done is the thing the person
 * watching the agent came for.
 */
function LiveRun({
  group,
  row,
  onStopped,
}: {
  group: string;
  row: RunSummary;
  onStopped: () => void;
}) {
  const line = row.about ?? row.woke;
  return (
    <div className="run-live">
      <div className="run-live-row">
        <span className="run-cell">
          <span className={`run-state run-state-${row.state}`}>
            {row.state && t(RUN_STATE_LABELS[row.state])}
          </span>
        </span>
        <span className="run-cell run-row-id" title={row.id}>
          {row.id}
        </span>
        <span className="run-cell run-row-meta">
          {row.startedAt ? formatFullDate(row.startedAt) : "—"}
        </span>
        <span className="run-cell run-cell-action">
          <StopRun group={group} id={row.id} onStopped={onStopped} />
        </span>
      </div>
      {line && (
        <p className="hint run-live-about" title={line}>
          {row.by ? t("{what} — from {who}", { what: line, who: row.by }) : line}
        </p>
      )}
      <RunPlan steps={row.plan ?? []} />
    </div>
  );
}

/** The runs one group has worked, as its own account carries them. */ export function GroupRuns({
  group,
  accountId,
  facts,
  live = false,
  runningOnly = false,
}: {
  group: string;
  /** The group's own account, for the push stream that wakes the live list. */
  accountId?: string;
  facts: readonly FactView[];
  /** Keep the list current while it is on screen, for a run still in flight. */
  live?: boolean;
  /**
   * Draw the runs in flight and nothing else — the chat's panel.
   *
   * A conversation asks "what is the agent doing with us", not "what did it do
   * last month": the history is the administration page's, and here the past is
   * noise beside the message being written. The list keeps the live rhythm and
   * shows each run's opening line and plan, so a step that moves is seen.
   */
  runningOnly?: boolean;
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
      /*
       * The chat's panel is the runs in flight and nothing else: it reads the
       * state the server filters on, not a page of history with the working run
       * somewhere past it. The history page could be older than the run the
       * person is watching, which is how the chat said "nothing is running"
       * beside an administration page showing the run.
       */
      if (runningOnly) {
        setRuns(await fetchGroupRuns(group, "running"));
        setMore(false);
        setError(null);
        return;
      }
      const page = month
        ? await fetchGroupArchive(group, month)
        : await fetchGroupRunsPage(group, { offset: 0, limit: RUNS_PAGE_SERVER });
      setRuns(page.runs);
      setMore(page.more);
      cursor.current = afterOf(page);
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
  }, [group, month, runningOnly]);

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
      cursor.current = afterOf(page);
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
  const ordered = runningOnly
    ? sorted.filter((one) => one.state != null && isInFlight(one.state))
    : live
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
      <h2>{runningOnly ? t("Runs in flight") : t("Runs")}</h2>
      {metrics && !runningOnly && (
        <p className="hint">
          {t(
            "{runs} runs · {calls} model calls · {failed} failed steps · {tokens} tokens",
            {
              runs: metrics.runs,
              calls: metrics.calls,
              failed: metrics.failed,
              tokens: metrics.promptTokens + metrics.completionTokens,
            },
          )}
        </p>
      )}
      {!runningOnly && (
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
      )}
      {error && <div className="error-box">{error}</div>}
      {!error && !runs && <p className="hint">{t("Loading…")}</p>}
      {runs && ordered.length === 0 && (
        <Empty
          icon={<Bot size={40} />}
          title={runningOnly ? t("Nothing is running") : t("Nothing here yet.")}
        />
      )}
      <div className={`run-table ${runningOnly ? "live" : ""}`} style={{ marginTop: 12 }}>
        {!runningOnly && (
          <div className="run-table-head">
            <span>{t("Run")}</span>
            <span>{t("State")}</span>
            <span>{t("Woke")}</span>
            <span>{t("Steps")}</span>
            <span>{t("When")}</span>
            <span>{t("Actions")}</span>
          </div>
        )}
        {runningOnly && (
          <div className="run-table-head">
            <span>{t("State")}</span>
            <span>{t("Run")}</span>
            <span>{t("When")}</span>
            <span>{t("Actions")}</span>
          </div>
        )}
        {shown.map((row) =>
          runningOnly ? (
            <LiveRun key={row.id} group={group} row={row} onStopped={() => void load()} />
          ) : (
            <RunRow
              key={row.id}
              group={group}
              row={row}
              month={month}
              facts={facts}
              onStopped={() => void load()}
            />
          ),
        )}
      </div>
      {pages > 1 && !runningOnly && (
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
