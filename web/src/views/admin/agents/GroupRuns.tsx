import { errorMessage } from "@gilbert/shared/errors";
import { useCallback, useEffect, useState } from "react";
import { type FactDoc, fetchGroupRuns, type RunListing, stopRun } from "@/lib/agentAdmin";
import { t } from "@/lib/i18n";
import { RunCard } from "@/views/admin/agent/RunCard";
import { metricsOf } from "./metrics";

/** How many runs one page of the listing shows, one row each. */
const RUNS_PAGE = 10;

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

/** The runs one group has worked, as its own account carries them. */
export function GroupRuns({
  group,
  facts,
  live = false,
}: {
  group: string;
  facts: readonly FactDoc[];
  /** Keep the list current while it is on screen, for a run still in flight. */
  live?: boolean;
}) {
  const [runs, setRuns] = useState<RunListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      setRuns(await fetchGroupRuns(group));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [group]);

  useEffect(() => {
    let alive = true;
    setRuns(null);
    setError(null);
    setPage(0);
    void load();
    if (!live)
      return () => {
        alive = false;
      };
    const timer = window.setInterval(() => {
      if (alive) void load();
    }, 3_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [load, live]);

  const metrics = runs ? metricsOf(runs) : null;
  // A live list is about what is happening: a running run is on the first page,
  // whatever its age, and the rest keep the record's own order.
  const ordered =
    live && runs
      ? [
          ...runs.filter((one) => one.run?.state === "running"),
          ...runs.filter((one) => one.run?.state !== "running"),
        ]
      : (runs ?? []);
  const pages = Math.max(1, Math.ceil(ordered.length / RUNS_PAGE));
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
      {error && <div className="error-box">{error}</div>}
      {!error && !runs && <p className="hint">{t("Loading…")}</p>}
      {runs && runs.length === 0 && <p className="hint">{t("Nothing here yet.")}</p>}
      <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
        {shown.map((row) => (
          <details key={row.id} style={{ borderBottom: "1px solid var(--border)" }}>
            <summary
              style={{
                cursor: "pointer",
                padding: "8px 2px",
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "baseline",
              }}
            >
              <strong>{row.id}</strong>
              <span className="hint">{row.run?.state ?? t("Not readable")}</span>
              {row.run?.startedBy.rule && (
                <span className="hint">{row.run.startedBy.rule}</span>
              )}
              {row.run && (
                <span className="hint">
                  {t("{steps} steps · {calls} calls", {
                    steps: row.run.spent.steps,
                    calls: row.run.spent.calls,
                  })}
                </span>
              )}
              {row.run?.state === "running" && (
                <StopRun group={group} id={row.id} onStopped={() => void load()} />
              )}
            </summary>
            <div style={{ padding: "4px 0 12px" }}>
              <RunCard listed={row} facts={facts} />
            </div>
          </details>
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
            disabled={page >= pages - 1}
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
          >
            {t("Next")}
          </button>
        </div>
      )}
    </section>
  );
}
