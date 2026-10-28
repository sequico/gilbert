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
 * A contact that belongs to several books of one account.
 *
 * Membership lives in the card (RFC 9553 `addressBookIds`), and a card may sit
 * in up to ten books at once -- measured on Stalwart 1.0.0, where both books list
 * it. The trap that measurement found is pinned here: an update carrying **one**
 * id does not add, it *moves*, so the write this dialog makes must carry the map
 * the card already had plus the new book.
 */

const book = (id: string, name: string, mayWrite = true) =>
  ({
    id,
    name,
    sortOrder: 0,
    isDefault: false,
    isSubscribed: true,
    shareWith: {},
    myRights: { mayRead: true, mayWrite, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

const CARD = {
  id: "c1",
  uid: "u-c1",
  kind: "individual",
  name: { full: "Ada Person" },
  emails: {},
  addressBookIds: { b1: true },
} as unknown as ContactCard;

const session = () =>
  ({
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 } },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
    gilbert: { isAdmin: false },
  }) as unknown as JmapSession;

describe("a contact in more than one book", () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Array<{ name: string; args: Record<string, unknown> }>;

  const arrange = async () => {
    calls = [];
    vi.spyOn(client, "call").mockImplementation(async (name: string, args: unknown) => {
      calls.push({ name, args: (args ?? {}) as Record<string, unknown> });
      if (name === "ContactCard/set") return { updated: { c1: null } };
      if (name === "ContactCard/get") return { list: [CARD], notFound: [] };
      return {};
    });
    await act(async () => {
      client.session = session();
      useSession.setState({ status: "authenticated", session: client.session });
      useContacts.setState({
        accountId: "own",
        available: true,
        books: {
          b1: book("b1", "Clients"),
          b2: book("b2", "Suppliers"),
          b3: book("b3", "Archive", false),
        },
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
        mailAccounts: [{ accountId: "own", name: "me@example.org", kind: "own" }],
      });
    });
    await act(async () => {
      root.render(<ContactsView />);
    });
  };

  const openAddTo = async () => {
    const row = host.querySelector(".contact-row")!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
    const entry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Add to another book…",
    );
    await act(async () => {
      entry!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  const destinations = () =>
    [...document.querySelectorAll("dialog button, .dialog button, button")]
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
    vi.restoreAllMocks();
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("offers the books of its own account it is not in yet, and only writable ones", async () => {
    await arrange();
    await openAddTo();
    expect(destinations()).toContain("Suppliers");
    // The book it is already in, a book it may not write, and another account's
    // book are not destinations for this card.
    expect(destinations()).not.toContain("Clients");
    expect(destinations()).not.toContain("Archive");
    expect(destinations()).not.toContain("Freight");
  });

  it("adds the book without taking the one the card is already in", async () => {
    await arrange();
    await openAddTo();
    const target = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Suppliers",
    )!;
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const set = calls.find((c) => c.name === "ContactCard/set");
    expect(set).toBeDefined();
    const update = (
      set!.args.update as Record<string, { addressBookIds: Record<string, boolean> }>
    ).c1;
    // The whole map: one id alone would move the card instead of adding.
    expect(update?.addressBookIds).toEqual({ b1: true, b2: true });
  });
});
