import { groupRecipients } from "@/lib/contacts";
import type { ContactsGet, ContactsSet, ContactsState } from "../types";

/**
 * A group of contacts as the addresses its members answer with.
 *
 * A slice of the contacts store: the state is assembled in `../index`, and this
 * function only says what this job does with `get`.
 */
export function groupsSlice(
  _set: ContactsSet,
  get: ContactsGet,
): Pick<ContactsState, "expandGroup"> {
  return {
    expandGroup(group, accountId) {
      return groupRecipients(group, get().cardsIn(accountId));
    },
  };
}
