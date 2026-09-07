import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { t } from "@/lib/i18n";
import { DEFAULT_SETTINGS } from "@/store/settings";

/**
 * Keys this build knows, minus the change-memory field: `appliedPolicyChanges`
 * is how an account remembers the `changes` it has had — it is bookkeeping,
 * not a preference an administrator sets.
 */
const KEYS = Object.keys(DEFAULT_SETTINGS)
  .filter((k) => k !== "appliedPolicyChanges")
  .sort();

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

  async function load() {
    setLoadError(null);
    try {
      const res = await apiFetch<{ policy: string }>("/api/admin/policy");
      setText(res.policy);
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
      setNotice(t("Policy published — other signed-in clients will sign in again."));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
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
          disabled={saving}
          onClick={() => void publish()}
        >
          {saving ? t("Publishing…") : t("Publish policy")}
        </button>
        {notice && <span className="hint">{notice}</span>}
      </div>
      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <details style={{ marginTop: 16 }}>
        <summary>{t("Settings keys")}</summary>
        <p className="hint">{t("The keys this build knows. Values are JSON.")}</p>
        <p>
          {KEYS.map((k) => (
            <code key={k} style={{ marginRight: 8 }}>
              {k}
            </code>
          ))}
        </p>
      </details>
    </div>
  );
}
