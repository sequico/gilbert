/**
 * Group identities (ADR 0007), the second tab of **Identities**: what a
 * group mailbox sends as, and who sends as which.
 *
 * Written **as the Master**, always, because Stalwart refuses to impersonate a
 * group mailbox at all — and the Master is the principal the installation
 * already has for acting on its groups. Where the agent is not granted on a
 * group, this surface says so and names the grant that is missing, rather than a
 * permission error that would read as a bug.
 *
 * A group's account holds **one identity per member** (ADR 0007): all carrying
 * the group's own address, each carrying that member's own display name and
 * signature. So this surface is one row per member of the group's roster, and
 * **the binding is an assignment it writes** — not a display name compared on
 * both sides. That is what makes the rows answerable: assigned, and the row says
 * what the member sends as; not assigned, and the row says so and offers to
 * assign one. A name is a thing a recipient reads, and a binding kept in one
 * fails on any rename and any spelling.
 *
 * The identities no member is assigned are listed beneath the roster. The
 * group's own is among them, and it is not a leftover: it is what a member with
 * no assignment sends as, which is also what the agent sends as, so a group
 * nobody has been assigned in still writes as the group rather than under
 * somebody's name.
 *
 * A member's display name is the part the group's own account does not hold: it
 * is the name on the identity of **that member's own account**, read when a row
 * is opened — one impersonation per opened row, never the whole roster up front
 * — and it is what prefills the form, so nobody types a colleague's name twice.
 *
 * A group holds **one identity per member** of the roster it can read, so when
 * the registry answers nothing this surface lists the identities on their own
 * and says that an assignment cannot be made until it reads again.
 */

import { Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { Identity } from "@/jmap/types";
import { t } from "@/lib/i18n";
import {
  deleteGroupIdentity,
  fetchGroupIdentity,
  fetchUserIdentities,
  type GroupIdentityView,
  type IdentityPatch,
  type PersonIdentitiesView,
  saveGroupIdentity,
  storeAdminSignatureHtml,
} from "@/lib/identities";
import { ownIdentity } from "@/lib/identityVisibility";
import { confirmDialog } from "@/ui/dialog";
import { ACTIVE_COLOR } from "@/ui/misc";
import { IdentityDialog } from "@/views/settings/IdentityDialog";
import {
  DirectoryLoadError,
  DirectoryNotListed,
  DirectoryPicker,
  useGroupDirectory,
} from "./directory";
import { IdentityCard, identityLabel } from "./IdentityCard";

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
 * account that is theirs — the one rule for that, shared with the picker that
 * has to match it (`ownIdentity`, ADR 0007). Empty when their own account holds
 * no identity to read a name from.
 */
function ownDisplayName(view: PersonIdentitiesView, address: string): string {
  const chosen = ownIdentity(view.identities, address, view.defaultIdentityId);
  return chosen?.name?.trim() ?? "";
}

/**
 * Which identity each member of the roster is assigned, and what is left.
 *
 * The binding is a **record** (ADR 0007), not a display name compared on both
 * sides: `assignments` maps a member's address to the id of an identity of this
 * group, which the administration wrote in the same action that wrote the
 * identity. So a row's answer is read rather than inferred — a rename in the
 * member's own account, a name spelled differently, a member whose account sets
 * no name at all: none of them changes who sends as what.
 *
 * `rest` is every identity no member is assigned, in the order the group holds
 * them. The group's own is among them (`groupSenderId`) and is what a member
 * with no assignment sends as, which is why the list is a state to read rather
 * than a pile of leftovers.
 */
function assignmentsOf(
  identities: Identity[],
  members: string[],
  assignments: Record<string, string>,
): { byMember: Map<string, Identity>; rest: Identity[] } {
  const byMember = new Map<string, Identity>();
  const taken = new Set<string>();
  for (const member of members) {
    const id = assignments[member.toLowerCase()];
    if (!id) continue;
    const identity = identities.find((i) => i.id === id);
    // An assignment naming an identity this account no longer holds is read as
    // none: the list in hand is the proof, and a row cannot show a sender that
    // does not exist.
    if (!identity) continue;
    byMember.set(member.toLowerCase(), identity);
    taken.add(identity.id);
  }
  return { byMember, rest: identities.filter((i) => !taken.has(i.id)) };
}

/**
 * One member of the roster, and the identity of this group assigned to them.
 *
 * Whether they have one is a **fact the administration recorded** (ADR 0007),
 * so the row answers from it rather than from a name compared on both sides:
 * assigned, and it says what they send as; not assigned, and it offers to
 * assign one. Nothing is read from the member's own account until that is
 * wanted, and then only for one thing — the display name to prefill the form
 * with, which is the name a recipient reads and not a key.
 */
function MemberRow({
  address,
  group,
  name,
  assigned,
  senderIsGroup,
  onName,
  onAssign,
  onEdit,
  onDelete,
}: {
  address: string;
  /** The group's own address: what an identity set for this member sends from. */
  group: string;
  /** The member's own display name; undefined until their account has been read. */
  name: string | null | undefined;
  /** The identity this member is assigned, when one is. */
  assigned: Identity | undefined;
  /** Whether `assigned` is the group's own identity, which anybody may be given. */
  senderIsGroup: boolean;
  onName: (address: string, name: string | null) => void;
  onAssign: (member: string, draft: Partial<Identity>) => void;
  onEdit: (member: string, identity: Identity) => void;
  onDelete: (member: string, identity: Identity) => void;
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
            "This member's own account cannot be read — Stalwart refused the impersonation — so the name to write on their identity is unknown. An identity can still be written for them by typing a name.",
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
  /** Whether the name to prefill a form with has been read and is usable. */
  const answered = open && read && !reading && !error;
  const prefill = answered && name ? name : null;
  return (
    <div className="card clickable" onClick={() => void openRow()}>
      <div className="card-head">
        <h3>{address}</h3>
        {assigned && (
          <>
            <button
              className="btn btn-sm btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(address, assigned);
              }}
            >
              <Pencil size={14} /> {t("Edit")}
            </button>
            {/* The member's own sender going away: the identity they were
                assigned is deleted, so they send as the group itself. Not
                offered on the group's own identity, which everybody falls
                back to and nothing may delete. */}
            {!senderIsGroup && (
              <button
                className="icon-btn sm danger"
                aria-label={t("Delete identity")}
                title={t("Delete this identity so the member sends as the group")}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(address, assigned);
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
          </>
        )}
      </div>
      {!open && (
        <div className="hint">
          {t("Open to read their own display name and what they send as.")}
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
      {assigned && (
        <div className="hint" style={{ color: ACTIVE_COLOR }}>
          {t("Sends as {identity}", { identity: identityLabel(assigned) })}
        </div>
      )}
      {assigned && senderIsGroup && (
        <div className="hint">
          {t(
            "That is the group's own identity, which is also what the agent sends as — so mail from this member is indistinguishable from the group's.",
          )}
        </div>
      )}
      {!assigned && (
        <>
          <div className="hint">
            {t(
              "No identity is assigned to this member yet, so they send as the group itself.",
            )}
          </div>
          {open && !error && (
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                onAssign(address, blankIdentity(prefill ?? "", group));
              }}
            >
              <Plus size={16} /> {t("Assign identity")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function GroupIdentities() {
  const directory = useGroupDirectory();
  const { groups, enumeration, enumerationMessage, loadError } = directory;
  const [name, setName] = useState("");
  const [view, setView] = useState<GroupIdentityView | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{
    /** The member address the write assigns to; "" for the group's own. */
    member: string;
    draft: Partial<Identity>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What a member's own account said their display name is; absent until read. */
  const [memberNames, setMemberNames] = useState<Record<string, string | null>>({});

  /**
   * Which group read is the one that counts.
   *
   * Two groups can be asked for in that order and answer in the other, and the
   * slower one would then leave its identities under the newer group's name --
   * the panel reads `name` and `view` as one thing, and so does a write made
   * from it. A read takes a number, and one whose number has moved keeps its
   * answer to itself.
   */
  const readSeq = useRef(0);

  /** Read a group's identities and its roster, and whether the agent is granted. */
  async function readGroup(who: string) {
    const seq = ++readSeq.current;
    setLoading(true);
    try {
      const next = await fetchGroupIdentity(who);
      if (seq !== readSeq.current) return false;
      setView(next);
      return true;
    } catch (err) {
      if (seq !== readSeq.current) return false;
      setView(null);
      setError((err as Error).message);
      return false;
    } finally {
      // The newer read owns the spinner: clearing it here would end one still
      // in flight.
      if (seq === readSeq.current) setLoading(false);
    }
  }

  async function load(target: string) {
    const who = target.trim().toLowerCase();
    // Another group is another roster: what its members' own accounts said says
    // nothing about this one's, and neither do its identities -- they are not
    // shown under the new group's name while its own answer is on its way.
    if (who !== name) {
      setMemberNames({});
      setView(null);
    }
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
    directory.reload();
    if (name) await readGroup(name);
  }

  /** Remember the display name read from a member's own account. */
  function rememberName(address: string, read: string | null) {
    setMemberNames((prev) => ({ ...prev, [address.toLowerCase()]: read }));
  }

  async function save(patch: Partial<Identity>) {
    if (!editing) return;
    await saveGroupIdentity(
      name,
      editing.member,
      editing.draft.id ?? null,
      patch as IdentityPatch,
    );
    await load(name);
  }

  const granted = view?.granted === true;
  const identities = view?.identities ?? [];
  const members = view?.members ?? null;
  const assignments = view?.assignments ?? {};
  const groupSenderId = view?.groupSenderId ?? null;
  const { byMember, rest } = assignmentsOf(identities, members ?? [], assignments);

  /** Open the form for one member's identity: theirs, or a new one for them. */
  function assign(member: string, draft: Partial<Identity>) {
    setEditing({ member, draft });
  }

  /** Open the form on an identity this member already sends as. */
  function edit(member: string, identity: Identity) {
    setEditing({ member, draft: identity });
  }

  /**
   * Delete the identity a member was assigned.
   *
   * The member then falls back to the group's own identity, which is what a
   * member with no identity of their own sends as — so the trash is the
   * member's own sender going away, not the group's.
   */
  async function remove(member: string, identity: Identity) {
    if (
      !(await confirmDialog({
        title: t("Delete {identity}?", { identity: identityLabel(identity) }),
        message: t("{member} will then send as the group itself.", { member }),
        confirmLabel: t("Delete"),
        danger: true,
      }))
    )
      return;
    setError(null);
    try {
      await deleteGroupIdentity(name, identity.id);
      await load(name);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * The state of a group whose account holds nothing yet, and how to start its
   * first identity.
   *
   * A group with no identity has nothing to send as at all — the composer in
   * its mailbox offers no sender and says so — and the identity made here is the
   * group's own until somebody is assigned it, so the row that owns it is the
   * group's own rather than a member's.
   */
  const noIdentityYet = (
    <>
      <p className="hint">
        {t("This group holds no identity yet, so nothing can be sent from its mailbox.")}
      </p>
      <button
        className="btn"
        onClick={() => setEditing({ member: "", draft: blankIdentity("", name) })}
      >
        <Plus size={16} /> {t("Add identity")}
      </button>
    </>
  );

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
          "A group holds one identity per member: the group's own address, carrying each member's own display name and signature. An identity reaches mail composed in Gilbert — by a member in the composer, or by the group's agent. A Bcc on one copies every message that identity sends, which for a group's mail is everything written as the group.",
        )}
      </p>

      {loadError && (
        <DirectoryLoadError loadError={loadError} reload={directory.reload} />
      )}
      {!enumeration && !loadError && (
        <DirectoryNotListed message={enumerationMessage}>
          {t(
            "Listing group mailboxes needs Stalwart server-administrator privilege, which this session does not have — being a Gilbert administrator is not enough. Type a group address below instead.",
          )}
        </DirectoryNotListed>
      )}

      <DirectoryPicker
        id="identity-group"
        label={t("Group mailbox")}
        value={name}
        entries={groups}
        enumerable={enumeration}
        placeholder={t("Choose a group…")}
        typedPlaceholder={t("team@example.org")}
        typedLabel={t("Group mailbox")}
        onChoose={(next) => void load(next)}
      />
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
            <p className="hint" style={{ color: ACTIVE_COLOR }}>
              {t("Identity active — mail sent as this group carries what is set here.")}
            </p>
          )}
          {loading && <p className="hint">{t("Loading…")}</p>}

          {granted && members === null && (
            <>
              <h2>{t("Identities")}</h2>
              <div className="warn-box" style={{ marginBottom: 12 }}>
                {t(
                  "This group's roster could not be read, so which member each identity belongs to cannot be shown. The identities are listed on their own, and an assignment cannot be made until the registry reads again — the whole ordering of who sends as what depends on it.",
                )}
              </div>
              {identities.map((identity) => (
                <IdentityCard
                  key={identity.id}
                  identity={identity}
                  onEdit={() => edit("", identity)}
                />
              ))}
              {identities.length === 0 && noIdentityYet}
            </>
          )}

          {granted && members !== null && (
            <>
              <h2>{t("Who sends as what")}</h2>
              <p className="hint">
                {t(
                  "Each member is assigned one of this group's identities: the group's own address, carrying that member's own display name and signature. Open a member to read the name to write on theirs — one read of that account, and only when you open it.",
                )}
              </p>
              {members.map((member) => {
                const held = byMember.get(member.toLowerCase());
                return (
                  <MemberRow
                    key={member}
                    address={member}
                    group={view.name}
                    name={memberNames[member.toLowerCase()]}
                    assigned={held}
                    senderIsGroup={held !== undefined && held.id === groupSenderId}
                    onName={rememberName}
                    onAssign={assign}
                    onEdit={edit}
                    onDelete={remove}
                  />
                );
              })}
              {members.length === 0 && (
                <p className="hint">
                  {t(
                    "This group's roster is empty: there is no member to assign an identity to.",
                  )}
                </p>
              )}

              <h2>{t("Not assigned to a member")}</h2>
              <p className="hint">
                {t(
                  "Identities no member is assigned. The group's own is among them, and it is what a member with no identity of their own sends as — the same identity the agent sends as, so a group with nobody assigned still writes as the group rather than under somebody's name.",
                )}
              </p>
              {identities.length === 0 ? (
                noIdentityYet
              ) : rest.length === 0 ? (
                <p className="hint">
                  {t("Every identity of this group is assigned to a member.")}
                </p>
              ) : (
                rest.map((identity) => (
                  <IdentityCard
                    key={identity.id}
                    identity={identity}
                    onEdit={() => edit("", identity)}
                  />
                ))
              )}
            </>
          )}
        </>
      )}

      {editing && (
        <IdentityDialog
          identity={editing.draft}
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
