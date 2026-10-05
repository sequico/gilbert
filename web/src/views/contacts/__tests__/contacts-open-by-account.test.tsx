import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Opening a contact from a list that holds another account's cards.
 *
 * A card's id is unique inside the account that minted it and nowhere else, so
 * the reader's own card and a group's can carry the same one -- which is what
 * "All contacts" holds. Resolved by id alone, an opened card answered from the
 * reader's own map, and a card of another account was then unreachable: both
 * rows drew as active, clicking the second one navigated to the address already
 * on screen, and the detail went on showing the card the reader was not looking
 * at. `?account=` is what tells them apart, and it is what these assert.
 */

const OWN = "own";
const GRP = "grp";

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

const card = (id: string, name: string, bookId: string) =>
  ({
    id,
    uid: `u-${id}`,
    kind: "individual",
    name: { full: name },
    emails: {},
    addressBookIds: { [bookId]: true },
  }) as unknown as ContactCard;

describe("a card opened from a list that mixes accounts", () => {
  let host: HTMLDivElement;
  let root: Root;

  /** Both cards carry the same id: one in the reader's own book, one in a group's. */
  const arrange = async () => {
    await act(async () => {
      useContacts.setState({
        accountId: OWN,
        available: true,
        books: { b1: book("b1", "My book") },
        cards: { k9: card("k9", "Ada Person", "b1") },
        loaded: true,
        loading: false,
        error: null,
        sharedBooks: [
          {
            accountId: GRP,
            accountName: "freight@example.org",
            book: book("bk9", "Freight"),
          },
        ],
        sharedCards: { [`${GRP}:k9`]: card("k9", "Freight team", "bk9") },
        sharedLoaded: true,
        selection: { accountId: null, bookId: "all" },
        principals: [],
        principalsLoaded: false,
        recent: [],
      });
      useMail.setState({
        mailAccounts: [
          { accountId: OWN, name: "me@example.org", kind: "own" },
          { accountId: GRP, name: "freight@example.org", kind: "group" },
        ],
      });
    });
  };

  const render = async (id?: string) => {
    await act(async () => {
      root.render(<ContactsView id={id} />);
    });
  };
  const rows = () => [...host.querySelectorAll<HTMLElement>(".contact-row")];
  const rowNamed = (name: string) =>
    rows().find((r) => r.querySelector(".c-name")?.textContent === name)!;
  const detail = () => host.querySelector(".contact-detail")?.textContent ?? "";
  const at = () => `${window.location.pathname}${window.location.search}`;

  beforeEach(async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    window.history.replaceState({}, "", "/contacts");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await arrange();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows the account the route names, and highlights only its row", async () => {
    window.history.replaceState({}, "", `/contacts/k9?account=${GRP}`);
    await render("k9");

    expect(detail()).toContain("Freight team");
    expect(detail()).not.toContain("Ada Person");
    expect(rowNamed("Freight team").className).toContain("active");
    expect(rowNamed("Ada Person").className).not.toContain("active");
  });

  it("shows the reader's own card when the route names no account", async () => {
    window.history.replaceState({}, "", "/contacts/k9");
    await render("k9");

    expect(detail()).toContain("Ada Person");
    expect(rowNamed("Ada Person").className).toContain("active");
    expect(rowNamed("Freight team").className).not.toContain("active");
  });

  it("gives each row an address of its own, so a click opens the card it names", async () => {
    await render();

    await act(async () => {
      rowNamed("Freight team").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(at()).toBe(`/contacts/k9?account=${GRP}`);

    await act(async () => {
      rowNamed("Ada Person").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(at()).toBe("/contacts/k9");
  });

  it("ticks the row the reader ticked, not the other card with that id", async () => {
    await render();
    const box = (name: string) =>
      rowNamed(name).querySelector<HTMLInputElement>(".contact-check")!;

    await act(async () => {
      box("Freight team").click();
    });

    // One tick: on the group's row, and not on the reader's own card with the
    // same id -- a delete would otherwise take that one.
    expect(box("Freight team").checked).toBe(true);
    expect(box("Ada Person").checked).toBe(false);
  });

  it("offers no write controls on a group's card the reader has no write on", async () => {
    /*
     * The reader's own book is writable and the group's is not (its book here
     * grants no write). Judged by the id alone, the group's card was read as the
     * reader's own and offered Edit — a control that would have written into the
     * reader's own book.
     */
    await act(async () => {
      useContacts.setState((s) => ({
        sharedBooks: s.sharedBooks.map((b) => ({
          ...b,
          book: { ...b.book, myRights: { ...b.book.myRights, mayWrite: false } },
        })),
      }));
    });
    window.history.replaceState({}, "", `/contacts/k9?account=${GRP}`);
    await render("k9");

    expect(detail()).toContain("Freight team");
    expect(detail()).not.toContain("Edit");
  });
});
