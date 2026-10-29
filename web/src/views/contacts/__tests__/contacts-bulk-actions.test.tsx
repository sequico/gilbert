import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook } from "@/jmap/types";
import { EVENTS } from "@/lib/events";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { ContactsSidebar } from "../ContactsSidebar";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Importing and exporting, and into what.
 *
 * Both are a book's own commands: they live in the row's menu and nowhere else,
 * so the account and the book are the row that was right-clicked — a group's
 * own directory takes an import like any other, and the action runs in that
 * group.
 */

const book = (id: string, name: string, mayWrite = true) =>
  ({
    id,
    name,
    sortOrder: 0,
    isDefault: false,
    isSubscribed: false,
    shareWith: {},
    myRights: { mayRead: true, mayWrite, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

const arrange = (selection: { accountId: string | null; bookId: string }) => {
  useMail.setState({
    mailAccounts: [
      { accountId: "me", name: "me@example.org", kind: "own" },
      { accountId: "freight", name: "freight@example.org", kind: "group" },
    ],
  });
  useContacts.setState({
    accountId: "me",
    available: true,
    books: { mine: book("mine", "My book") },
    cards: {},
    loaded: true,
    loading: false,
    error: null,
    sharedBooks: [
      {
        accountId: "freight",
        accountName: "freight@example.org",
        book: book("fb", "Freight directory"),
      },
      {
        accountId: "freight",
        accountName: "freight@example.org",
        book: book("ro", "Read only", false),
      },
    ],
    sharedCards: {},
    sharedLoaded: true,
    selection,
  });
};

describe("import and export from a book's menu", () => {
  let host: HTMLDivElement;
  let root: Root;

  /** The row of one book, by the name it shows. */
  const row = (name: string) =>
    [...host.querySelectorAll<HTMLElement>(".nav-item")].find((el) =>
      el.textContent?.includes(name),
    );
  /** The menu entry carrying `label`, wherever the popover put it. */
  const item = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) =>
      b.textContent?.includes(label),
    );

  const openMenuOf = async (name: string) => {
    const more = row(name)?.querySelector<HTMLButtonElement>(".nav-more");
    expect(more, `the row of "${name}" carries a menu`).toBeTruthy();
    await act(async () => {
      more!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    vi.restoreAllMocks();
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  /* The sidebar re-asks the session for shares when it mounts, which replaces
     the books, so the state goes in after the render and not before. */
  const mountSidebar = async (selection: {
    accountId: string | null;
    bookId: string;
  }) => {
    await act(async () => {
      root.render(<ContactsSidebar />);
    });
    arrange(selection);
    await act(async () => {});
  };

  it("keeps both commands out of the tree", async () => {
    await mountSidebar({ accountId: null, bookId: "all" });
    expect(host.textContent).not.toContain("Import contacts…");
    expect(host.querySelector(".contacts-bulk")).toBeNull();
  });

  it("runs a group's export in that group's account", async () => {
    const heard = vi.fn();
    window.addEventListener(EVENTS.contactsExport, heard);
    await mountSidebar({ accountId: "me", bookId: "mine" });
    await openMenuOf("Freight directory");
    await act(async () => {
      item("Export address book")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      accountId: "freight",
      bookId: "fb",
    });
    window.removeEventListener(EVENTS.contactsExport, heard);
  });

  it("runs a group's import into that group's book", async () => {
    const heard = vi.fn();
    window.addEventListener(EVENTS.contactsImport, heard);
    await mountSidebar({ accountId: "me", bookId: "mine" });
    await openMenuOf("Freight directory");
    await act(async () => {
      item("Import contacts…")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input, "the picker the menu opens").toBeTruthy();
    const file = new File(["BEGIN:VCARD\nEND:VCARD\n"], "c.vcf", {
      type: "text/vcard",
    });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input!.dispatchEvent(new Event("change"));
    });
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      file,
      bookId: "fb",
      accountId: "freight",
    });
    window.removeEventListener(EVENTS.contactsImport, heard);
  });

  it("offers no import on a book the reader may not write", async () => {
    await mountSidebar({ accountId: "me", bookId: "mine" });
    await openMenuOf("Read only");
    expect(item("Import contacts…")).toBeUndefined();
    // The book can still be exported: reading it is what the share granted.
    expect(item("Export address book")).toBeTruthy();
  });

  it("imports into a group's own book, which is the same import as one of yours", async () => {
    arrange({ accountId: "freight", bookId: "fb" });
    const importVCard = vi
      .spyOn(useContacts.getState(), "importVCard")
      .mockResolvedValue({ created: 1, updated: 0, alike: 0 });
    await act(async () => {
      root.render(<ContactsView />);
    });
    const file = new File(["BEGIN:VCARD\nEND:VCARD\n"], "c.vcf", { type: "text/vcard" });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(EVENTS.contactsImport, {
          detail: { file, bookId: "fb", accountId: "freight" },
        }),
      );
    });
    await act(async () => {});
    expect(importVCard).toHaveBeenCalledWith(expect.any(String), "fb", "freight");
  });
});
