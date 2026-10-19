import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useState } from "react";
import { type FactDoc, fetchGroupRuns, type RunListing } from "@/lib/agentAdmin";
import { t } from "@/lib/i18n";
import { RunCard } from "@/views/admin/agent/RunCard";
import { metricsOf } from "./metrics";

/** How many runs one page of the listing shows, one row each. */
const RUNS_PAGE = 10;

/** The runs one group has worked, as its own account carries them. */
export function GroupRuns({
  group,
  facts,
}: {
  group: string;
  facts: readonly FactDoc[];
}) {
  const [runs, setRuns] = useState<RunListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let live = true;
    setRuns(null);
    setError(null);
    setPage(0);
    fetchGroupRuns(group)
      .then((rows) => live && setRuns(rows))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [group]);

  const metrics = runs ? metricsOf(runs) : null;
  const pages = Math.max(1, Math.ceil((runs?.length ?? 0) / RUNS_PAGE));
  const shown = (runs ?? []).slice(page * RUNS_PAGE, page * RUNS_PAGE + RUNS_PAGE);

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
