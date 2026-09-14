/**
 * Group identities (ADR 0007, §3), the second tab of **Enforce Identities**:
 * what a group mailbox sends as.
 *
 * Written **as the Master**, always, because Stalwart refuses to
 * impersonate a group mailbox at all — and the Master is the principal the
 * installation already has for acting on its groups. Where the agent is not
 * granted on a group, this surface says so and names the grant that is missing,
 * rather than a permission error that would read as a bug.
 *
 * A group's account holds **one identity per member** (ADR 0007): all carrying
 * the group's own address, each carrying that member's own display name and
 * signature. So this surface is one row per member of the group's roster, and
 * the identities no roster member claims are listed beneath them as unassigned,
 * editable in place — a stray or renamed one stays visible and fixable.
 *
 * A member's display name is the part the group's own account does not hold: it
 * is the name on the identity of **that member's own account**, read when a row
 * is opened — one impersonation per opened row, never the whole roster up front
 * — and is then the `name` of the identity written here, whose `email` is the
 * group's own address.
 */

import { Pencil, Plus, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Identity } from "@/jmap/types";
import { formatAddressList } from "@/lib/address";
import { t } from "@/lib/i18n";
import {
  type AdminGroupIdentity,
  type AdminIdentityPatch,
  type AdminUserIdentities,
  fetchAdminGroups,
  fetchGroupIdentity,
  fetchUserIdentities,
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

/**
 * What a new identity opens at: the address it will send from — a group's own
 * address — and nothing else yet.
 */
function blankIdentity(name: string, email: string): Partial<Identity> {
  return {
    name,
    email,
    textSignature: "",
    htmlSignature: "",
    replyTo: null,
    bcc: null,
  };
}

/**
 * The member's own display name: the name on the identity of their **own**
 * account — the one whose address is theirs — falling back to the identity that
 * account sends from by default, then to the first it holds. Empty when their
 * own account holds no identity to read a name from.
 */
function ownDisplayName(view: AdminUserIdentities, address: string): string {
  const mine = view.identities.find(
    (identity) => identity.email.toLowerCase() === address.toLowerCase(),
  );
  const chosen =
    mine ??
    view.identities.find((identity) => identity.id === view.defaultIdentityId) ??
    view.identities[0];
  return chosen?.name?.trim() ?? "";
}

/** An identity in one line: its display name and address, or its address alone. */
function identityLabel(identity: Identity): string {
  const name = (identity.name || "").trim();
  return name ? `${name} <${identity.email}>` : identity.email;
}

/**
 * Which of the group's identities each member's own display name claims, and
 * what is left over.
 *
 * Only the members whose own account has been read have a name to match, so an
 * identity bound to a row that has not been opened stays in the unassigned list
 * until that row is read — and an identity no member's name ever matches, a
 * stray or a renamed one, stays there for good. One identity is claimed once, in
 * roster order, so two members who share a display name do not both point at the
 * same identity: the second is shown as having none, which is what it has.
 */
function bindings(
  identities: Identity[],
  members: string[],
  names: Record<string, string | null | undefined>,
): { byMember: Map<string, Identity>; unassigned: Identity[] } {
  const claimed = new Set<string>();
  const byMember = new Map<string, Identity>();
  for (const member of members) {
    const name = names[member.toLowerCase()] || "";
    if (!name) continue;
    const hit = identities.find(
      (identity) => !claimed.has(identity.id) && (identity.name || "").trim() === name,
    );
    if (!hit) continue;
    claimed.add(hit.id);
    byMember.set(member.toLowerCase(), hit);
  }
  return {
    byMember,
    unassigned: identities.filter((identity) => !claimed.has(identity.id)),
  };
}

/** One identity as the fleet shows one: who it sends as, its Reply-To, its signature. */
function IdentityCard({ identity, onEdit }: { identity: Identity; onEdit: () => void }) {
  return (
    <div className="card clickable" onClick={onEdit}>
      <div className="card-head">
        <h3>{identityLabel(identity)}</h3>
        <button
          className="btn btn-sm btn-ghost"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <Pencil size={14} /> {t("Edit")}
        </button>
      </div>
      {identity.replyTo?.length ? (
        <div className="hint">
          {t("Reply-To: {addresses}", { addresses: formatAddressList(identity.replyTo) })}
        </div>
      ) : null}
      {(identity.htmlSignature || identity.textSignature) && (
        <div className="hint" style={{ marginTop: 4 }}>
          {htmlToText(identity.htmlSignature || identity.textSignature).slice(0, 120)}
        </div>
      )}
    </div>
  );
}

/**
 * One member of the roster, and the identity of this group that carries their
 * name.
 *
 * The member's own display name is not in what the group's account says, so it
 * is read from their own account when the row is opened — one impersonation for
 * this row — and it is what preselects the form's display name. Until the row is
 * opened, nothing is asked of that account.
 */
function MemberRow({
  address,
  group,
  name,
  bound,
  onName,
  onEdit,
}: {
  address: string;
  /** The group's own address: what an identity set for this member sends from. */
  group: string;
  /** The member's own display name; undefined until their account has been read. */
  name: string | null | undefined;
  /** The group's identity their name claims, when one does. */
  bound: Identity | undefined;
  onName: (address: string, name: string | null) => void;
  onEdit: (draft: Partial<Identity>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Open this row, reading the member's own display name the first time. */
  async function openRow() {
    setOpen(true);
    if (name !== undefined || reading) return;
    setReading(true);
    setError(null);
    try {
      const view = await fetchUserIdentities(address);
      if (view.impersonation !== "ok") {
        setError(
          t(
            "This member's own account cannot be read — Stalwart refused the impersonation — so which identity carries their name is unknown.",
          ),
        );
        return;
      }
      onName(address, ownDisplayName(view, address));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReading(false);
    }
  }

  const read = name !== undefined;
  /** Whether this row has an answer to show: open, read, and not mid-read. */
  const answered = open && read && !reading && !error;
  /** The identity this member's name claims, when the row has read their account. */
  const held = answered ? bound : undefined;
  return (
    <div className="card clickable" onClick={() => void openRow()}>
      <div className="card-head">
        <h3>{address}</h3>
        {bound !== undefined && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(bound);
            }}
          >
            <Pencil size={14} /> {t("Edit")}
          </button>
        )}
      </div>
      {!open && (
        <div className="hint">
          {t("Open to read their own display name and what it binds.")}
        </div>
      )}
      {open && reading && (
        <div className="hint">{t("Reading this member's own account…")}</div>
      )}
      {open && error && (
        <div className="hint" style={{ color: "var(--warn)" }}>
          {error}
        </div>
      )}
      {held !== undefined && (
        <div className="hint" style={{ color: ACTIVE }}>
          {t("Sends as {identity}", { identity: identityLabel(held) })}
        </div>
      )}
      {answered && held === undefined && (
        <>
          <div className="hint">
            {name
              ? t("No identity of this group carries the name {name} yet.", { name })
              : t(
                  "Their own account holds no display name, so nothing binds an identity to them here.",
                )}
          </div>
          <button
            className="btn btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(blankIdentity(name ?? "", group));
            }}
          >
            <Plus size={16} /> {t("Set identity")}
          </button>
        </>
      )}
    </div>
  );
}

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
  /** What a member's own account said their display name is; absent until read. */
  const [memberNames, setMemberNames] = useState<Record<string, string | null>>({});

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

  /** Read a group's identities and its roster, and whether the agent is granted. */
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
    // Another group is another roster: what its members' own accounts said says
    // nothing about this one's.
    if (who !== name) setMemberNames({});
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

  /** Remember the display name read from a member's own account. */
  function rememberName(address: string, read: string | null) {
    setMemberNames((prev) => ({ ...prev, [address.toLowerCase()]: read }));
  }

  async function save(patch: Partial<Identity>) {
    await saveGroupIdentity(name, editing?.id ?? null, patch as AdminIdentityPatch);
    await load(name);
  }

  const granted = view?.granted === true;
  const identities = view?.identities ?? [];
  const members = view?.members ?? null;
  const { byMember, unassigned } = bindings(identities, members ?? [], memberNames);

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
          "A group holds one identity per member: the group's own address, carrying each member's own display name and signature. An identity reaches mail composed in Gilbert — by a member in the composer, or by the group's agent.",
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
          {granted && identities.length > 0 && (
            <p className="hint" style={{ color: ACTIVE }}>
              {t("Identity active — mail sent as this group carries what is set here.")}
            </p>
          )}
          {loading && <p className="hint">{t("Loading…")}</p>}

          {granted && identities.length > 0 && (
            <>
              <h2>{t("Identities")}</h2>
              {members === null ? (
                <>
                  <div className="warn-box" style={{ marginBottom: 12 }}>
                    {t(
                      "This group's roster could not be read, so its identities are listed on their own rather than by member. Set a member's identity from their own account until the roster reads again.",
                    )}
                  </div>
                  {identities.map((identity) => (
                    <IdentityCard
                      key={identity.id}
                      identity={identity}
                      onEdit={() => setEditing(identity)}
                    />
                  ))}
                </>
              ) : (
                <>
                  <p className="hint">
                    {t(
                      "One identity per member: the group's own address, carrying each member's own display name and signature. Open a member to read the name that binds theirs — one read of that account, and only when you open it.",
                    )}
                  </p>
                  {members.map((member) => (
                    <MemberRow
                      key={member}
                      address={member}
                      group={view.name}
                      name={memberNames[member.toLowerCase()]}
                      bound={byMember.get(member.toLowerCase())}
                      onName={rememberName}
                      onEdit={(draft) => setEditing(draft)}
                    />
                  ))}
                  {members.length === 0 && (
                    <p className="hint">
                      {t(
                        "This group's roster is empty: there is no member to set an identity for.",
                      )}
                    </p>
                  )}

                  <h2>{t("Unassigned")}</h2>
                  <p className="hint">
                    {t(
                      "Identities of this group that no member's own display name claims — a stray one, or one whose member's name has changed. They stay here, editable.",
                    )}
                  </p>
                  {unassigned.length === 0 ? (
                    <p className="hint">
                      {t(
                        "Every identity of this group carries a member's own display name.",
                      )}
                    </p>
                  ) : (
                    unassigned.map((identity) => (
                      <IdentityCard
                        key={identity.id}
                        identity={identity}
                        onEdit={() => setEditing(identity)}
                      />
                    ))
                  )}
                </>
              )}
            </>
          )}

          {granted && !loading && identities.length === 0 && (
            <>
              <h2>{t("Identity")}</h2>
              <p className="hint">{t("This group holds no identity yet.")}</p>
              <button className="btn" onClick={() => setEditing(blankIdentity("", name))}>
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
