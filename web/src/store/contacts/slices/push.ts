import { isSharedAccountRecord } from "@gilbert/shared/sessionAccount";
import { useSession } from "../../session";
import type { ContactsGet, ContactsSet, ContactsState } from "../types";

/**
 * A server change, applied to what this store holds.
 *
 * A slice of the contacts store: the state is assembled in `../index`, and this
 * function only says what this job does with `get`.
 */
export function pushSlice(
  _set: ContactsSet,
  get: ContactsGet,
): Pick<ContactsState, "applyChanges"> {
  return {
    applyChanges(types, accountId) {
      /*
       * Shared books and cards live in accounts that are not the reader's own,
       * but they are drawn beside the reader's own — so a change to a shared
       * account has to reload the shared cache, not the own one. The account
       * that changed is what the push dispatch hands over.
       */
      if (accountId && accountId !== get().accountId) {
        const s = useSession.getState().session;
        const shared = isSharedAccountRecord(s?.accounts?.[accountId]);
        if (shared && (types.has("AddressBook") || types.has("ContactCard")))
          void get().reloadShared();
        return;
      }
      if (types.has("AddressBook")) {
        void get().loadBooks();
        void get().reloadShared();
      }
      if (types.has("ContactCard") && get().loaded) void get().syncCards();
    },
  };
}
