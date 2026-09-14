import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook, ContactCard, Id } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Ticking rows in the contacts list.
 *
 * Written after the browser caught what the store tests could not: the range a
 * shift-click covers was being measured inside the `setPicked` updater, which
 * React runs when it gets round to rendering -- by which time the anchor ref
 * has already been moved to the row that *ended* the range. Every shift-click
 * selected exactly one row, and every assertion about the store still passed,
 * because nothing was wrong below the component.
 */

const card = (id: string, full: string) =>
  ({
    id,
    uid: `uid-${id}`,
    name: { full },
    emails: {},
    kind: "individual",
    addressBookIds: { book1: true },
  }) as unknown as ContactCard;

/** Six people, in the order the list sorts them. */
const PEOPLE = ["Ada", "Bea", "Cal", "Dev", "Eve", "Fay"].map((n, i) =>
  card(`c${i}`, `${n} Person`),
);

describe("selecting contacts in the list", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(<ContactsView />);
    });
  };
  const boxes = () => [
    ...host.querySelectorAll<HTMLInputElement>(".contact-row .contact-check"),
  ];
  const click = async (el: Element, shiftKey = false) => {
    await act(async () => {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey }),
      );
    });
  };
  const ticked = () => boxes().filter((b) => b.checked).length;

  beforeEach(async () => {
    /* jsdom has no matchMedia, and the layout asks whether the window is
       narrow before it draws anything. */
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useContacts.setState({
      accountId: "a1",
      available: true,
      loaded: true,
      loading: false,
      books: {},
      sharedCards: {},
      cards: Object.fromEntries(PEOPLE.map((c) => [c.id, c])) as Record<Id, ContactCard>,
      selection: { accountId: null, bookId: "all" },
    });
    await render();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("puts a checkbox on every row", () => {
    expect(boxes()).toHaveLength(PEOPLE.length);
    expect(ticked()).toBe(0);
  });

  it("ticks one row on a plain click", async () => {
    await click(boxes()[0]!);
    expect(ticked()).toBe(1);
  });

  it("takes the whole run on a shift-click", async () => {
    // The regression. This was 2 before the anchor moved out of the updater.
    await click(boxes()[0]!);
    await click(boxes()[5]!, true);
    expect(ticked()).toBe(6);
  });

  it("reaches backwards as readily as forwards", async () => {
    await click(boxes()[4]!);
    await click(boxes()[1]!, true);
    expect(ticked()).toBe(4);
  });

  it("unticks a run when the row shift-clicked was already ticked", async () => {
    await click(boxes()[0]!);
    await click(boxes()[5]!, true);
    await click(boxes()[2]!, true);
    // Rows 2..5 come off, 0 and 1 stay.
    expect(ticked()).toBe(2);
  });

  it("treats a shift-click with nothing ticked yet as an ordinary one", async () => {
    await click(boxes()[3]!, true);
    expect(ticked()).toBe(1);
  });

  it("moves the anchor to the row last clicked", async () => {
    await click(boxes()[0]!);
    await click(boxes()[2]!);
    await click(boxes()[4]!, true);
    // From 2, not from 0: rows 2,3,4 plus the 0 already ticked.
    expect(ticked()).toBe(4);
  });

  it("shows a selection bar instead of the search box, counting what is ticked", async () => {
    expect(host.querySelector(".contacts-selbar")).toBeNull();
    await click(boxes()[0]!);
    await click(boxes()[2]!, true);
    expect(host.querySelector(".contacts-selbar")?.textContent).toContain("3");
    expect(host.querySelector(".search-input")).toBeNull();
  });

  it("does not open the contact it just ticked", async () => {
    // The checkbox sits inside the row, whose own click navigates.
    await click(boxes()[0]!);
    expect(host.querySelector(".contact-row.picked")).not.toBeNull();
    expect(ticked()).toBe(1);
  });

  it("clears the selection when the book being shown changes", async () => {
    await click(boxes()[0]!);
    await click(boxes()[3]!, true);
    expect(ticked()).toBe(4);
    await act(async () => {
      useContacts.setState({ selection: { accountId: null, bookId: "book1" } });
    });
    // A count describing rows from another book, with Delete aimed at them,
    // is the thing this avoids.
    expect(ticked()).toBe(0);
    expect(host.querySelector(".contacts-selbar")).toBeNull();
  });
});

/**
 * Edit and Delete on the contact that is open.
 *
 * Withheld when the book that holds the card says the reader may not write it
 * — a colleague's read-only share. Not when the answer is unknown: the books
 * may not have loaded, and taking both controls off a card that is the
 * reader's own is the failure this guards, with nothing on screen to say why.
 * Where the right is unknown they stay, and the write that follows is the
 * server's to refuse in its own words.
 */
describe("editing the contact on screen", () => {
  let host: HTMLDivElement;
  let root: Root;

  const SHARED = card("s1", "Sam Shared");
  const book = (mayWrite: boolean) =>
    ({
      id: "b1",
      name: "A book",
      description: null,
      sortOrder: 0,
      isDefault: false,
      isSubscribed: true,
      shareWith: {},
      myRights: { mayRead: true, mayWrite, mayShare: false, mayDelete: false },
    }) as unknown as AddressBook;
  const editButton = () =>
    [...host.querySelectorAll<HTMLButtonElement>(".contact-detail button")].find(
      (b) => b.textContent?.trim() === "Edit",
    );
  /** The detail pane's delete: a ghost button, and the only one in it. */
  const deleteButton = () => host.querySelector(".contact-detail .btn-ghost");
  const reason = () => host.querySelector(".contact-detail .hint")?.textContent ?? "";

  const open = async (state: Record<string, unknown>) => {
    useContacts.setState({
      accountId: "a1",
      available: true,
      books: {},
      selection: { accountId: null, bookId: "all" },
      ...state,
    });
    await act(async () => {
      root.render(<ContactsView id="s1" />);
    });
  };

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps them while the books that would answer have not loaded", async () => {
    // The card sits in another account's cache and no book has said what may
    // be written there: unknown, so the controls stay and the server answers.
    await open({
      loaded: false,
      loading: true,
      cards: {},
      sharedCards: { "a2:s1": SHARED },
    });
    expect(editButton()).not.toBeUndefined();
    expect(deleteButton()).not.toBeNull();
    expect(reason()).toBe("");
  });

  it("withholds them, and says why, for a card in a read-only book", async () => {
    await open({
      loaded: true,
      loading: false,
      cards: {},
      sharedCards: { "a2:s1": SHARED },
      sharedBooks: [{ accountId: "a2", accountName: "A colleague", book: book(false) }],
      sharedLoaded: true,
    });
    expect(editButton()).toBeUndefined();
    expect(deleteButton()).toBeNull();
    expect(reason()).toContain("another account shared with you");
  });

  it("offers them on the reader's own card", async () => {
    await open({
      loaded: true,
      loading: false,
      cards: { s1: SHARED },
      sharedCards: {},
    });
    expect(editButton()).not.toBeUndefined();
    expect(deleteButton()).not.toBeNull();
    expect(reason()).toBe("");
  });
});
