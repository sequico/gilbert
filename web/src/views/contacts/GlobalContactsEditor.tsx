import type { GlobalContactInput } from "@gilbert/shared/phone";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ContactCard } from "@/jmap/types";
import { contactDisplayName } from "@/lib/contacts";
import { deleteGlobalContact, saveGlobalContact } from "@/lib/globalContactsAdmin";
import { t } from "@/lib/i18n";
import { useContacts } from "@/store/contacts";
import { confirmDialog, Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

const EMPTY: GlobalContactInput = {
  name: "",
  emails: [],
  phones: [],
  organization: "",
  notes: "",
};

/** A card as the editor's small shape. */
function toInput(card: ContactCard): GlobalContactInput {
  return {
    name: contactDisplayName(card),
    emails: Object.values(card.emails ?? {}).map((e) => e.address),
    phones: Object.values(card.phones ?? {}).map((p) => p.number),
    organization: Object.values(card.organizations ?? {})[0]?.name ?? "",
    notes: Object.values(card.notes ?? {})[0]?.note ?? "",
  };
}

/**
 * The administrator's editor for the installation's Global contacts (ADR 0023).
 *
 * The directory is read-only for everybody else, and this is the one place it
 * is written: from inside Contacts, by an administrator, through the server
 * route that makes the write as the Master. It is deliberately its own editor
 * rather than the whole contact editor — the directory's cards are the
 * installation's, and a member's copy of the contact form is not where they
 * belong.
 */
export function GlobalContactsEditor({
  accountId,
  bookId,
  onClose,
}: {
  accountId: string;
  bookId: string;
  onClose: () => void;
}) {
  /*
   * The store's raw maps are selected, not `cardsIn(accountId)`: that method
   * builds a fresh array on every call, and a zustand v5 selector returning a
   * new snapshot re-renders forever. The filtering happens here, memoized.
   */
  const ownCards = useContacts((s) => s.cards);
  const shared = useContacts((s) => s.sharedCards);
  const reloadShared = useContacts((s) => s.reloadShared);
  const mine = useMemo(() => {
    const fromAccount = Object.entries(shared)
      .filter(([key]) => key.startsWith(`${accountId}:`))
      .map(([, card]) => card);
    // The directory lives in another account; the fallback covers a book that
    // somehow sits in the reader's own.
    const pool = fromAccount.length ? fromAccount : Object.values(ownCards);
    return pool.filter((c) => c.addressBookIds?.[bookId]);
  }, [shared, ownCards, accountId, bookId]);
  const [draft, setDraft] = useState<{
    id: string | null;
    card: GlobalContactInput;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    // Past any load already in flight, so the saved card is really in the list
    // the editor draws rather than in a snapshot taken before the write.
    await reloadShared();
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await saveGlobalContact(draft.id, draft.card);
      await refresh();
      setDraft(null);
      toast.success(t("Saved."));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(card: ContactCard) {
    if (
      !(await confirmDialog({
        title: t("Delete “{name}”?", { name: contactDisplayName(card) }),
        confirmLabel: t("Delete"),
        danger: true,
      }))
    )
      return;
    setError(null);
    try {
      await deleteGlobalContact(card.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (draft) {
    const set = (patch: Partial<GlobalContactInput>) =>
      setDraft({ ...draft, card: { ...draft.card, ...patch } });
    return (
      <Dialog open onClose={() => setDraft(null)} title={t("Global contacts")} size="md">
        <label className="field">
          <span>{t("Name")}</span>
          <input
            className="input"
            value={draft.card.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t("Email addresses")}</span>
          <textarea
            className="input"
            rows={2}
            spellCheck={false}
            value={draft.card.emails.join("\n")}
            onChange={(e) =>
              set({
                emails: e.target.value
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          />
          <span className="hint">{t("One per line.")}</span>
        </label>
        <label className="field">
          <span>{t("Phone numbers")}</span>
          <textarea
            className="input"
            rows={2}
            spellCheck={false}
            value={draft.card.phones.join("\n")}
            onChange={(e) =>
              set({
                phones: e.target.value
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          />
          <span className="hint">
            {t("One per line. These are what the phone offers as speed dial.")}
          </span>
        </label>
        <label className="field">
          <span>{t("Organization")}</span>
          <input
            className="input"
            value={draft.card.organization}
            onChange={(e) => set({ organization: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t("Notes")}</span>
          <textarea
            className="input"
            rows={2}
            value={draft.card.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => setDraft(null)}
          >
            {t("Cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !draft.card.name.trim()}
            onClick={() => void save()}
          >
            {t("Save")}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={t("Global contacts")} size="md">
      <p className="lead">
        {t(
          "The installation's shared directory: every account reads it, and only an administrator writes it here.",
        )}
      </p>
      {error && <div className="error-box">{error}</div>}
      {mine.length === 0 && <p className="hint">{t("No contacts")}</p>}
      {mine.map((card) => (
        <div className="nav-item" key={card.id}>
          <span className="grow truncate">{contactDisplayName(card)}</span>
          <button
            className="icon-btn sm"
            aria-label={t("Edit")}
            onClick={() => setDraft({ id: card.id, card: toInput(card) })}
          >
            <Pencil size={15} />
          </button>
          <button
            className="icon-btn sm danger"
            aria-label={t("Delete")}
            onClick={() => void remove(card)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <button
          className="btn"
          onClick={() => setDraft({ id: null, card: { ...EMPTY } })}
        >
          <Plus size={16} /> {t("Add contact")}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </Dialog>
  );
}
