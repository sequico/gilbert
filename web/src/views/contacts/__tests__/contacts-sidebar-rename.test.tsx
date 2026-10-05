import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { ContactsSidebar } from "../ContactsSidebar";

vi.mock("@/ui/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/dialog")>()),
  promptDialog: vi.fn(async () => "Freight directory"),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Renaming a book that is not the reader's own.
 *
 * A group mailbox's address book is shown in the sidebar like the reader's own
 * and, for a member, written like it too. The menu offered Rename only on the
 * reader's own books, so the one way to change "Team directory" into something
 * a team recognises was to be its owner -- and the group owns it, not anyone.
 *
 * The gate is the book's own right, not whose account it is: a colleague's
 * read-only share still offers nothing to write with.
 */

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

describe("the address book menu", () => {
  let host: HTMLDivElement;
  let root: Root;

  const menuLabels = () =>
    [...document.querySelectorAll(".popover button, .menu button, .menu-item")]
      .map((b) => b.textContent?.trim() ?? "")
      .filter(Boolean);

  const openMenuOf = async (name: string) => {
    const row = [...host.querySelectorAll(".nav-item")].find((el) =>
      (el.textContent ?? "").includes(name),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
  };

  beforeEach(async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    useMail.setState({
      mailAccounts: [{ accountId: "grp", name: "freight@example.org", kind: "group" }],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<ContactsSidebar />);
    });
    // After the mount: the sidebar re-asks the session for shares when it opens,
    // which would rebuild the store under a fixture set before it.
    await act(async () => {
      useContacts.setState({
        accountId: "own",
        available: true,
        books: {},
        cards: {},
        loaded: true,
        loading: false,
        error: null,
        sharedBooks: [
          { accountId: "grp", accountName: "freight@example.org", book: book(true) },
        ],
        sharedCards: {},
        sharedLoaded: true,
        selection: { accountId: null, bookId: "all" },
      });
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it("offers Rename on a group's book a member may write", async () => {
    await openMenuOf("Team directory");
    expect(menuLabels()).toContain("Rename");
  });

  it("offers nothing to write on a share that grants no write", async () => {
    await act(async () => {
      useContacts.setState({
        sharedBooks: [
          { accountId: "grp", accountName: "A colleague", book: book(false) },
        ],
      });
    });
    await openMenuOf("Team directory");
    expect(menuLabels()).not.toContain("Rename");
    // The menu is still there, and still says what it can: exporting it, and
    // taking it out of the reader's own view.
    expect(menuLabels()).toContain("Export address book");
  });

  it("sends the rename to the account the row came from", async () => {
    // The bug: the group's book and the reader's own can share an id, and the
    // store's bare-id resolution prefers the reader's own -- so renaming the
    // group's directory renamed theirs. The row knows which account it is.
    const rename = vi.spyOn(useContacts.getState(), "updateBook");
    await openMenuOf("Team directory");
    const item = [...document.querySelectorAll(".menu-item")].find(
      (el) => el.textContent?.trim() === "Rename",
    );
    expect(item).toBeTruthy();
    await act(async () => {
      item!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(rename).toHaveBeenCalledWith("gab1", { name: "Freight directory" }, "grp");
  });
});
