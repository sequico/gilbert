// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";

/**
 * A book is its account and its id.
 *
 * This server mints address-book ids two characters long, so "b" is a book in the
 * reader's account and another in a group's, and the reader's own is the one an
 * id-only lookup answers with. Everything that asks for a book -- the sidebar's
 * selection, an import's destination, the dialog that files a card into a second
 * book -- goes through these two selectors for that reason, and this pins the
 * answer they owe when both accounts carry the same id.
 */

const book = (id: string, name: string, sortOrder = 0, mayWrite = true) =>
  ({
    id,
    name,
    sortOrder,
    isDefault: false,
    isSubscribed: true,
    shareWith: {},
    myRights: { mayRead: true, mayWrite, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

describe("finding a book by its account and its id", () => {
  beforeEach(() => {
    useContacts.setState({
      accountId: "me",
      available: true,
      books: {
        b: book("b", "My book"),
        z: book("z", "Another of mine", 2),
        a: book("a", "One of mine", 1),
      },
      cards: {} as Record<string, ContactCard>,
      sharedBooks: [
        {
          accountId: "grp",
          accountName: "freight@example.org",
          book: book("b", "Freight"),
        },
        {
          accountId: "grp",
          accountName: "freight@example.org",
          book: book("c", "Freight archive", 1, false),
        },
      ],
      sharedCards: {},
      sharedLoaded: true,
      selection: { accountId: null, bookId: "all" },
    });
  });

  it("answers with the group's book when the group is named, not the reader's", () => {
    expect(useContacts.getState().bookIn("grp", "b")?.name).toBe("Freight");
    expect(useContacts.getState().bookIn(null, "b")?.name).toBe("My book");
    expect(useContacts.getState().bookIn("me", "b")?.name).toBe("My book");
  });

  it("answers nothing for a book the account does not have", () => {
    expect(useContacts.getState().bookIn("grp", "z")).toBeNull();
    expect(useContacts.getState().bookIn(null, "c")).toBeNull();
  });

  it("lists one account's books, in the order the reader arranged them", () => {
    expect(
      useContacts
        .getState()
        .booksOf("grp")
        .map((b) => b.id),
    ).toEqual(["b", "c"]);
    expect(
      useContacts
        .getState()
        .booksOf(null)
        .map((b) => b.id),
    ).toEqual(["b", "a", "z"]);
    expect(useContacts.getState().booksOf("nobody")).toEqual([]);
  });
});
