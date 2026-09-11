/**
 * User identities (ADR 0010 §1): what an administrator sets on a person's
 * account, through the same form the person's own settings use.
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

import { Pencil, Plus, Trash2 } from "lucide-react";
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
import { confirmDialog } from "@/ui/dialog";
import { TypeSelect } from "@/ui/TypeSelect";
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
    setLoading(true);
    try {
      const res = await fetchUserIdentities(who);
      setView(res);
      setLocked(res.locked);
    } catch (err) {
      setView(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
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

  async function applyLock() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const now = await setUserIdentityLock(address, locked);
      setLocked(now);
      setNotice(
        now
          ? t(
              "Locked. The account's Identity & signatures section is gone from its next sign-in, and its open sessions were signed out.",
            )
          : t("Unlocked. The account can set its own identities again."),
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
        <label>{t("Account")}</label>
        <TypeSelect
          value={address}
          onChange={(v) => void load(v)}
          options={users.map((u) => ({ value: u.name, label: u.name }))}
          placeholder={t("user@example.com")}
          ariaLabel={t("Account address")}
          allowFreeText
          disabled={denied}
        />
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

          <h2>{t("Lock")}</h2>
          <p className="hint">
            {t(
              "A locked account is offered no Identity & signatures section at all, and no signature of its own. The lock is a rule about this product's surface, not a boundary: Stalwart has no per-field permission on an identity, so a client that speaks JMAP directly can still write one.",
            )}
          </p>
          <div
            style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
          >
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={locked}
                disabled={busy || !reachable}
                onChange={(e) => setLocked(e.target.checked)}
              />
              <span>{t("An administrator set this account's identity")}</span>
            </label>
            <button
              className="btn btn-primary"
              disabled={busy || !reachable || locked === view.locked}
              onClick={() => void applyLock()}
            >
              {busy ? t("Applying…") : t("Apply")}
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
