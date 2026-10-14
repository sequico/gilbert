import { t } from "@/lib/i18n";

/**
 * A surface that reads something before it can show anything: the error with the
 * button that tries again, or the line that says it is still reading.
 *
 * Every administration surface that fetches before it renders has this fork —
 * `loadError ? <error-box> + Retry : <hint>Loading…</hint>` — and each wrote it
 * out beside its own heading. The fork is the half that matters: a read that
 * failed and a read that has not answered must not look alike, or an operator
 * reads an empty administration as an empty installation.
 */
export function LoadState({
  loadError,
  reload,
  loading,
}: {
  /** Non-null when the read failed, which is not the same as a refusal. */
  loadError: string | null;
  reload: () => void;
  loading: boolean;
}) {
  if (loadError)
    return (
      <>
        <div className="error-box">{loadError}</div>
        <p>
          <button className="btn" onClick={reload}>
            {t("Retry")}
          </button>
        </p>
      </>
    );
  return loading ? <p className="hint">{t("Loading…")}</p> : null;
}
