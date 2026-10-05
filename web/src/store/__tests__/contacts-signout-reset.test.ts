import { afterEach, describe, expect, it } from "vitest";
import type { AddressBook, ContactCard, Principal } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useSession } from "@/store/session";

/*
 * Sign-out clears the whole contacts store, the reader's own half and the
 * shared one. Leaving `sharedBooks`, `sharedCards`, `sharedLoaded` or
 * `selection` to survive into the next sign-in lets the previous reader's
 * selection route the Contacts list and lets `suggest()` offer their shared
 * contacts during the next reader's load window — a transient cross-user
 * exposure on shared machines. Calendar and files clear their shared
 * state on sign-out; contacts must too.
 */

const asBook = (id: string) => ({ id, name: id }) as unknown as AddressBook;
const asCard = (id: string) => ({ id }) as unknown as ContactCard;

afterEach(() => {
  useSession.setState({
    status: "anonymous",
    session: null,
    accountId: null,
    error: null,
  });
});

describe("a sign-out leaves nothing of the previous reader's contacts behind", () => {
  it("clears the shared books, cards, flag and selection with the own half", () => {
    useContacts.setState({
      accountId: "a1",
      books: { b1: asBook("b1") },
      cards: { c1: asCard("c1") },
      loaded: true,
      principals: [] as Principal[],
      principalsLoaded: true,
      sharedBooks: [{ accountId: "g1", accountName: "Team", book: asBook("s1") }],
      sharedCards: { "g1:sc1": asCard("sc1") },
      sharedLoaded: true,
      selection: { accountId: "g1", bookId: "s1" },
    });

    useSession.setState({ status: "anonymous", session: null, accountId: null });

    const s = useContacts.getState();
    expect(s.accountId).toBeNull();
    expect(s.books).toEqual({});
    expect(s.cards).toEqual({});
    expect(s.loaded).toBe(false);
    expect(s.sharedBooks).toEqual([]);
    expect(s.sharedCards).toEqual({});
    expect(s.sharedLoaded).toBe(false);
    expect(s.selection).toEqual({ accountId: null, bookId: "all" });
  });
});
