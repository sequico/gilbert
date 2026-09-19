import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Which book the detail pane says a contact is filed in.
 *
 * A book id is only unique inside its account: Stalwart seeds a default book
 * per account, so the reader's own default and a group's may carry the **same
 * id**. The pane looked the id up in the reader's own books alone, so a card in
 * a group's directory was shown as living in "My address book" -- the reader's,
 * named by a collision.
 *
 * The fixture is exactly that collision, because it is the whole defect: with
 * two different ids the old lookup would have shown nothing at all rather than
 * the wrong thing.
 */

const book = (id: string, name: string) =>
  ({
    id,
    name,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: true,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

/* One id, two accounts, two names -- and the group's card filed under it. */
const SHARED_ID = "b1";

const GROUP_CARD = {
  id: "g1",
  uid: "u-g1",
  kind: "individual",
  name: { full: "Ada Person" },
  emails: {},
  addressBookIds: { [SHARED_ID]: true },
} as unknown as ContactCard;

describe("the book named on a contact's own page", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (id: string) => {
    await act(async () => {
      root.render(<ContactsView id={id} />);
    });
  };
  const hints = () =>
    [...host.querySelectorAll(".contact-detail .hint")].map((h) => h.textContent ?? "");

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    useContacts.setState({
      accountId: "own",
      available: true,
      books: { [SHARED_ID]: book(SHARED_ID, "My address book") },
      cards: {},
      loaded: true,
      loading: false,
      error: null,
      sharedBooks: [
        {
          accountId: "grp",
          accountName: "freight@example.org",
          book: book(SHARED_ID, "Freight directory"),
        },
      ],
      sharedCards: { "grp:g1": GROUP_CARD },
      sharedLoaded: true,
      selection: { accountId: "grp", bookId: SHARED_ID },
      principals: [],
      principalsLoaded: false,
      recent: [],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it("names the group's book, not the reader's book of the same id", async () => {
    await render("g1");
    const shown = hints().join(" | ");
    expect(shown).toContain("Freight directory · freight@example.org");
    expect(shown).not.toContain("My address book");
  });

  it("still names the reader's own book for a card in it", async () => {
    useContacts.setState({
      cards: { c1: { ...GROUP_CARD, id: "c1" } },
      sharedCards: {},
    });
    await render("c1");
    expect(hints().join(" | ")).toContain("My address book");
  });
});
