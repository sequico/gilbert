import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { t } from "@/lib/i18n";
import { Switch } from "@/ui/misc";
import { toast } from "@/ui/toast";

/** A TURN server as the installation document carries it (ADR 0023). */
interface TurnRow {
  url: string;
  username: string;
  credential: string;
}

/** The stored installation document, as `GET /api/admin/installation` answers. */
interface InstallationView {
  present: boolean;
  document: string | null;
  problem: string | null;
  account: string;
  master: string;
  location: string;
}

/** The document's `sip` section, as this page reads and writes it. */
interface SipSection {
  enabled: boolean;
  endpoints: string[];
  stun: string[];
  turn: TurnRow[];
}

function asLines(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").join("\n")
    : "";
}

function linesToArray(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function readSip(doc: Record<string, unknown>): SipSection {
  const sip = (doc.sip ?? {}) as Record<string, unknown>;
  return {
    enabled: sip.enabled === true,
    endpoints: Array.isArray(sip.endpoints) ? (sip.endpoints as string[]) : [],
    stun: Array.isArray(sip.stun) ? (sip.stun as string[]) : [],
    turn: Array.isArray(sip.turn)
      ? (sip.turn as Partial<TurnRow>[]).map((entry) => ({
          url: typeof entry.url === "string" ? entry.url : "",
          username: typeof entry.username === "string" ? entry.username : "",
          credential: typeof entry.credential === "string" ? entry.credential : "",
        }))
      : [],
  };
}

/**
 * SIP Phone: the installation's telephone settings (ADR 0023).
 *
 * One page for what is the same for every client — the SIP-over-WebSocket
 * endpoints in the order they are tried, the STUN and TURN servers media may
 * need, and whether this installation offers the phone at all. They are the
 * installation's own document (ADR 0011), so this page reads that document,
 * changes only its `sip` section and publishes it back whole; each person's
 * SIP address and password are an identity's and are set in Enforce Identities,
 * not here.
 *
 * The running process keeps what it booted with, so a publish applies at the
 * next boot and the page says so rather than reporting a live change.
 */
export function AdminSipPhone() {
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [sip, setSip] = useState<SipSection>({
    enabled: false,
    endpoints: [],
    stun: [],
    turn: [],
  });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [published, setPublished] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      const res = await apiFetch<{ installation: InstallationView }>(
        "/api/admin/installation",
      );
      if (res.installation.document === null) {
        setDoc(null);
        setLoaded(true);
        return;
      }
      const parsed = JSON.parse(res.installation.document) as Record<string, unknown>;
      setDoc(parsed);
      setSip(readSip(parsed));
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function publish() {
    if (saving || !doc) return;
    setError(null);
    setPublished(false);
    setSaving(true);
    try {
      const next = {
        ...doc,
        sip: {
          enabled: sip.enabled,
          endpoints: sip.endpoints,
          stun: sip.stun,
          turn: sip.turn.filter((row) => row.url.trim()),
        },
      };
      /*
       * The whole document goes back, with only `sip` changed: the route
       * validates it and takes the next epoch, so everything this page does not
       * show survives the publish.
       */
      const res = await apiFetch<{ outcome: { document: string } }>(
        "/api/admin/installation",
        { method: "POST", body: JSON.stringify(next, null, 2) },
      );
      const stored = JSON.parse(res.outcome.document) as Record<string, unknown>;
      setDoc(stored);
      setSip(readSip(stored));
      setPublished(true);
      toast.success(t("Saved. The change applies at the next boot."));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <div>
        <h1>{t("SIP Phone")}</h1>
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

  if (!doc) {
    return (
      <div>
        <h1>{t("SIP Phone")}</h1>
        <p className="lead">
          {t(
            "This installation's telephone settings live in its own document, and there is none yet.",
          )}
        </p>
        <p>
          <a className="btn btn-ghost" href="/admin/installation">
            {t("Open the installation document")}
          </a>
        </p>
      </div>
    );
  }

  const setTurn = (index: number, patch: Partial<TurnRow>) =>
    setSip((s) => ({
      ...s,
      turn: s.turn.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));

  return (
    <div>
      <h1>{t("SIP Phone")}</h1>
      <p className="lead">
        {t(
          "The telephony server every client reaches, the ICE servers its media may need, and whether this installation offers the phone. These are the installation's, the same for everyone; each person's own SIP address and password are set per identity in Enforce Identities.",
        )}
      </p>

      <div className="card">
        <Switch
          checked={sip.enabled}
          onChange={(enabled) => setSip((s) => ({ ...s, enabled }))}
          label={t("Offer the phone")}
          hint={t(
            "On, the top-bar phone entry appears and the client registers with the server below. Off, no entry is offered and nothing registers.",
          )}
        />
      </div>

      <label className="field">
        <span>{t("SIP endpoints")}</span>
        <textarea
          className="input"
          rows={3}
          spellCheck={false}
          placeholder="wss://pbx.example.com/ws"
          value={asLines(sip.endpoints)}
          onChange={(e) =>
            setSip((s) => ({ ...s, endpoints: linesToArray(e.target.value) }))
          }
        />
        <span className="hint">
          {t(
            "One SIP-over-WebSocket URL per line, tried in this order. A deployment whose server does not speak WebSocket lists a WSS-speaking gateway in front of it.",
          )}
        </span>
      </label>

      <label className="field">
        <span>{t("STUN servers")}</span>
        <textarea
          className="input"
          rows={2}
          spellCheck={false}
          placeholder="stun:stun.example.com:3478"
          value={asLines(sip.stun)}
          onChange={(e) => setSip((s) => ({ ...s, stun: linesToArray(e.target.value) }))}
        />
        <span className="hint">{t("One per line.")}</span>
      </label>

      <div className="field">
        <span>{t("TURN servers")}</span>
        {sip.turn.map((row, index) => (
          <div className="row" key={index} style={{ gap: 6, marginBottom: 6 }}>
            <input
              className="input grow"
              placeholder="turn:turn.example.com:3478"
              spellCheck={false}
              value={row.url}
              onChange={(e) => setTurn(index, { url: e.target.value })}
            />
            <input
              className="input"
              style={{ width: 140 }}
              placeholder={t("User name")}
              spellCheck={false}
              value={row.username}
              onChange={(e) => setTurn(index, { username: e.target.value })}
            />
            <input
              className="input"
              style={{ width: 140 }}
              placeholder={t("Credential")}
              type="password"
              value={row.credential}
              onChange={(e) => setTurn(index, { credential: e.target.value })}
            />
            <button
              className="icon-btn sm"
              aria-label={t("Remove")}
              onClick={() =>
                setSip((s) => ({ ...s, turn: s.turn.filter((_, i) => i !== index) }))
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          className="btn btn-ghost"
          onClick={() =>
            setSip((s) => ({ ...s, turn: [...s.turn, { url: "", username: "", credential: "" }] }))
          }
        >
          <Plus size={14} /> {t("Add a TURN server")}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {published && (
        <p className="hint">
          {t(
            "Stored. The running process keeps what it booted with, so the change applies at the next boot.",
          )}
        </p>
      )}
      <p>
        <button className="btn" disabled={saving} onClick={() => void publish()}>
          {saving ? t("Saving…") : t("Save")}
        </button>{" "}
        <button className="btn btn-ghost" disabled={saving} onClick={() => void load()}>
          {t("Reload")}
        </button>
      </p>
    </div>
  );
}
