import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { groupAccessSentence } from "@/lib/groupAccess";
import { t } from "@/lib/i18n";
import { useSession } from "@/store/session";
import type { Label } from "@/store/settings";
import { confirmDialog } from "@/ui/dialog";
import { askNewLabel, LabelRow, NewLabelButton } from "@/views/labels/LabelCatalog";

interface DirectoryGroup {
  id: string;
  name: string;
}

/**
 * The admin group-label surface (ADR 0005): the label catalog of a group
 * mailbox lives in the group's own Files, and it belongs to the group — members
 * apply it. The pen that reaches those files is the installation's agent's, so
 * this section is authored as the agent and an administrator needs no
 * membership of the group to define or change it. Members read and apply it;
 * renaming a label changes only its display name — the keyword that rides on
 * the messages is stable, so nothing in the mailbox is rewritten.
 */
export function GroupLabels() {
  const [groups, setGroups] = useState<DirectoryGroup[] | null>(null);
  const [enumeration, setEnumeration] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // The accounts this session may reach; a group the administrator is a
  // member of appears here under its own address (ADR 0005).
  const session = useSession((s) => s.session);
  const memberOf = (name: string): boolean => {
    const want = name.trim().toLowerCase();
    return Object.values(session?.accounts ?? {}).some(
      (a) =>
        a.isPersonal === false &&
        typeof a.name === "string" &&
        a.name.trim().toLowerCase() === want,
    );
  };
  const selectedIsMember = selected !== null && memberOf(selected);

  async function loadGroups() {
    setLoadError(null);
    try {
      const res = await apiFetch<{
        groups: DirectoryGroup[];
        enumeration: boolean;
        enumerationMessage?: string | null;
      }>("/api/admin/groups");
      setGroups(res.groups);
      setEnumeration(res.enumeration);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void loadGroups();
  }, []);

  async function select(name: string) {
    setSelected(name);
    setLabels([]);
    setEditing(null);
    setError(null);
    try {
      const res = await apiFetch<{ labels: Label[] }>(
        `/api/admin/groups/${encodeURIComponent(name)}/labels`,
      );
      setLabels(Array.isArray(res.labels) ? res.labels : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function save(next: Label[]) {
    if (!selected) return;
    setLabels(next);
    setBusy(true);
    setError(null);
    try {
      await apiFetch<{ ok: boolean }>(
        `/api/admin/groups/${encodeURIComponent(selected)}/labels`,
        { method: "POST", body: JSON.stringify({ labels: next }) },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      <p className="hint" style={{ marginBottom: 12 }}>
        {groupAccessSentence("labels")}
      </p>
      {loadError && (
        <div className="error-box">
          {loadError}
          <p>
            <button className="btn" onClick={() => void loadGroups()}>
              {t("Retry")}
            </button>
          </p>
        </div>
      )}
      {groups !== null && !enumeration && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "Listing group mailboxes needs Stalwart server-administrator privilege, which this session does not have.",
          )}
        </div>
      )}
      {groups !== null && enumeration && (
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
