import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAP } from "@/jmap/client";
import type { AddressBook, JmapSession } from "@/jmap/types";
import { loadPlace, rememberPlace } from "@/lib/lastPlace";
import { setDeviceTrusted } from "@/lib/storage";
import { restoreBookPlace, useContacts } from "@/store/contacts";
import { useFiles } from "@/store/files";
import { rememberedMailAccount } from "@/store/mail";
import { useSession } from "@/store/session";

/**
 * The decisions a remembered place drives, without a server in the way: which
 * mail account to open, whether the book is still there, and what Files
 * records while somebody browses it.
 *
 * Every one of them is a check against what actually loaded, because the place
 * may name a group, a book or a folder that is gone by the time it is read.
 * Being put back somewhere that no longer exists is worse than being put back
 * at the start, which is what these pin.
 */

function signedIn() {
  useSession.setState({
    session: {
      primaryAccounts: { [CAP.mail]: "acc-own" },
      accounts: {
        "acc-own": { name: "Me", isPersonal: true },
        "acc-group": { name: "Team", isPersonal: false },
      },
    } as unknown as JmapSession,
  });
}

beforeEach(() => {
  setDeviceTrusted(true);
  localStorage.clear();
  signedIn();
});

afterEach(() => {
  useContacts.setState({
    books: {},
    sharedBooks: [],
    selection: { accountId: null, bookId: "all" },
  });
  useFiles.setState({ accountId: null, listingShown: null });
});

describe("the mail account to open", () => {
  it("is the one this device was last on, when it is still one of the reader's", () => {
    rememberPlace("acc-own", { mailAccountId: "acc-group" });

    expect(
      rememberedMailAccount([
        { accountId: "acc-own", name: "Me", kind: "own" },
        { accountId: "acc-group", name: "Team", kind: "group" },
      ]),
    ).toBe("acc-group");
  });

  it("is nothing when the remembered account is gone", () => {
    rememberPlace("acc-own", { mailAccountId: "acc-old" });

    expect(
      rememberedMailAccount([{ accountId: "acc-own", name: "Me", kind: "own" }]),
    ).toBeNull();
  });
});

describe("the book to show", () => {
  it("is the one this device was last on, when it is still loaded", () => {
    useContacts.setState({
      books: { "book-1": { id: "book-1", name: "Personal" } as unknown as AddressBook },
      selection: { accountId: null, bookId: "all" },
    });
    rememberPlace("acc-own", { book: { accountId: null, bookId: "book-1" } });

    restoreBookPlace();

    expect(useContacts.getState().selection).toEqual({
      accountId: null,
      bookId: "book-1",
    });
  });

  it("leaves the reader on all books when the remembered one is gone", () => {
    useContacts.setState({ books: {}, selection: { accountId: null, bookId: "all" } });
    rememberPlace("acc-own", { book: { accountId: null, bookId: "book-gone" } });

    restoreBookPlace();

    expect(useContacts.getState().selection).toEqual({ accountId: null, bookId: "all" });
  });

  it("does not second-guess a book the reader has since chosen", () => {
    useContacts.setState({
      books: { "book-1": { id: "book-1", name: "Personal" } as unknown as AddressBook },
      selection: { accountId: null, bookId: "book-2" },
    });
    rememberPlace("acc-own", { book: { accountId: null, bookId: "book-1" } });

    restoreBookPlace();

    expect(useContacts.getState().selection).toEqual({
      accountId: null,
      bookId: "book-2",
    });
  });
});

describe("the folder Files was showing", () => {
  it("is recorded, and stays recorded when the view is left", () => {
    useFiles.setState({ accountId: "acc-own" });
    useFiles.getState().setListingShown({ parentId: "n-7" });
    expect(loadPlace("acc-own").files).toEqual({ accountId: "acc-own", parentId: "n-7" });

    /* Leaving the view says there is nothing on screen, not that the reader
       was never anywhere -- the record is what opening Files lands on. */
    useFiles.getState().setListingShown(null);
    expect(loadPlace("acc-own").files).toEqual({ accountId: "acc-own", parentId: "n-7" });
  });
});
