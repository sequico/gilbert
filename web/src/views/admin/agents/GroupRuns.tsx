import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useState } from "react";
import { type FactDoc, fetchGroupRuns, type RunListing } from "@/lib/agentAdmin";
import { t } from "@/lib/i18n";
import { RunCard } from "@/views/admin/agent/RunCard";
import { metricsOf } from "./metrics";

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

  useEffect(() => {
    let live = true;
    setRuns(null);
    setError(null);
    fetchGroupRuns(group)
      .then((rows) => live && setRuns(rows))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [group]);

  const metrics = runs ? metricsOf(runs) : null;

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
        {runs?.map((row) => (
          <RunCard key={row.id} listed={row} facts={facts} />
        ))}
      </div>
    </section>
  );
}
