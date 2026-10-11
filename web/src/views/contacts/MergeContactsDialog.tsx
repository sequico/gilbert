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
import { sharedKey } from "@/lib/sharedKey";
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
 * not disagree on is combined, including the extra entries of a field they agree
 * on, so it is not shown: there is nothing to ask.
 *
 * The cards are read back from the store on every render, not held as the objects
 * that were on screen when the icon was pressed. A push between the press and the
 * confirm changes them, and the merged patch writes every field it handles — so
 * merging a stale copy would write its old values back over the newer card.
 *
 * The write is the store's (`mergeCards`): the merged card first, the other
 * destroyed after it. The dialog reports the outcome and hands the surviving
 * address back for the view to open.
 */
export function MergeContactsDialog({
  primary,
  secondary,
  onClose,
  onMerged,
}: {
  /** The card that survives — the one selected first. */
  primary: CardAddress;
  /** The card absorbed into it, then deleted. */
  secondary: CardAddress;
  onClose: () => void;
  onMerged: (saved: CardAddress) => void;
}) {
  const contacts = useContacts();
  const [picks, setPicks] = useState<Partial<Record<MergeFieldId, MergeSide>>>({});
  const [busy, setBusy] = useState(false);
  /*
   * Resolved strictly by the address the selection named, with no id-only
   * fallback: a card that vanished from a group's books must not be answered by a
   * card of the reader's own that happens to share its id, or the merge would
   * write one account's fields under the other's account.
   */
  const resolve = (address: CardAddress): ContactCard | null =>
    address.accountId
      ? (contacts.sharedCards[sharedKey(address.accountId, address.id)] ?? null)
      : (contacts.cards[address.id] ?? null);
  const a = resolve(primary);
  const b = resolve(secondary);
  const photoAccount = primary.accountId ?? contacts.accountId ?? "";
  const conflicts = a && b ? contactMergeConflicts(a, b) : [];

  const merge = async () => {
    if (!a || !b) return;
    setBusy(true);
    try {
      const { destroyed, refused } = await contacts.mergeCards(
        { card: a, accountId: primary.accountId },
        { card: b, accountId: secondary.accountId },
        picks,
      );
      /*
       * The merged card is written before the other is destroyed, so it is opened
       * either way. A destroy that did not go is reported rather than hidden: the
       * reader has to know the other card is still there.
       */
      onMerged(primary);
      if (destroyed) toast.success(t("Contacts merged"));
      else if (refused)
        toast.error(
          t("The contacts were merged, but the other one could not be deleted: {error}", {
            error: setErrorMessage(refused),
          }),
        );
      else toast.error(t("The contacts were merged, but the other one is still there."));
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
            disabled={busy || !a || !b}
          >
            {t("Merge")}
          </button>
        </>
      }
    >
      {!a || !b ? (
        <p style={{ marginTop: 0 }}>
          {t("One of the two contacts is no longer there, so there is nothing to merge.")}
        </p>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            {t(
              "{a} and {b} become one contact. Where they disagree, choose the value to keep; everything else is combined.",
              { a: contactDisplayName(a), b: contactDisplayName(b) },
            )}
          </p>
          {conflicts.length === 0 ? (
            <p className="hint">
              {t(
                "The two contacts have no conflicting values, so they are combined as they are.",
              )}
            </p>
          ) : (
            conflicts.map((c) => (
              <div key={c.id} style={{ marginTop: 14 }}>
                <div className="hint" style={{ marginBottom: 4 }}>
                  {t(c.label)}
                </div>
                <div className="dialog-choices" style={{ flexDirection: "row", gap: 8 }}>
                  {option(c.id, "a", a, c.a)}
                  {option(c.id, "b", b, c.b)}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </Dialog>
  );
}
