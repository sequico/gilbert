import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { t } from "@/lib/i18n";

interface DirectoryUser {
  id: string;
  name: string;
  forced: boolean;
}

type Impersonation = "ok" | "denied" | "unknown";

/**
 * The admin Force passwords surface (ADR 0001 §5, ADR 0005): every
 * individual account on the server, with a per-row controller that shows
 * whether the password change is currently forced and offers Force/Release.
 * The server refuses to force another Gilbert administrator, so the list is
 * shown as it is — the guard is the door, not the paint.
 */
export function AdminUsers() {
  const [target, setTarget] = useState("");
  const [manualForced, setManualForced] = useState(false);
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [enumeration, setEnumeration] = useState(true);
  const [enumerationMessage, setEnumerationMessage] = useState<string | null>(null);
  const [impersonation, setImpersonation] = useState<Impersonation>("unknown");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"force" | "release" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const res = await apiFetch<{
        users: DirectoryUser[];
        enumeration: boolean;
        enumerationMessage?: string | null;
        impersonation: Impersonation;
      }>("/api/admin/users");
      setUsers(res.users);
      setEnumeration(res.enumeration);
      setEnumerationMessage(res.enumerationMessage ?? null);
      setImpersonation(res.impersonation);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(address: string, clear: boolean): Promise<boolean> {
    const email = address.trim();
    if (!email) {
      setError(t("Type the account address first."));
      return false;
    }
    setError(null);
    setBusy(clear ? "release" : "force");
    try {
      await apiFetch<{ ok: boolean }>("/api/admin/force-password-change", {
        method: "POST",
        body: JSON.stringify({ target: email, clear }),
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function forceRow(u: DirectoryUser) {
    if (await act(u.name, false)) {
      setUsers(
        (prev) => prev?.map((x) => (x.id === u.id ? { ...x, forced: true } : x)) ?? null,
      );
    }
  }

  async function releaseRow(u: DirectoryUser) {
    if (await act(u.name, true)) {
      setUsers(
        (prev) => prev?.map((x) => (x.id === u.id ? { ...x, forced: false } : x)) ?? null,
      );
    }
  }

  async function forceManual() {
    if (await act(target, false)) setManualForced(true);
  }

  async function releaseManual() {
    if (await act(target, true)) setManualForced(false);
  }

  const denied = impersonation === "denied";
  const canAct = impersonation !== "denied" && busy === null;
  const dim = { opacity: 0.45 } as const;

  return (
    <div>
      <h1>{t("Force passwords")}</h1>
      <p className="lead">
        {t(
          "Require an account to change its password. The requirement lives in the account's own hidden folder and is enforced by the server; administrators cannot force one another.",
        )}
      </p>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "Forcing a password acts on another user's account: the Stalwart-admin grant is not enough — Stalwart's Impersonate permission and a password session are required too, because app passwords are refused for impersonation.",
        )}
      </p>
      {users !== null && denied && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "This session cannot act on accounts: either it uses an app password (which Stalwart refuses for impersonation) or it lacks the \u201cact on behalf of other users\u201d permission in Stalwart. Sign in with your password, or ask the Stalwart administrator to grant that permission.",
          )}
        </div>
      )}
      {users !== null && !enumeration && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "Listing accounts needs Stalwart server-administrator privilege, which this session does not have \u2014 being a Gilbert administrator is not enough. Type an address below instead.",
          )}
          {enumerationMessage && (
            <p className="hint" style={{ marginTop: 6 }}>
              <code>{enumerationMessage}</code>
            </p>
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
      {users !== null && enumeration && (
        <>
          <h2>{t("Accounts")}</h2>
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
                    <td style={{ whiteSpace: "nowrap" }}>
                      {u.forced ? (
                        <span
                          className="forced-state"
                          title={t("Password change forced")}
                        >
                          {t("Password change forced")}
                        </span>
                      ) : (
                        <span className="hint">{t("Not forced")}</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn btn-primary"
                        disabled={!canAct || u.forced}
                        style={!canAct || u.forced ? dim : undefined}
                        onClick={() => void forceRow(u)}
                      >
                        {t("Force")}
                      </button>{" "}
                      <button
                        className="btn"
                        disabled={!canAct || !u.forced}
                        style={!canAct || !u.forced ? dim : undefined}
                        onClick={() => void releaseRow(u)}
                      >
                        {t("Release")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {users !== null && (
        <>
          <h2>{t("Or type an address")}</h2>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <input
              className="input"
              type="email"
              aria-label={t("Account address")}
              placeholder={t("user@example.com")}
              value={target}
              disabled={busy !== null}
              onChange={(e) => {
                setTarget(e.target.value);
                setManualForced(false);
              }}
              style={{ minWidth: "16rem" }}
            />
            <button
              className="btn btn-primary"
              disabled={!canAct || manualForced}
              style={!canAct || manualForced ? dim : undefined}
              onClick={() => void forceManual()}
            >
              {busy === "force" ? t("Forcing…") : t("Force password change")}
            </button>
            <button
              className="btn"
              disabled={!canAct || !manualForced}
              style={!canAct || !manualForced ? dim : undefined}
              onClick={() => void releaseManual()}
            >
              {busy === "release" ? t("Releasing…") : t("Release")}
            </button>
            {manualForced && (
              <span className="forced-state" title={t("Password change forced")}>
                {t("Password change forced")}
              </span>
            )}
          </div>
        </>
      )}
      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
