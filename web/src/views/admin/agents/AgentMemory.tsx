import { errorMessage } from "@gilbert/shared/errors";
import { useState } from "react";
import {
  correctFact,
  dismissProposal as dismissProposalSheet,
  type FactView,
  forgetFact,
} from "@/lib/agentAdmin";
import { t } from "@/lib/i18n";
import { FactCard } from "@/views/admin/agent/FactCard";

/** The installation's memory: one fact per sheet, corrected or removed here. */
export function AgentMemory({
  facts,
  problems,
  error,
  onChanged,
  more = false,
  onMore,
}: {
  facts: FactView[];
  problems: string[];
  error: string | null;
  onChanged: () => Promise<void>;
  /** Whether the store holds more sheets than the page drawn. */
  more?: boolean;
  onMore?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await onChanged();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>{t("Facts")}</h2>
      <p className="hint">
        {t(
          "One fact per sheet. A person's correction is in force; the agent proposes against it.",
        )}
      </p>
      {error && <div className="error-box">{error}</div>}
      {failure && <div className="error-box">{failure}</div>}
      {problems.length > 0 && (
        <div className="error-box">
          {problems.map((problem) => (
            <div key={problem}>{problem}</div>
          ))}
        </div>
      )}
      {facts.length === 0 && !error && <p className="hint">{t("Nothing here yet.")}</p>}
      <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
        {facts.map((fact) => (
          <FactCard
            key={fact.id}
            fact={fact}
            busy={busy}
            onSave={(id, edit) => act(() => correctFact(id, edit))}
            onRemove={(held) => act(() => forgetFact(held.id))}
            onDismissProposal={(held) => act(() => dismissProposalSheet(held.id))}
          />
        ))}
      </div>
      {more && onMore && (
        <button
          type="button"
          className="btn"
          style={{ marginTop: 12 }}
          disabled={loadingMore || busy}
          onClick={() => {
            setLoadingMore(true);
            void onMore().finally(() => setLoadingMore(false));
          }}
        >
          {t("Load more")}
        </button>
      )}
    </section>
  );
}
