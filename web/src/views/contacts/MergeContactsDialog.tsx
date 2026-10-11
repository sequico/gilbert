import { useState } from "react";
import { setErrorMessage } from "@/jmap/client";
import type { ContactCard } from "@/jmap/types";
import type { CardAddress } from "@/lib/contactAddress";
import {
  contactMergeConflicts,
  type MergeFieldId,
  type MergeSide,
} from "@/lib/contactMerge";
import { contactDisplayName, contactPhoto } from "@/lib/contacts";
import { t } from "@/lib/i18n";
import { useContacts } from "@/store/contacts";
import { Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

/**
 * The conflict choices a merge asks for, and nothing else.
 *
 * The two cards are already known to be one book's, and the merge keeps the one
 * the reader selected first: asking which of the two survives would be a second
 * question with an answer the selection already carried. What the reader decides
 * here is per **conflicting field** — the card's own type, its name, nickname,
 * company, job title, birthday, website, note and photo — each offered side by
 * side with the surviving card's value chosen by default. Everything the two do
 * not disagree on is combined without being shown, because there is nothing to
 * ask.
 *
 * The write is the store's (`mergeCards`): the merged card first, the other
 * destroyed after it. The dialog reports the outcome and hands the surviving
 * address back for the view to open.
 */
export function MergeContactsDialog({
  primary,
  secondary,
  accountId,
  onClose,
  onMerged,
}: {
  /** The card that survives — the one selected first. */
  primary: ContactCard;
  /** The card absorbed into it, then deleted. */
  secondary: ContactCard;
  /** The account both cards live in; null for the reader's own. */
  accountId: string | null;
  onClose: () => void;
  onMerged: (saved: CardAddress) => void;
}) {
  const contacts = useContacts();
  const conflicts = contactMergeConflicts(primary, secondary);
  const [picks, setPicks] = useState<Partial<Record<MergeFieldId, MergeSide>>>({});
  const [busy, setBusy] = useState(false);
  const photoAccount = accountId ?? contacts.accountId ?? "";
  const nameA = contactDisplayName(primary);
  const nameB = contactDisplayName(secondary);

  const merge = async () => {
    setBusy(true);
    try {
      const { destroyed, refused } = await contacts.mergeCards(
        { card: primary, accountId },
        { card: secondary, accountId },
        picks,
      );
      /*
       * The merged card is on the server already, so it is opened either way. A
       * refused destroy is reported rather than hidden: the reader has to know
       * the other card is still there.
       */
      onMerged({ id: primary.id, accountId });
      if (destroyed) toast.success(t("Contacts merged"));
      else
        toast.error(
          refused
            ? t(
                "The contacts were merged, but the other one could not be deleted: {error}",
                {
                  error: setErrorMessage(refused),
                },
              )
            : t("The contacts were merged, but the other one could not be deleted."),
        );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const option = (
    field: MergeFieldId,
    side: MergeSide,
    card: ContactCard,
    value: string,
  ) => {
    const chosen = (picks[field] ?? "a") === side;
    const src = field === "photo" ? contactPhoto(card, photoAccount) : null;
    return (
      <label
        key={side}
        className={`btn dialog-choice ${chosen ? "btn-primary" : ""}`}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        htmlFor={`merge-${field}-${side}`}
      >
        <input
          id={`merge-${field}-${side}`}
          type="radio"
          name={`merge-${field}`}
          checked={chosen}
          onChange={() => setPicks((p) => ({ ...p, [field]: side }))}
        />
        {field === "photo" && src ? (
          <img
            src={src}
            alt=""
            style={{ width: 32, height: 32, borderRadius: 999, objectFit: "cover" }}
          />
        ) : null}
        <span className="grow" style={{ overflowWrap: "anywhere" }}>
          {field === "kind" && value ? t(value) : src ? t("Photo") : value}
        </span>
      </label>
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Merge contacts")}
      size="md"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void merge()}
            disabled={busy}
          >
            {t("Merge")}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {t(
          "{a} and {b} become one contact. Where they disagree, choose the value to keep; everything else is combined.",
          { a: nameA, b: nameB },
        )}
      </p>
      {conflicts.length === 0 ? (
        <p className="hint">
          {t(
            "The two contacts have no conflicting values, so they are combined as they are.",
          )}
        </p>
      ) : (
        conflicts.map((c) => {
          const valueA = c.a;
          const valueB = c.b;
          return (
            <div key={c.id} style={{ marginTop: 14 }}>
              <div className="hint" style={{ marginBottom: 4 }}>
                {t(c.label)}
              </div>
              <div className="dialog-choices" style={{ flexDirection: "row", gap: 8 }}>
                {option(c.id, "a", primary, valueA)}
                {option(c.id, "b", secondary, valueB)}
              </div>
            </div>
          );
        })
      )}
    </Dialog>
  );
}
