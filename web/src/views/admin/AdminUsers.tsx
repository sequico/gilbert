import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { t } from "@/lib/i18n";

interface DirectoryUser {
  id: string;
  name: string;
}

/**
 * The admin Users surface (ADR 0001 §5, ADR 0005): every individual account
 * on the server, and a per-account Force / Release for the password-change
 * directive. The server refuses to force another Gilbert administrator, so
 * the list is shown as it is — the guard is the door, not the paint.
 */
export function AdminUsers() {
  const [target, setTarget] = useState("");
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [enumeration, setEnumeration] = useState(true);
  const [enumerationMessage, setEnumerationMessage] = useState<string | null>(null);
  const [canImpersonate, setCanImpersonate] = useState(false);
  const [impersonateReason, setImpersonateReason] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"force" | "release" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const res = await apiFetch<{
        users: DirectoryUser[];
        enumeration: boolean;
        enumerationMessage?: string | null;
        canImpersonate: boolean;
        reason?: string | null;
      }>("/api/admin/users");
      setUsers(res.users);
      setEnumeration(res.enumeration);
      setEnumerationMessage(res.enumerationMessage ?? null);
      setCanImpersonate(res.canImpersonate);
      setImpersonateReason(res.reason ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(address: string, clear: boolean) {
    const email = address.trim();
    if (!email) {
      setError(t("Type the account address first."));
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(clear ? "release" : "force");
    try {
      await apiFetch<{ ok: boolean }>("/api/admin/force-password-change", {
        method: "POST",
        body: JSON.stringify({ target: email, clear }),
      });
      setNotice(
        clear
          ? t("Password change is no longer required for that account.")
          : t("That account must change its password before it can use mail."),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const actionsDisabled = busy !== null || !canImpersonate;

  return (
    <div>
      <h1>{t("Users")}</h1>
      <p className="lead">
        {t(
          "Force a password change for one account. The requirement lives in the account's own hidden folder and is enforced by the server; administrators cannot force one another.",
        )}
      </p>
      {users !== null && !canImpersonate && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {impersonateReason === "app_password"
            ? t(
                "This session uses an app password, which Stalwart refuses for impersonation — sign in with your password to act on accounts.",
              )
            : t(
                "This session does not hold the impersonation right on the admin group, so account actions will fail. Ask the Stalwart administrator for the right.",
              )}
        </div>
      )}
      {loadError && (
        <div className="error-box">
          {loadError}
          <p>
            <button className="btn" onClick={() => void load()}>
              {t("Retry")}
            </button>
          </p>
        </div>
      )}
      {users !== null && !enumeration && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "Listing accounts needs Stalwart server-administrator privilege, which this session does not have — being a Gilbert administrator is not enough. Type an address below instead.",
          )}
          {enumerationMessage && (
            <p className="hint" style={{ marginTop: 6 }}>
              <code>{enumerationMessage}</code>
            </p>
          )}
        </div>
      )}
      {users !== null && (
        <>
          <h2>{t("All accounts")}</h2>
          {users.length === 0 ? (
            <p className="hint">{t("No accounts found.")}</p>
          ) : (
            <table className="sessions-table">
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <code>{u.name}</code>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn btn-sm"
                        disabled={actionsDisabled}
                        onClick={() => void act(u.name, false)}
                      >
                        {t("Force password change")}
                      </button>{" "}
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={actionsDisabled}
                        onClick={() => void act(u.name, true)}
                      >
                        {t("Release")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>{t("Or type an address")}</h2>
          <div
            style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
          >
            <input
              className="input"
              type="email"
              aria-label={t("Account address")}
              placeholder={t("user@example.com")}
              value={target}
              disabled={busy !== null}
              onChange={(e) => setTarget(e.target.value)}
              style={{ minWidth: "16rem" }}
            />
            <button
              className="btn btn-primary"
              disabled={actionsDisabled}
              onClick={() => void act(target, false)}
            >
              {busy === "force" ? t("Forcing…") : t("Force password change")}
            </button>
            <button
              className="btn btn-ghost"
              disabled={actionsDisabled}
              onClick={() => void act(target, true)}
            >
              {busy === "release" ? t("Releasing…") : t("Release requirement")}
            </button>
          </div>
        </>
      )}
      {notice && (
        <p className="hint" style={{ marginTop: 12 }}>
          {notice}
        </p>
      )}
      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
