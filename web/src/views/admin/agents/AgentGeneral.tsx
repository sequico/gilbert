import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useState } from "react";
import { fetchModelCheck, type ModelCheck } from "@/lib/agentAdmin";
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
/** What the check says, in the reader's words. */
function checkLabel(check: ModelCheck): string {
  if (check.ok) return t("Model connected");
  switch (check.reason) {
    case "no_model":
      return t("No model named");
    case "unauthorized":
      return t("The API key was refused");
    case "not_found":
      return t("The URL was not found");
    case "rate_limited":
      return t("The provider is rate-limiting this installation");
    case "provider_error":
      return t("The provider refused the call");
    case "forbidden_target":
      return t("The provider's address is not allowed on this installation");
    case "bad_url":
      return t("The provider's URL is not valid");
    default:
      return t("The provider could not be reached");
  }
}

export function AgentGeneral({ onDocumentSaved }: { onDocumentSaved: () => void }) {
  const [check, setCheck] = useState<ModelCheck | null>(null);
  const [line, setLine] = useState("");
  const [present, setPresent] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * The probe asks the provider, so it is not on every render: once when the
   * tab opens, every half minute while it is open, and again after a save --
   * the moment a key or an address may have become right or wrong.
   */
  useEffect(() => {
    let live = true;
    const probe = () =>
      fetchModelCheck()
        .then((found) => live && setCheck(found))
        .catch(() => live && setCheck({ ok: false, reason: "unreachable" }));
    void probe();
    const timer = window.setInterval(() => void probe(), 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

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
      <p className="hint" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className={`status-dot ${check?.ok ? "ok" : "bad"}`} aria-hidden="true" />
        {check ? checkLabel(check) : t("Checking the model…")}
        {check?.ok && check.identity && (
          <span style={{ opacity: 0.75 }}>{check.identity}</span>
        )}
      </p>
      <AgentModel
        onSaved={() => {
          onDocumentSaved();
          void fetchModelCheck()
            .then(setCheck)
            .catch(() => setCheck({ ok: false, reason: "unreachable" }));
        }}
      />

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
