import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, ContactCard, JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { ContactEditor } from "../ContactEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Which accounts the editor offers an **existing** card as its address book
 * (ADR 0018).
 *
 * A new card may be filed anywhere the reader can write — that is how a group's
 * directory is filled — but an existing card may only change the account it
 * lives in when the rule allows it. Offering a destination the rule refuses is
 * the refusal shown in the wrong place: the reader picks it, presses Save and is
 * told no, for a book the control could simply not have named.
 *
 * Both halves are asserted, because a picker that never offered a second account
 * would pass the refusal half on its own.
 */

const book = (id: string, name: string) =>
  ({
    id,
    name,
    isSubscribed: true,
    isDefault: false,
    sortOrder: 0,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
  }) as unknown as AddressBook;

const CARD = {
  id: "g1",
  uid: "u-g1",
  kind: "individual",
  name: { full: "Ada Person" },
  emails: {},
  addressBookIds: { bk9: true },
} as unknown as ContactCard;

const session = (isAdmin: boolean) =>
  ({
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 } },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
    gilbert: { isAdmin },
  }) as unknown as JmapSession;

describe("the books an existing card may be re-filed into", () => {
  let host: HTMLDivElement;
  let root: Root;

  /** The address book `<select>`: the one whose values carry an account. */
  const bookSelect = () =>
    [...document.body.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
      [...s.options].some((o) => o.value.includes("\u0000")),
    );
  const shown = () => [...bookSelect()!.options].map((o) => o.textContent);

  const arrange = async (isAdmin: boolean) => {
    await act(async () => {
      client.session = session(isAdmin);
      useSession.setState({ status: "authenticated", session: client.session });
      useContacts.setState({
        accountId: "own",
        available: true,
        books: { b1: book("b1", "My book") },
        cards: {},
        loaded: true,
        loading: false,
        error: null,
        sharedBooks: [
          {
            accountId: "grp",
            accountName: "freight@example.org",
            book: book("bk9", "Freight book"),
          },
        ],
        sharedCards: { "grp:g1": CARD },
        sharedLoaded: true,
        selection: { accountId: "grp", bookId: "bk9" },
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
      root.render(
        <ContactEditor
          card={CARD}
          defaultBookId="bk9"
          sourceAccountId="grp"
          defaultAccountId="grp"
          onClose={() => undefined}
          onSaved={() => undefined}
        />,
      );
    });
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
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("names no other account to a reader who may not move one", async () => {
    await arrange(false);
    expect(shown()).toEqual(["Freight book · freight@example.org"]);
    // The card's own book is still the one selected, so nothing is lost by the
    // account's absence.
    expect(bookSelect()!.value).toBe("grp\u0000bk9");
  });

  it("names the reader's own books to an administrator", async () => {
    await arrange(true);
    expect(shown()).toEqual(["My book", "Freight book · freight@example.org"]);
  });
});
