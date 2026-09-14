import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Whether a contact in somebody else's address book is the reader's to change.
 *
 * It is one question per card, and the book holding it answers: a group's own
 * directory is in the group's account and its members write it, so an
 * ownership test ("is this my account?") takes Edit and Delete away from the
 * people the group's contacts are kept for. A colleague's read-only share is
 * the other answer, and the sentence the view shows names it.
 *
 * Both directions are asserted, because a gate that never withholds would pass
 * the first half of this on its own.
 */

const card = {
  id: "c1",
  uid: "u-c1",
  kind: "individual",
  name: { full: "Katherine Johnson" },
  emails: { e1: { address: "katherine@example.org", contexts: {} } },
  addressBookIds: { gab1: true },
} as unknown as ContactCard;

const book = (mayWrite: boolean) =>
  ({
    id: "gab1",
    name: "Team directory",
    description: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: false,
    shareWith: {},
    myRights: { mayRead: true, mayWrite, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

const NOTE = "another account shared with you holds this contact";

describe("a contact in a group's address book", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(<ContactsView id="c1" />);
    });
  };
  const labels = () =>
    [...document.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
  const hasNote = () => (document.body.textContent ?? "").includes(NOTE);

  const arrange = async (mayWrite: boolean) => {
    useContacts.setState({
      accountId: "own",
      available: true,
      loaded: true,
      loading: false,
      books: {},
      cards: {},
      sharedCards: { "grp:c1": card },
      sharedBooks: [
        { accountId: "grp", accountName: "freight@example.org", book: book(mayWrite) },
      ],
      sharedLoaded: true,
      selection: { accountId: "grp", bookId: "gab1" },
      error: null,
    });
    await render();
  };

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
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

  it("offers Edit and Delete when the group's book grants a write", async () => {
    await arrange(true);
    expect(labels()).toContain("Edit");
    expect(hasNote()).toBe(false);
  });

  it("withholds them, and says whose they are, on a read-only share", async () => {
    await arrange(false);
    expect(labels()).not.toContain("Edit");
    expect(hasNote()).toBe(true);
  });

  it("puts a checkbox on the group's rows too, so a batch delete is possible", async () => {
    await arrange(true);
    expect(host.querySelectorAll(".contact-row .contact-check")).toHaveLength(1);
  });

  describe("the store's answer, which both gates read", () => {
    it("says yes for the reader's own card", () => {
      useContacts.setState({ cards: { c1: card }, sharedBooks: [], sharedLoaded: true });
      expect(useContacts.getState().cardWritable(card)).toBe(true);
    });

    it("says yes for a group's card when its book grants a write", () => {
      useContacts.setState({
        cards: {},
        sharedCards: { "grp:c1": card },
        sharedBooks: [
          { accountId: "grp", accountName: "freight@example.org", book: book(true) },
        ],
        sharedLoaded: true,
      });
      expect(useContacts.getState().cardWritable(card)).toBe(true);
    });

    it("says no for a colleague's read-only share", () => {
      useContacts.setState({
        cards: {},
        sharedCards: { "grp:c1": card },
        sharedBooks: [
          { accountId: "grp", accountName: "A colleague", book: book(false) },
        ],
        sharedLoaded: true,
      });
      expect(useContacts.getState().cardWritable(card)).toBe(false);
    });

    it("offers it while the books that would answer have not loaded", () => {
      useContacts.setState({
        cards: {},
        sharedCards: { "grp:c1": card },
        sharedBooks: [
          { accountId: "grp", accountName: "freight@example.org", book: book(true) },
        ],
        sharedLoaded: false,
      });
      expect(useContacts.getState().cardWritable(card)).toBe(true);
    });
  });
});
