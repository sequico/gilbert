import { errorMessage } from "@gilbert/shared/errors";
import { installationDefaults } from "@gilbert/shared/installation";
import { useEffect, useState } from "react";
import { fetchModelCheck, type ModelCheck } from "@/lib/agentAdmin";
import { t } from "@/lib/i18n";
import {
  fetchInstallation,
  type InstallationLimitsFields,
  installationLimits,
  installationModel,
  publishInstallation,
} from "@/lib/installationAdmin";
import {
  withInstructionField,
  withLimitsFields,
} from "@/views/admin/installation/modelDocument";
import { AgentModel } from "./AgentModel";

/** What a document that names no limit uses: the shared defaults. */
const LIMIT_DEFAULTS = installationDefaults().limits;

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
  const [limits, setLimits] = useState<InstallationLimitsFields | null>(null);
  const [limitsSaved, setLimitsSaved] = useState(false);
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
        setLimits(installationLimits(installation.document));
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, []);

  async function saveLimits() {
    if (busy || !limits) return;
    if (
      ![limits.maxRunTokens, limits.maxDailyTokens, limits.maxRunSteps].every(
        (one) => Number.isInteger(one) && one >= 1,
      )
    ) {
      setError(t("Every limit must be a whole number of at least one."));
      return;
    }
    setBusy(true);
    setError(null);
    setLimitsSaved(false);
    try {
      // Read again before writing: the model and the instruction may have been
      // published from their own fields since this tab was opened.
      const current = await fetchInstallation();
      await publishInstallation(withLimitsFields(current.document ?? "", limits));
      setLimitsSaved(true);
      onDocumentSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

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
        <h2>{t("Limits")}</h2>
        {present && limits ? (
          <>
            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              }}
            >
              <label className="field">
                <span>{t("Tokens per run")}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={limits.maxRunTokens}
                  disabled={busy}
                  onChange={(e) => {
                    setLimits({ ...limits, maxRunTokens: Number(e.target.value) });
                    setLimitsSaved(false);
                  }}
                />
                <span className="hint">
                  {t("Default")}: {LIMIT_DEFAULTS.maxRunTokens}
                </span>
              </label>
              <label className="field">
                <span>{t("Tokens per day")}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={limits.maxDailyTokens}
                  disabled={busy}
                  onChange={(e) => {
                    setLimits({ ...limits, maxDailyTokens: Number(e.target.value) });
                    setLimitsSaved(false);
                  }}
                />
                <span className="hint">
                  {t("Default")}: {LIMIT_DEFAULTS.maxDailyTokens}
                </span>
              </label>
              <label className="field">
                <span>{t("Steps per run")}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={limits.maxRunSteps}
                  disabled={busy}
                  onChange={(e) => {
                    setLimits({ ...limits, maxRunSteps: Number(e.target.value) });
                    setLimitsSaved(false);
                  }}
                />
                <span className="hint">
                  {t("Default")}: {LIMIT_DEFAULTS.maxRunSteps}
                </span>
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void saveLimits()}
              >
                {t("Save")}
              </button>
              {limitsSaved && <span className="hint">{t("Saved")}</span>}
            </div>
          </>
        ) : (
          <p className="hint">{t("No installation document yet.")}</p>
        )}
      </section>

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
