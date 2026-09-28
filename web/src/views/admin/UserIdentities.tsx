/**
 * User identities (ADR 0007), the first tab of **Identities**: what
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
 *
 * The tab is the person's own account and no other. What that account sends as
 * in a group belongs to the group: the **Group identities** tab writes it, and
 * the person's own Identities & signatures section reads it beside their own
 * list — so nothing of a group's is shown here as well.
 */

import { Plus, RotateCw, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Identity } from "@/jmap/types";
import { t } from "@/lib/i18n";
import {
  deleteUserIdentity,
  fetchUserIdentities,
  type IdentityLockState,
  type IdentityPatch,
  type PersonIdentitiesView,
  saveUserIdentity,
  setUserDefaultIdentity,
  setUserIdentityLock,
  storeAdminSignatureHtml,
} from "@/lib/identities";
import { useSession } from "@/store/session";
import { confirmDialog } from "@/ui/dialog";
import { ACTIVE_COLOR } from "@/ui/misc";
import { IdentityDialog } from "@/views/settings/IdentityDialog";
import {
  DirectoryLoadError,
  DirectoryNotListed,
  DirectoryPicker,
  useUserDirectory,
} from "./directory";
import { IdentityCard } from "./IdentityCard";

export function UserIdentities() {
  const directory = useUserDirectory();
  const { users, enumeration, enumerationMessage, impersonation, loadError } = directory;
  const [address, setAddress] = useState("");
  const [view, setView] = useState<PersonIdentitiesView | null>(null);
  const [loading, setLoading] = useState(false);
  /*
   * The lock as the account's own file answered it, and as this page last wrote
   * it. `null` is nothing read yet; `"unknown"` is the server saying it could
   * not read the file at all, which is a different answer from "not enforced".
   */
  const [locked, setLocked] = useState<IdentityLockState | null>(null);
  const [editing, setEditing] = useState<Partial<Identity> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    directory.reload();
    if (address && (await readAccount(address)))
      setNotice(t("Re-read from the server. What you were editing is still open."));
  }

  async function save(patch: Partial<Identity>) {
    await saveUserIdentity(address, editing?.id ?? null, patch as IdentityPatch);
    await load(address);
  }

  /**
   * Write the account's default sending identity, from this page.
   *
   * One stored value: the same key of the account's own settings document that
   * its Identities & signatures section reads. Setting it here is setting it
   * there, and clearing it here — with `null` — is clearing it there, which is
   * the state where the client falls back to its first identity.
   */
  async function setDefault(identityId: string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await setUserDefaultIdentity(address, identityId);
      await readAccount(address);
      setNotice(
        identityId
          ? t("Default identity saved.")
          : t("No default identity: this account sends with its first."),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
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
   * Write the lock, from this page, with no sign-in in between (ADR 0007).
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
          "Set a person's identities — display name, address, Reply-To, Bcc and signature — or take the account's identity over. The write acts as that person from your own session, so it needs Stalwart's Impersonate permission and a password session; app passwords are refused for impersonation.",
        )}
      </p>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "An identity reaches mail composed in Gilbert. Mail written in another client carries that client's own signature.",
        )}
      </p>

      {loadError && (
        <DirectoryLoadError loadError={loadError} reload={directory.reload} />
      )}
      {denied && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "This session cannot act on accounts: either it uses an app password (which Stalwart refuses for impersonation) or it lacks the \u201cact on behalf of other users\u201d permission in Stalwart. Sign in with your password, or ask the Stalwart administrator to grant that permission.",
          )}
        </div>
      )}
      {!enumeration && !loadError && (
        <DirectoryNotListed message={enumerationMessage}>
          {t(
            "Listing accounts needs Stalwart server-administrator privilege, which this session does not have \u2014 being a Gilbert administrator is not enough. Type an address below instead.",
          )}
        </DirectoryNotListed>
      )}

      <DirectoryPicker
        id="identity-account"
        label={t("Account")}
        value={address}
        entries={users}
        enumerable={enumeration}
        placeholder={t("Choose an account\u2026")}
        typedPlaceholder={t("user@example.com")}
        typedLabel={t("Account address")}
        disabled={denied}
        onChoose={(next) => void load(next)}
      />
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
            <p
              className="hint"
              style={{ color: locked === "unknown" ? "var(--warn)" : ACTIVE_COLOR }}
            >
              {locked === "unknown"
                ? t(
                    "Identity active — the account sends with what is set here. Whether it is also enforced is unknown, and the Enforce controls below say why.",
                  )
                : locked
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
            <IdentityCard
              key={identity.id}
              identity={identity}
              onEdit={() => setEditing(identity)}
              head={
                <button
                  className="btn btn-sm btn-ghost"
                  aria-pressed={view.defaultIdentityId === identity.id}
                  disabled={busy}
                  title={t("Send from this identity by default")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void setDefault(
                      view.defaultIdentityId === identity.id ? null : identity.id,
                    );
                  }}
                >
                  <Star size={14} />{" "}
                  {view.defaultIdentityId === identity.id
                    ? t("Default")
                    : t("Make default")}
                </button>
              }
              trailing={
                identity.mayDelete && (
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
                )
              }
            />
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
              "An enforced account is offered no Identity & signatures section at all, and no signature of its own. A Bcc set on one of its identities is one the person cannot take off, which is worth weighing before the last identity is locked: the address copies every message that identity sends in Gilbert. The lock is a rule about this product's surface, not a boundary: Stalwart has no per-field permission on an identity, so a client that speaks JMAP directly can still write one.",
            )}
          </p>
          {locked === "unknown" && (
            <p className="hint" style={{ color: "var(--warn)" }}>
              {view.lockUnknownReason === "impersonation_denied"
                ? t(
                    "Whether this account is enforced is unknown: Stalwart refused the impersonation that reads its lock, which is a file in the account's own folder. Enforce and Release stay off until it answers.",
                  )
                : t(
                    "Whether this account is enforced is unknown: its lock could not be read. Enforce and Release stay off until it answers.",
                  )}
            </p>
          )}
          <div
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            <button
              className="btn btn-primary"
              disabled={busy || !reachable || locked === true}
              onClick={() => void setLock(true)}
            >
              {locked === true ? t("Enforced") : t("Enforce")}
            </button>
            <button
              className="btn"
              disabled={busy || !reachable || locked !== true}
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
