import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, ContactCard, JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where a contact can be moved from, and who is offered the question (ADR 0018).
 *
 * Moving a card between accounts changes whose it is, so the right-click menu
 * carries it only for an installation administrator -- and the dialog offers the
 * groups' books and, from a group's card, the reader's own. Asserted both ways,
 * because a menu that never appeared would pass the refusal half on its own.
 */

const book = (id: string, name: string) =>
  ({
    id,
    name,
    sortOrder: 0,
    isDefault: false,
    isSubscribed: true,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

const CARD = {
  id: "c1",
  uid: "u-c1",
  kind: "individual",
  name: { full: "Ada Person" },
  emails: {},
  addressBookIds: { b1: true },
} as unknown as ContactCard;

const session = (isAdmin: boolean) =>
  ({
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 } },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
    gilbert: { isAdmin },
  }) as unknown as JmapSession;

describe("moving a contact from the list", () => {
  let host: HTMLDivElement;
  let root: Root;

  const arrange = async (isAdmin: boolean) => {
    await act(async () => {
      client.session = session(isAdmin);
      useSession.setState({ status: "authenticated", session: client.session });
      useContacts.setState({
        accountId: "own",
        available: true,
        books: { b1: book("b1", "My book") },
        cards: { c1: CARD },
        loaded: true,
        loading: false,
        error: null,
        sharedBooks: [
          {
            accountId: "grp",
            accountName: "freight@example.org",
            book: book("g1", "Freight"),
          },
        ],
        sharedCards: {},
        sharedLoaded: true,
        selection: { accountId: null, bookId: "all" },
        principals: [],
        principalsLoaded: false,
        recent: [],
      });
      useMail.setState({
        mailAccounts: [
          { accountId: "own", name: "me@example.org", kind: "own" },
          { accountId: "grp", name: "freight@example.org", kind: "group" },
        ],
      });
    });
    await act(async () => {
      root.render(<ContactsView />);
    });
  };

  const rightClick = async () => {
    const row = host.querySelector(".contact-row")!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
  };
  const openMove = async () => {
    const entry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Move to…",
    );
    await act(async () => {
      entry!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  const destinations = () =>
    [...document.querySelectorAll(".menu-item")]
      .map((b) => b.textContent?.trim() ?? "")
      .filter(Boolean);

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
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("offers the move to an administrator, naming each group's book", async () => {
    await arrange(true);
    await rightClick();
    expect(destinations()).toEqual(["Move to…"]);
    await openMove();
    // The group whose account owns the book, and the book itself.
    expect(document.body.textContent).toContain("freight@example.org");
    expect(destinations()).toContain("Freight");
    // Moving a card between the reader's own books is the editor's, so the own
    // books are not offered while the card is already in one of them.
    expect(destinations()).not.toContain("My book");
  });

  it("offers nothing at all to a reader who is not an administrator", async () => {
    await arrange(false);
    await rightClick();
    expect(destinations()).toEqual([]);
  });
});
