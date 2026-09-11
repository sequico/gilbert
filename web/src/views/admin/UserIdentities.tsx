/**
 * User identities (ADR 0010 §1), the first tab of **Enforce Identities**: what
 * an administrator sets on a person's account, through the same form the
 * person's own settings use.
 *
 * The write is an impersonation of that person from this session, so the gate is
 * Stalwart's own permission model and there is no second credential anywhere in
 * it. What the surface adds is the two things the person's own settings cannot
 * say: the account's **whole** list — every identity it holds, including ones a
 * person made before the administrator took it over — and the **lock**, recorded
 * in the installation's policy, which takes the person's own section away.
 *
 * `mayDelete` is the server's answer about whether an identity may go, and the
 * surface respects it rather than inventing a rule of its own about the last one.
 */

import { Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Identity } from "@/jmap/types";
import { formatAddressList } from "@/lib/address";
import { t } from "@/lib/i18n";
import {
  type AdminIdentityPatch,
  type AdminUserIdentities,
  deleteUserIdentity,
  fetchAdminUserDirectory,
  fetchUserIdentities,
  type Impersonation,
  saveUserIdentity,
  setUserIdentityLock,
  storeAdminSignatureHtml,
} from "@/lib/identities";
import { htmlToText } from "@/lib/text";
import { useSession } from "@/store/session";
import { confirmDialog } from "@/ui/dialog";
import { IdentityDialog } from "@/views/settings/IdentityDialog";

interface DirectoryUser {
  id: string;
  name: string;
}

/** The state a signature shows, in one line, the way the fleet does. */
const ACTIVE = "var(--ok, #2e7d32)";

