import { errorMessage } from "@gilbert/shared/errors";
import { mergeContactCards } from "@/lib/contactMerge";
import type { ContactsGet, ContactsSet, ContactsState } from "../types";

/**
 * Two cards of one book as the one that survives.
 *
 * A slice of the contacts store: the state is assembled in `../index`, and this
 * function only says what this job does with `get`.
 */
export function mergeSlice(
  _set: ContactsSet,
  get: ContactsGet,
): Pick<ContactsState, "mergeCards"> {
  return {
    /*
     * Write the merged card, re-point the references that named the other, then
     * destroy it. The order is the point: a destroy that fails after the write
     * leaves the merged contact standing with both cards' facts in it, a write
     * that fails first never reaches the destroy, and a destroyed uid is never
     * still named by a group's member list or a relation -- so no path loses a
     * card into nothing or leaves a dangling reference.
     */
    async mergeCards(primary, secondary, picks) {
      /*
       * The two must be different cards of one account: the write merges their
       * books and the destroy removes one of them, so the same address twice would
       * delete the contact outright, and two accounts would write the merged card
       * into the wrong one. The view never offers either, but this action is
       * callable on its own.
       */
      if (
        (primary.accountId ?? null) !== (secondary.accountId ?? null) ||
        primary.card.id === secondary.card.id
      )
        throw new Error("Those two contacts cannot be merged");
      const patch = mergeContactCards(primary.card, secondary.card, picks);
      await get().updateCard(
        { id: primary.card.id, accountId: primary.accountId },
        patch,
      );
      await get().repointContactRefs(
        primary.accountId,
        secondary.card.uid,
        primary.card.uid,
        [primary.card.id, secondary.card.id],
      );
      /*
       * A destroy that throws -- a transport failure -- must not read as "the
       * merge failed": the write already landed and the references are re-pointed.
       * It is reported as a refusal-shaped outcome, so the caller keeps the merged
       * card and says the other one is still there.
       */
      try {
        return await get().destroyCards([
          { id: secondary.card.id, accountId: secondary.accountId },
        ]);
      } catch (err) {
        return {
          destroyed: 0,
          refused: { type: "serverFail", description: errorMessage(err) },
        };
      }
    },
  };
}
