import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  fetchInstallation,
  installationModel,
  publishInstallation,
} from "@/lib/installationAdmin";
import { withInstructionField } from "@/views/admin/installation/modelDocument";
import { AgentModel } from "./AgentModel";

/**
 * The agent as a whole: the model every call runs on, and the rule it is told
 * above every group's own. Both are the installation's document, seen through
 * the fields an administrator chooses; a save publishes that same document.
 */
export function AgentGeneral({ onDocumentSaved }: { onDocumentSaved: () => void }) {
  const [line, setLine] = useState("");
  const [present, setPresent] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetchInstallation()
      .then((installation) => {
        if (!live) return;
        setPresent(installation.present);
        setLine(installationModel(installation.document).instruction);
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, []);

  async function saveLine() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Read again before writing: the model section may have published since
      // this tab was opened, and saving the line must not carry an old copy of
      // the rest back over it.
      const current = await fetchInstallation();
      await publishInstallation(withInstructionField(current.document ?? "", line));
      setLine(line.trim());
      setSaved(true);
      onDocumentSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <AgentModel onSaved={onDocumentSaved} />

      <section style={{ marginTop: 24 }}>
        <h2>{t("Standing rule")}</h2>
        <p className="hint">
          {t("Above every group's instruction. Applies at the next pass.")}
        </p>
        {present ? (
          <>
            <div className="field">
              <textarea
                rows={4}
                aria-label={t("Standing rule")}
                value={line}
                disabled={busy}
                onChange={(e) => {
                  setLine(e.target.value);
                  setSaved(false);
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void saveLine()}
              >
                {t("Save")}
              </button>
              {saved && <span className="hint">{t("Saved")}</span>}
            </div>
          </>
        ) : (
          <p className="hint">{t("No installation document yet.")}</p>
        )}
      </section>
    </div>
  );
}
