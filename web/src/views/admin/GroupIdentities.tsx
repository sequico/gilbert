/**
 * Group identities (ADR 0007 §2, §3), the second tab of **Enforce Identities**:
 * what a group mailbox sends as.
 *
 * Written **as the Master**, always, because Stalwart refuses to
 * impersonate a group mailbox at all — and the Master is the principal the
 * installation already has for acting on its groups. Where the agent is not
 * granted on a group, this surface says so and names the grant that is missing,
 * rather than a permission error that would read as a bug.
 *
 * A group holds **one** identity: a group mailbox sends as itself. That is a
 * rule of the product, not of the server, and the surface offers exactly one —
 * so Add appears only when there is none, and an edit is an edit of that one.
 */

import { Pencil, Plus, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Identity } from "@/jmap/types";
import { formatAddressList } from "@/lib/address";
import { t } from "@/lib/i18n";
import {
  type AdminGroupIdentity,
  type AdminIdentityPatch,
  fetchAdminGroups,
  fetchGroupIdentity,
  saveGroupIdentity,
  storeAdminSignatureHtml,
} from "@/lib/identities";
import { htmlToText } from "@/lib/text";
import { MenuSelect } from "@/ui/popover";
import { IdentityDialog } from "@/views/settings/IdentityDialog";

interface DirectoryGroup {
  id: string;
  name: string;
}

/** The state a signature shows, in one line, the way the fleet does. */
const ACTIVE = "var(--ok, #2e7d32)";

export function GroupIdentities() {
  const [groups, setGroups] = useState<DirectoryGroup[]>([]);
  const [enumeration, setEnumeration] = useState(true);
  const [enumerationMessage, setEnumerationMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [view, setView] = useState<AdminGroupIdentity | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<Identity> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadDirectory() {
    setLoadError(null);
    try {
      const res = await fetchAdminGroups();
      setGroups(res.groups);
      setEnumeration(res.enumeration);
      setEnumerationMessage(res.enumerationMessage ?? null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => {
    void loadDirectory();
  }, []);

  /** Read the chosen group's identity, and whether the agent is granted on it. */
  async function readGroup(who: string) {
    setLoading(true);
    try {
      setView(await fetchGroupIdentity(who));
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
    setName(who);
    setEditing(null);
    setError(null);
    if (!who) {
      setView(null);
      return;
    }
    await readGroup(who);
  }

  /**
   * Re-read the group and the directory from the server. A draft stays where it
   * is: re-reading is no reason to throw away what the administrator typed.
   */
  async function reload() {
    setError(null);
    await loadDirectory();
    if (name) await readGroup(name);
  }

  async function save(patch: Partial<Identity>) {
    await saveGroupIdentity(name, editing?.id ?? null, patch as AdminIdentityPatch);
    await load(name);
  }

  const granted = view?.granted === true;

  return (
    <div>
      <h1>{t("Group identities")}</h1>
      <p className="lead">
        {t(
          "Set what a group mailbox sends as. It is written as the Master, because Stalwart refuses to impersonate a group mailbox — the Master is the principal that exists for acting on a group's behalf.",
        )}
      </p>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "A group holds one identity: a group mailbox sends as itself. An identity reaches mail composed in Gilbert — by a member in the composer, or by the group's agent.",
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
      {!enumeration && !loadError && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "Listing group mailboxes needs Stalwart server-administrator privilege, which this session does not have \u2014 being a Gilbert administrator is not enough. Type a group address below instead.",
          )}
          {enumerationMessage && (
            <p className="hint" style={{ marginTop: 6 }}>
              <code>{enumerationMessage}</code>
            </p>
          )}
        </div>
      )}

      <div className="field" style={{ maxWidth: "28rem" }}>
        <label htmlFor="identity-group">{t("Group mailbox")}</label>
        {enumeration ? (
          <MenuSelect
            id="identity-group"
            value={name}
            placeholder={t("Choose a group…")}
            ariaLabel={t("Group mailbox")}
            options={groups.map((g) => ({ id: g.id, value: g.name }))}
            onPick={(next) => void load(next)}
          />
        ) : (
          <input
            id="identity-group"
            className="input"
            defaultValue={name}
            placeholder={t("team@example.org")}
            aria-label={t("Group mailbox")}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(e.currentTarget.value);
            }}
          />
        )}
      </div>
      <div style={{ marginBottom: 12 }}>
        <button className="btn" disabled={loading || !name} onClick={() => void reload()}>
          <RotateCw size={16} /> {t("Reload identities")}
        </button>
      </div>

      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {view && (
        <>
          {!granted && (
            <div className="warn-box" style={{ marginTop: 12, marginBottom: 12 }}>
              {t(
                "The Master is not a member of this group, so nothing here can write its identity. Grant the agent on that group — the same grant that lets it work in the group at all — and look again.",
              )}
            </div>
          )}
          {granted && view.identity && (
            <p className="hint" style={{ color: ACTIVE }}>
              {t("Identity active — mail sent as this group carries what is set here.")}
            </p>
          )}
          {loading && <p className="hint">{t("Loading…")}</p>}

          {granted && view.identity && (
            <>
              <h2>{t("Identity")}</h2>
              <div className="card clickable" onClick={() => setEditing(view.identity)}>
                <div className="card-head">
                  <h3>
                    {view.identity.name
                      ? `${view.identity.name} <${view.identity.email}>`
                      : view.identity.email}
                  </h3>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(view.identity);
                    }}
                  >
                    <Pencil size={14} /> {t("Edit")}
                  </button>
                </div>
                {view.identity.replyTo?.length ? (
                  <div className="hint">
                    {t("Reply-To: {addresses}", {
                      addresses: formatAddressList(view.identity.replyTo),
                    })}
                  </div>
                ) : null}
                {(view.identity.htmlSignature || view.identity.textSignature) && (
                  <div className="hint" style={{ marginTop: 4 }}>
                    {htmlToText(
                      view.identity.htmlSignature || view.identity.textSignature,
                    ).slice(0, 120)}
                  </div>
                )}
              </div>
            </>
          )}

          {granted && !view.identity && !loading && (
            <>
              <h2>{t("Identity")}</h2>
              <p className="hint">{t("This group holds no identity yet.")}</p>
              <button
                className="btn"
                onClick={() =>
                  setEditing({
                    name: "",
                    email: name,
                    textSignature: "",
                    htmlSignature: "",
                    replyTo: null,
                    bcc: null,
                  })
                }
              >
                <Plus size={16} /> {t("Add identity")}
              </button>
            </>
          )}
        </>
      )}

      {editing && (
        <IdentityDialog
          identity={editing}
          onClose={() => setEditing(null)}
          save={save}
          // The over-sized copy lands in the group's own Files, which the agent
          // this write acts as is granted on.
          assets={{ storeHtml: (html) => storeAdminSignatureHtml("group", name, html) }}
        />
      )}
    </div>
  );
}
