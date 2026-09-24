import type { SipCredential } from "@gilbert/shared/phone";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { Dialog } from "@/ui/dialog";

/**
 * One identity's SIP account (ADR 0023), set by an administrator.
 *
 * The server, user name and password the phone registers with, written into
 * the account's own `sip.json` and read by that account's client. It is
 * deliberately its own small editor rather than a field of the identity form:
 * the account is not an identity property, and the person's own Identities &
 * signatures dialog must not offer it — only the administration sets this.
 */
export function SipCredentialDialog({
  identity,
  current,
  onClose,
  onSave,
}: {
  /** The identity's label, for the title: which identity this belongs to. */
  identity: string;
  current: SipCredential | null;
  onClose: () => void;
  onSave: (sip: SipCredential | null) => Promise<void>;
}) {
  const [server, setServer] = useState(current?.server ?? "");
  const [username, setUsername] = useState(current?.username ?? "");
  const [password, setPassword] = useState(current?.password ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setServer(current?.server ?? "");
    setUsername(current?.username ?? "");
    setPassword(current?.password ?? "");
    setError(null);
  }, [current]);

  async function run(sip: SipCredential | null) {
    setBusy(true);
    setError(null);
    try {
      await onSave(sip);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canSave = Boolean(server.trim() && username.trim());

  return (
    <Dialog open onClose={onClose} title={t("SIP account")} size="sm">
      <p className="hint">{identity}</p>
      <label className="field">
        <span>{t("Server")}</span>
        <input
          className="input"
          spellCheck={false}
          placeholder="pbx.example.com"
          value={server}
          onChange={(e) => setServer(e.target.value)}
        />
      </label>
      <label className="field">
        <span>{t("User name")}</span>
        <input
          className="input"
          spellCheck={false}
          placeholder="1001"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="field">
        <span>{t("Password")}</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <p className="hint">
        {t(
          "The account the phone registers as, sent to the provider as sip:<user name>@<server>. An identity with no server and user name is not registered.",
        )}
      </p>
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
          {t("Cancel")}
        </button>
        {current && (
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void run(null)}
          >
            {t("Clear")}
          </button>
        )}
        <button
          className="btn btn-primary"
          disabled={busy || !canSave}
          onClick={() =>
            void run({ server: server.trim(), username: username.trim(), password })
          }
        >
          {t("Save")}
        </button>
      </div>
    </Dialog>
  );
}
