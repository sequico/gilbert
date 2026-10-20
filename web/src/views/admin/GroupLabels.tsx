import { sameAddress } from "@gilbert/shared/address";
import { errorMessage } from "@gilbert/shared/errors";
import { AGENT_LABELS, isAgentLabel } from "@gilbert/shared/labels";
import { isGroupAccountRecord } from "@gilbert/shared/sessionAccount";
import { useRef, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { t } from "@/lib/i18n";
import { useSession } from "@/store/session";
import type { Label } from "@/store/settings";
import { confirmDialog } from "@/ui/dialog";
import { askNewLabel, LabelRow, NewLabelButton } from "@/views/labels/LabelCatalog";
import { DirectoryLoadError, DirectoryNotListed, useGroupDirectory } from "./directory";

/**
 * The admin group-label surface (ADR 0004): the label catalog of a group
 * mailbox lives in the group's own Files, and it belongs to the group — members
 * apply it. The pen that reaches those files is the installation's agent's, so
 * this section is authored as the agent and an administrator needs no
 * membership of the group to define or change it. Members read and apply it;
 * renaming a label changes only its display name — the keyword that rides on
 * the messages is stable, so nothing in the mailbox is rewritten.
 *
 * The surface is two sections: the group's own labels, edited as its catalog,
 * and the product's reserved `G-` labels beside them, read-only and drawn from
 * the shared vocabulary (`AGENT_LABELS`) rather than from any catalog — a group
 * owns its labels, and the reserved namespace is never one of them.
 */
export function GroupLabels() {
  const directory = useGroupDirectory();
  const { groups, enumeration, enumerationMessage, loading, loadError } = directory;
  const [selected, setSelected] = useState<string | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // The accounts this session may reach; a group the administrator is a
  // member of appears here under its own address (ADR 0004).
  const session = useSession((s) => s.session);
  const memberOf = (name: string): boolean =>
    Object.values(session?.accounts ?? {}).some(
      (a) => isGroupAccountRecord(a) && sameAddress(a.name, name),
    );
  const selectedIsMember = selected !== null && memberOf(selected);

  /*
   * The group whose catalogue is on screen. A read that lands after the picker
   * moved on belongs to a group nobody is looking at, and writing it down would
   * show one group's catalogue under another's name -- and the next write would
   * then address the wrong group.
   */
  const picked = useRef<string | null>(null);

  async function select(name: string) {
    picked.current = name;
    setSelected(name);
    setLabels([]);
    setEditing(null);
    setError(null);
    try {
      const res = await apiFetch<{ labels: Label[] }>(
        `/api/admin/groups/${encodeURIComponent(name)}/labels`,
      );
      if (picked.current !== name) return;
      const fetched = Array.isArray(res.labels) ? res.labels : [];
      /*
       * The reserved `G-` namespace is the product's own and never a catalog
       * entry (ADR 0004). An entry a document written before the write door
       * refused it still holds is left out of the editable list, and out of the
       * next write, which drops it from the file.
       */
      setLabels(fetched.filter((l) => !isAgentLabel(l.keyword)));
    } catch (err) {
      if (picked.current === name) setError(errorMessage(err));
    }
  }

  async function save(next: Label[]) {
    if (!selected) return;
    const group = selected;
    const prev = labels;
    setLabels(next);
    setBusy(true);
    setError(null);
    try {
      await apiFetch<{ ok: boolean }>(
        `/api/admin/groups/${encodeURIComponent(group)}/labels`,
        { method: "POST", body: JSON.stringify({ labels: next }) },
      );
    } catch (err) {
      /*
       * The optimistic catalogue is not what the server holds: put back what
       * was there -- unless the picker has already moved to another group, in
       * which case this write and this draft are no longer on screen.
       */
      if (picked.current === group) {
        setLabels(prev);
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const label = await askNewLabel(labels);
    if (label) await save([...labels, label]);
  }

  return (
    <div>
      <h1>{t("Group labels")}</h1>
      <p className="lead">
        {t(
          "Labels a group mailbox offers are the group's own, shared by every member. Define or change them here; a rename changes only the name — the keyword on the messages stays the same.",
        )}
      </p>
      {loadError && (
        <DirectoryLoadError loadError={loadError} reload={directory.reload} />
      )}
      {!loading && !enumeration && !loadError && (
        <DirectoryNotListed message={enumerationMessage}>
          {t(
            "Listing group mailboxes needs Stalwart server-administrator privilege, which this session does not have.",
          )}
        </DirectoryNotListed>
      )}
      {!loading && enumeration && (
        <>
          <div className="field" style={{ marginBottom: 16 }}>
            <label>{t("Group mailbox")}</label>
            <select
              className="select"
              value={selected ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v) void select(v);
              }}
              disabled={busy}
            >
              <option value="">{t("Choose a group…")}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          {selected && (
            <>
              {selectedIsMember ? (
                <p className="hint" style={{ marginTop: -8, marginBottom: 12 }}>
                  {t("You are a member of this group — its labels are managed here.")}
                </p>
              ) : (
                <div className="warn-box" style={{ marginBottom: 12 }}>
                  {t(
                    "You are not a member of this group — its label catalog cannot be managed from here.",
                  )}
                </div>
              )}
              <section>
                <h2>{t("Labels")}</h2>
                {labels.length === 0 ? (
                  <p className="hint">{t("No labels yet.")}</p>
                ) : (
                  labels.map((l) => (
                    <LabelRow
                      key={l.keyword}
                      labels={labels}
                      label={l}
                      onChange={(next) => void save(next)}
                      onDelete={() =>
                        void (async () => {
                          // Persists immediately for the whole group, and any
                          // message already carrying the keyword loses its
                          // visible label for every member until it is
                          // re-added — unlike removing an identity or a rule
                          // elsewhere in the admin surface, this had no
                          // confirmation at all.
                          const ok = await confirmDialog({
                            title: t("Delete “{name}”?", { name: l.name }),
                            message: t(
                              "Messages already carrying this label lose it for everyone in the group.",
                            ),
                            confirmLabel: t("Delete"),
                            danger: true,
                          });
                          if (!ok) return;
                          await save(labels.filter((x) => x.keyword !== l.keyword));
                        })()
                      }
                      editing={editing === l.keyword}
                      onEdit={setEditing}
                      busy={busy}
                    />
                  ))
                )}
                <NewLabelButton busy={busy} onClick={() => void add()} />
              </section>
              {/*
               * The reserved `G-` namespace is the product's own, so it is
               * shown beside the group's catalog rather than inside it: the
               * entries come from the shared vocabulary (`AGENT_LABELS`) and
               * this section draws no control at all, which is what keeps them
               * read-only.
               */}
              <section style={{ marginTop: 24 }}>
                <h2>{t("System labels")}</h2>
                <p className="hint">
                  {t(
                    "Gilbert's own labels. Its agent applies them to a message, and they cannot be changed here.",
                  )}
                </p>
                {AGENT_LABELS.map((l) => (
                  <div className="card" key={l.keyword}>
                    <div className="card-head">
                      <span
                        className="label-dot"
                        style={{ background: l.color, width: 14, height: 14 }}
                      />
                      <h3>
                        {l.name}{" "}
                        <span className="hint" style={{ fontWeight: 400 }}>
                          ({l.keyword})
                        </span>
                      </h3>
                    </div>
                  </div>
                ))}
              </section>
            </>
          )}
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
