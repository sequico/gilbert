import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Router, Switch } from "wouter";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { ContactsSidebar } from "../ContactsSidebar";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Two group mailboxes, and one group's card open while the other is read.
 *
 * The shape is the live server's, and it is what makes this a real case rather
 * than a contrived one: Stalwart mints ids per account, so **every** account's
 * default address book carries the same id — read off the deployed instance on
 * 2026-09-23, freight's and finance's are both `b` — and a card's id collides
 * across accounts just as readily. So the account beside a book id is the only
 * thing telling two of them apart, and a rule that forgets it does not read as
 * two groups at all.
 *
 * What the reader reported is the last case here: with a card of the first
 * group open, clicking the second group's address book left that card in the
 * detail pane. The list was the second group's — the pane was the first's — and
 * the route went on naming a card of the book the reader had left.
 *
 * The clearing is the same rule the ticked rows already followed, and it is the
 * route as well as the pane: what the list shows and what the address says are
 * one answer, or the page is lying about which book is open.
 */

const BOOK = "b";

const book = (name: string) =>
  ({
    id: BOOK,
    name,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: false,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

const card = (id: string, name: string) =>
  ({
    id,
    uid: `u-${id}`,
    kind: "individual",
    name: { full: name },
    emails: {},
    addressBookIds: { [BOOK]: true },
  }) as unknown as ContactCard;

describe("reading one group's address book after another", () => {
  let host: HTMLDivElement;
  let root: Root;

  const listNames = () =>
    [...host.querySelectorAll(".contacts-list .contact-row .c-name")].map(
      (r) => r.textContent ?? "",
    );
  const detail = () => host.querySelector(".contact-detail")?.textContent ?? "";
  const at = () => `${window.location.pathname}${window.location.search}`;
  const clickBook = async (text: string) => {
    const row = [...host.querySelectorAll(".nav-item")].find((r) =>
      (r.textContent ?? "").includes(text),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  beforeEach(async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    /* Each case starts from the plain list: jsdom keeps one history, and a card
       left open by the case before would be resolved against this fixture. */
    window.history.replaceState({}, "", "/contacts");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    // Drawn before the fixture: the sidebar re-reads the shares as it mounts,
    // which would rebuild the store under a state set before it. The route is
    // the app's own, so the `id` the view is handed is the one in the address.
    await act(async () => {
      root.render(
        <Router>
          <ContactsSidebar />
          <Switch>
            <Route path="/contacts/:id?">{(p) => <ContactsView id={p.id} />}</Route>
          </Switch>
        </Router>,
      );
    });
    await act(async () => {
      useContacts.setState({
        accountId: "me",
        available: true,
        books: { [BOOK]: book("My address book") },
        cards: {},
        loaded: true,
        loading: false,
        error: null,
        sharedBooks: [
          {
            accountId: "freight",
            accountName: "freight@example.org",
            book: book("Freight directory"),
          },
          {
            accountId: "finance",
            accountName: "finance@example.org",
            book: book("Finance directory"),
          },
        ],
        // The second group's book holds its own cards, as a group's does.
        sharedCards: {
          "freight:bb": card("bb", "MAERSK IT exp customs"),
          "finance:ff": card("ff", "Finance person"),
        },
        sharedLoaded: true,
        selection: { accountId: null, bookId: "all" },
        principals: [],
        principalsLoaded: false,
        recent: [],
      });
      useMail.setState({
        mailAccounts: [
          { accountId: "me", name: "me@example.org", kind: "own" },
          { accountId: "freight", name: "freight@example.org", kind: "group" },
          { accountId: "finance", name: "finance@example.org", kind: "group" },
        ],
      });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("reads the group whose address book was clicked", async () => {
    await clickBook("Freight directory");
    expect(listNames()).toEqual(["MAERSK IT exp customs"]);
    await clickBook("Finance directory");
    expect(listNames()).toEqual(["Finance person"]);
    expect(useContacts.getState().selection).toEqual({
      accountId: "finance",
      bookId: BOOK,
    });
  });

  it("shows an empty book as empty rather than as the other group's", async () => {
    // finance's book holds nothing, which is the live state of the second group.
    await act(async () => {
      useContacts.setState({ sharedCards: { "freight:bb": card("bb", "MAERSK") } });
    });
    await clickBook("Freight directory");
    expect(listNames()).toEqual(["MAERSK"]);
    await clickBook("Finance directory");
    expect(listNames()).toEqual([]);
  });

  it("leaves the card of the book it was opened from", async () => {
    window.history.replaceState({}, "", "/contacts/bb?account=freight");
    await clickBook("Freight directory");
    expect(detail()).toContain("MAERSK IT exp customs");

    await clickBook("Finance directory");
    // Neither the pane nor the address keeps the book the reader has left.
    expect(detail()).not.toContain("MAERSK IT exp customs");
    expect(at()).toBe("/contacts");
  });

  it("keeps a card that the book on screen does hold", async () => {
    window.history.replaceState({}, "", "/contacts/ff?account=finance");
    await clickBook("Finance directory");
    expect(detail()).toContain("Finance person");
    expect(at()).toBe("/contacts/ff?account=finance");
  });

  it("keeps a group's card while All contacts is the list on screen", async () => {
    // All contacts is the one list that holds every group's cards, so the card
    // the route names is on screen and stays there.
    window.history.replaceState({}, "", "/contacts/bb?account=freight");
    await clickBook("All contacts");
    expect(detail()).toContain("MAERSK IT exp customs");
    expect(at()).toBe("/contacts/bb?account=freight");
  });
});