export function UserIdentities() {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [enumeration, setEnumeration] = useState(true);
  const [enumerationMessage, setEnumerationMessage] = useState<string | null>(null);
  const [impersonation, setImpersonation] = useState<Impersonation>("unknown");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [view, setView] = useState<AdminUserIdentities | null>(null);
  const [loading, setLoading] = useState(false);
  const [locked, setLocked] = useState(false);
  const [editing, setEditing] = useState<Partial<Identity> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The accounts the picker offers, and what the server said about acting. */
  async function loadDirectory() {
    setLoadError(null);
    try {
      const res = await fetchAdminUserDirectory();
      setUsers(res.users);
      setEnumeration(res.enumeration);
      setEnumerationMessage(res.enumerationMessage ?? null);
      setImpersonation(res.impersonation);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => {
    void loadDirectory();
  }, []);

  /** Read the chosen account's identities, and whether it is locked. */
  async function readAccount(who: string) {
    setLoading(true);
    try {
      const res = await fetchUserIdentities(who);
      setView(res);
      setLocked(res.locked);
      return true;
    } catch (err) {
      setView(null);
      setError((err as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function load(target: string) {
    const who = target.trim().toLowerCase();
    setAddress(who);
    setEditing(null);
    setNotice(null);
    setError(null);
    if (!who) {
      setView(null);
      return;
    }
    await readAccount(who);
  }

  /**
   * Re-read the account and the directory from the server.
   *
   * This is what an administrator reaches for after deleting an identity in
   * Stalwart's own administration: the list is the server's and is read again
   * whole, while `editing` is deliberately left where it is — a draft belongs to
   * the administrator, and re-reading is no reason to throw it away.
   */
  async function reload() {
    setError(null);
    setNotice(null);
    await loadDirectory();
    if (address && (await readAccount(address)))
      setNotice(t("Re-read from the server. What you were editing is still open."));
  }

  async function save(patch: Partial<Identity>) {
    await saveUserIdentity(address, editing?.id ?? null, patch as AdminIdentityPatch);
    await load(address);
  }

  async function remove(identity: Identity) {
    if (
      !(await confirmDialog({
        title: t("Delete this identity?"),
        confirmLabel: t("Delete"),
        danger: true,
      }))
    )
      return;
    setError(null);
    try {
      await deleteUserIdentity(address, identity.id);
      await load(address);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Write the lock, from this page, with no sign-in in between (ADR 0010 §4).
   *
   * The lock lives in the installation's policy document, and what makes it
   * visible here is this session re-reading its own record: the surface in front
   * of the administrator is the one that sees it first, and a session already
   * open sees it the next time it asks. Nobody is signed out over a policy rule.
   */
  async function setLock(next: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setLocked(await setUserIdentityLock(address, next));
      await useSession.getState().refresh();
      setNotice(
        next
          ? t("Enforced — applied at once, with no sign-in needed.")
          : t("Released — the account can set its own identities again."),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const denied = impersonation === "denied";
  const reachable = view !== null && view.impersonation === "ok";

  return (
    <div>
      <h1>{t("User identities")}</h1>
      <p className="lead">
        {t(
          "Set a person's identities — display name, address, Reply-To and signature — or take the account's identity over. The write acts as that person from your own session, so it needs Stalwart's Impersonate permission and a password session; app passwords are refused for impersonation.",
        )}
      </p>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "An identity reaches mail composed in Gilbert. Mail written in another client carries that client's own signature.",
        )}
      </p>

      {loadError && (
        <div className="error-box">
          {loadError}
          <p>
            <button className="btn" onClick={() => void loadDirectory()}>
              {t("Retry")}
            </button>
          </p>
        </div>
      )}
      {denied && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "This session cannot act on accounts: either it uses an app password (which Stalwart refuses for impersonation) or it lacks the \u201cact on behalf of other users\u201d permission in Stalwart. Sign in with your password, or ask the Stalwart administrator to grant that permission.",
          )}
        </div>
      )}
      {!enumeration && !loadError && (
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

      <div className="field" style={{ maxWidth: "28rem" }}>
        <label htmlFor="identity-account">{t("Account")}</label>
        {enumeration ? (
          <select
            id="identity-account"
            className="select"
            value={address}
            disabled={denied}
            onChange={(e) => void load(e.target.value)}
          >
            <option value="">{t("Choose an account…")}</option>
            {users.map((u) => (
              <option key={u.id} value={u.name}>
                {u.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            id="identity-account"
            className="input"
            defaultValue={address}
            placeholder={t("user@example.com")}
            aria-label={t("Account address")}
            disabled={denied}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(e.currentTarget.value);
            }}
          />
        )}
      </div>
      <div style={{ marginBottom: 12 }}>
        <button
          className="btn"
          disabled={loading || !address}
          onClick={() => void reload()}
        >
          <RotateCw size={16} /> {t("Reload identities")}
        </button>
      </div>

      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {view && !denied && (
        <>
          {view.impersonation === "ok" && (
            <p className="hint" style={{ color: ACTIVE }}>
              {locked
                ? t(
                    "Identity active — this account sends with what is set here, and is offered no Identities & signatures section of its own.",
                  )
                : t("Identity active — the account sends with what is set here.")}
            </p>
          )}
          {view.impersonation !== "ok" && (
            <p className="hint" style={{ color: "var(--warn)" }}>
              {t(
                "This account cannot be read: Stalwart refused the impersonation. Nothing is written until it answers.",
              )}
            </p>
          )}

          <h2>{t("Identities")}</h2>
          {loading && <p className="hint">{t("Loading…")}</p>}
          {!loading && view.identities.length === 0 && (
            <p className="hint">{t("This account holds no identity yet.")}</p>
          )}
          {view.identities.map((identity) => (
            <div
              key={identity.id}
              className="card clickable"
              onClick={() => setEditing(identity)}
            >
              <div className="card-head">
                <h3>
                  {identity.name
                    ? `${identity.name} <${identity.email}>`
                    : identity.email}
                </h3>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(identity);
                  }}
                >
                  <Pencil size={14} /> {t("Edit")}
                </button>
                {identity.mayDelete && (
                  <button
                    className="icon-btn sm danger"
                    aria-label={t("Delete identity")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(identity);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              {identity.replyTo?.length ? (
                <div className="hint">
                  {t("Reply-To: {addresses}", {
                    addresses: formatAddressList(identity.replyTo),
                  })}
                </div>
              ) : null}
              {(identity.htmlSignature || identity.textSignature) && (
                <div className="hint" style={{ marginTop: 4 }}>
                  {htmlToText(identity.htmlSignature || identity.textSignature).slice(
                    0,
                    120,
                  )}
                </div>
              )}
            </div>
          ))}
          <button
            className="btn"
            onClick={() =>
              setEditing({
                name: "",
                email: view.identities[0]?.email ?? address,
                textSignature: "",
                htmlSignature: "",
                replyTo: null,
                bcc: null,
              })
            }
          >
            <Plus size={16} /> {t("Add identity")}
          </button>
          <p className="hint mt-8">
            {t(
              "The account's whole list is shown, and every entry is editable: nothing is left behind as an identity the composer still offers.",
            )}
          </p>

          <h2>{t("Enforce")}</h2>
          <p className="hint">
            {t(
              "An enforced account is offered no Identity & signatures section at all, and no signature of its own. The lock is a rule about this product's surface, not a boundary: Stalwart has no per-field permission on an identity, so a client that speaks JMAP directly can still write one.",
            )}
          </p>
          <div
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            <button
              className="btn btn-primary"
              disabled={busy || !reachable || locked}
              onClick={() => void setLock(true)}
            >
              {locked ? t("Enforced") : t("Enforce")}
            </button>
            <button
              className="btn"
              disabled={busy || !reachable || !locked}
              onClick={() => void setLock(false)}
            >
              {t("Release")}
            </button>
            {notice && <span className="hint">{notice}</span>}
          </div>
        </>
      )}

      {editing && (
        <IdentityDialog
          identity={editing}
          onClose={() => setEditing(null)}
          save={save}
          // An over-sized signature is kept in the person's own Files — the
          // account this write impersonates — while a picture is refused: it
          // would have to be rendered back through this administrator's own
          // session, which does not hold that account.
          assets={{
            storeHtml: (html) => storeAdminSignatureHtml("user", address, html),
          }}
        />
      )}
    </div>
  );
}
