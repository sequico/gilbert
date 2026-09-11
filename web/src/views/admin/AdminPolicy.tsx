import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { t } from "@/lib/i18n";
import { policyEnforced, refreshSettingsPolicy } from "@/lib/settingsPolicy";
import { useSettings } from "@/store/settings";
import { SettingsKeyTable } from "@/views/admin/SettingsKeyTable";

/** A valid document the editor can be reset to, with one of each section. */
const EXAMPLE = JSON.stringify(
  {
    defaults: { weekStart: 1 },
    enforced: { imagePolicy: "always", readingPane: "right" },
    changes: [{ version: "example-change", settings: { spellcheck: true } }],
  },
  null,
  2,
);

/**
 * The installation-wide policy editor (ADR 0001 §4, ADR 0004).
 *
 * v1 edits the policy as one JSON document — the same shape upstream's boot
 * path reads — with the key list beside it; there is no per-key form yet, and
 * the per-user surface (ADR 0001 §5) is a later layer on the same document
 * shape. Publishing validates server-side with the boot path's rules,
 * replaces the running copy at once, and kicks the other signed-in sessions
 * so their next sign-in applies it.
 */
export function AdminPolicy() {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** What the server last held: what "unchanged" is measured against. */
  const [baseline, setBaseline] = useState("");
  // A publish with nothing to publish is not a state the button should offer.
  const dirty = text !== baseline;

  async function load() {
    setLoadError(null);
    try {
      const res = await apiFetch<{ policy: string }>("/api/admin/policy");
      setText(res.policy);
      setBaseline(res.policy);
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
    try {
      JSON.parse(text);
    } catch {
      setError(t("That is not valid JSON — fix the document and publish again."));
      return;
    }
    setSaving(true);
    try {
      await apiFetch<{ ok: boolean }>("/api/admin/policy", {
        method: "POST",
        body: text,
      });
      // What the server holds now is the document just sent, so there is
      // nothing left for the button to publish until the text moves again.
      setBaseline(text);
      /*
       * The published policy applies to this session at once: the client
       * caches the policy per page, and the publisher's own session is
       * deliberately not kicked (ADR 0004), so without a refresh this tab
       * would keep enforcing the pre-publish policy.
       */
      await refreshSettingsPolicy();
      const enforced = policyEnforced();
      if (Object.keys(enforced).length) {
        useSettings.getState().update({ ...enforced });
      }
      useSettings.getState().applyPolicyChanges();
      setNotice(
        t("Policy published and applied — other signed-in clients will sign in again."),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function insertExample() {
    if (
      text.trim() !== EXAMPLE.trim() &&
      text.trim() &&
      !window.confirm(
        t("Replace the document with the example? Unsaved edits will be lost."),
      )
    )
      return;
    setError(null);
    setNotice(null);
    setText(EXAMPLE);
  }

  if (!loaded) {
    return (
      <div>
        <h1>{t("Installation-wide policy")}</h1>
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
      <h1>{t("Installation-wide policy")}</h1>
      <p className="lead">
        {t(
          "The settings this installation decides for every account. Edit the JSON document and publish: the server validates it, applies it at once, and signs the other clients out so their next sign-in picks it up.",
        )}
      </p>
      <h2>{t("The three sections")}</h2>
      <ul>
        <li>
          <code>defaults</code> —{" "}
          {t(
            "seed accounts that have never had settings of their own; readers can change them afterwards.",
          )}
        </li>
        <li>
          <code>enforced</code> —{" "}
          {t(
            "applied on every load and cannot be changed in Settings — the controls stay visible and go dead.",
          )}
        </li>
        <li>
          <code>changes</code> —{" "}
          {t(
            "applied once each, to everyone already signed up; each needs a unique version, and readers may turn it back off afterwards.",
          )}
        </li>
      </ul>
      <textarea
        className="textarea"
        aria-label={t("Policy document")}
        spellCheck={false}
        disabled={saving}
        style={{ minHeight: "18rem", fontFamily: "var(--font-mono, monospace)" }}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
        <button
          className="btn btn-primary"
          disabled={saving || !dirty}
          onClick={() => void publish()}
        >
          {saving ? t("Publishing…") : t("Publish policy")}
        </button>
        <button className="btn btn-ghost" disabled={saving} onClick={insertExample}>
          {t("Insert example")}
        </button>
        {notice && <span className="hint">{notice}</span>}
      </div>
      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <SettingsKeyTable />
    </div>
  );
}
