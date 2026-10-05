import { useEffect, useState } from "react";
import { t, tNode } from "@/lib/i18n";
import {
  fetchInstallation,
  type InstallationView,
  type InstallationPublished as Published,
  publishInstallation,
  startingInstallationDocument,
} from "@/lib/installationAdmin";
import { JsonDocumentEditor, jsonProblem } from "@/ui/JsonDocumentEditor";

/**
 * The installation's own document (ADR 0003 — the installation is configured
 * once, and its configuration is a document in the account's own Files rather
 * than a container's environment).
 *
 * The policy editor beside this one publishes something that applies at once;
 * this one publishes what the *next boot* reads, and the surface says so
 * instead of reporting a save as though the running process had changed. A
 * refusal — text that is not a document, a document this build could not boot
 * from — is shown as the server stated it, because the server is the door: the
 * client parses nothing and decides nothing on its own.
 */
export function AdminInstallation() {
  const [view, setView] = useState<InstallationView | null>(null);
  const [text, setText] = useState("");
  /** What the server last held: what "unchanged" is measured against. */
  const [baseline, setBaseline] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Published | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  // A publish with nothing to publish is not a state the button should offer.
  const dirty = text !== baseline;

  async function load() {
    setLoadError(null);
    try {
      const current = await fetchInstallation();
      setView(current);
      if (current.document === null) {
        // Nothing is there: the editor starts from the defaults and a fresh
        // secret rather than an empty box nothing can be published from.
        setText(startingInstallationDocument());
        setBaseline("");
        setSeeded(true);
      } else {
        setText(current.document);
        setBaseline(current.document);
        setSeeded(false);
      }
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function publish() {
    if (saving) return;
    setError(null);
    setNotice(null);
    const problem = jsonProblem(text);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const outcome = await publishInstallation(text);
      /*
       * The server hands back the document as it is now stored — the
       * validator's defaults filled in, the epoch moved on — so the editor
       * shows what is really there rather than what was typed, and the button
       * has nothing left to publish until the text moves again.
       */
      setText(outcome.document);
      setBaseline(outcome.document);
      setSeeded(false);
      setNotice(outcome);
      setView((current) =>
        current
          ? {
              ...current,
              present: true,
              document: outcome.document,
              problem: null,
              account: outcome.account,
              master: outcome.master,
              location: outcome.location,
            }
          : current,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <div>
        <h1>{t("Installation document")}</h1>
        {loadError ? (
          <>
            <div className="error-box">{loadError}</div>
            <p>
              <button className="btn" onClick={() => void load()}>
                {t("Retry")}
              </button>
            </p>
          </>
        ) : (
          <p className="hint">{t("Loading…")}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1>{t("Installation document")}</h1>
      <p className="lead">
        {t(
          "The configuration this installation runs on: one JSON document in the Master's own Files — the account this installation signs in as, which the server reads once at boot. What you publish here is what the next boot runs on, and the process running now keeps what it booted with.",
        )}
      </p>
      {view && <p className="hint">{t("Stored at {where}", { where: view.location })}</p>}
      {seeded && (
        <p className="hint">
          {t(
            "The installation's own account holds no document yet, so the editor starts from the installation's defaults and a freshly generated app secret. Publish it as it stands, or edit it first.",
          )}
        </p>
      )}
      {view?.problem && (
        <div className="error-box">
          {t("A boot would refuse the stored document: {reason}", {
            reason: view.problem,
          })}
        </div>
      )}
      <p className="hint">
        {tNode(
          "The {field} field is the app secret every stored session is sealed with: anyone who can read this page can read it, and a publish that loses it would sign everyone out. Keep it in the document it belongs to.",
          { field: <code>secret</code> },
        )}
      </p>
      <JsonDocumentEditor
        label={t("Installation document")}
        value={text}
        onChange={setText}
        saving={saving}
        dirty={dirty}
        action={t("Publish document")}
        busy={t("Publishing…")}
        onAction={() => void publish()}
        minHeight="24rem"
        secondary={
          <button className="btn btn-ghost" disabled={saving} onClick={() => void load()}>
            {t("Reload")}
          </button>
        }
        notice={
          notice && (
            <>
              <strong>{t("Takes effect at the next boot.")}</strong> {notice.message}
            </>
          )
        }
        error={error}
      />
    </div>
  );
}
