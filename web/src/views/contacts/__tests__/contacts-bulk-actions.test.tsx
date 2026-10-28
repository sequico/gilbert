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
 * Importing and exporting, where a reader can find them, and into what.
 *
 * Both lived only in the `…` of a book's row, so a migration began by guessing.
 * The sidebar now carries them at the foot of the books; the destination is what
 * is selected, and a book in another account -- a group's own directory -- takes
 * an import like any other, which is what the view used to refuse by looking only
 * in the reader's own books.
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

describe("bulk import and export", () => {
  let host: HTMLDivElement;
  let root: Root;

  const labels = () =>
    [...host.querySelectorAll(".contacts-bulk button")].map((b) => b.textContent?.trim());

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
  const mountSidebar = async (selection: { accountId: string | null; bookId: string }) => {
    await act(async () => {
      root.render(<ContactsSidebar />);
    });
    arrange(selection);
    await act(async () => {});
  };

  it("offers both at the foot of the books, named for the selection", async () => {
    await mountSidebar({ accountId: null, bookId: "all" });
    expect(labels()).toEqual(["Import contacts…", "Export all contacts"]);
  });

  it("exports the book that is selected rather than everything", async () => {
    const heard = vi.fn();
    window.addEventListener(EVENTS.contactsExport, heard);
    await mountSidebar({ accountId: "freight", bookId: "fb" });
    expect(labels()).toEqual(["Import contacts…", "Export address book"]);
    const [, exportButton] = host.querySelectorAll<HTMLButtonElement>(
      ".contacts-bulk button",
    );
    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      accountId: "freight",
      bookId: "fb",
    });
    window.removeEventListener(EVENTS.contactsExport, heard);
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
        new CustomEvent(EVENTS.contactsImport, { detail: { file, bookId: "fb" } }),
      );
    });
    await act(async () => {});
    expect(importVCard).toHaveBeenCalledWith(expect.any(String), "fb");
  });
});
