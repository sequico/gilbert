import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook } from "@/jmap/types";
import { EVENTS } from "@/lib/events";
import { GLOBAL_CONTACTS_ACCOUNT_ID } from "@/lib/globalContactsAdmin";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { ContactsSidebar } from "../ContactsSidebar";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Importing and exporting, and into what.
 *
 * Both are a book's own commands: they live in the row's menu and nowhere else,
 * so the account and the book are the row that was opened. A group's book and
 * the installation's directory are a shared collection, and moving contacts in
 * or out of one is an administrator's — drawn for everybody, and disabled for
 * whoever does not hold it.
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
        accountId: "master",
        accountName: "gilbert@example.org",
        book: book("global-contacts", "Global contacts"),
      },
      {
        accountId: "freight",
        accountName: "freight@example.org",
        book: book("fb", "Freight directory"),
      },
      {
        accountId: "grace",
        accountName: "grace@example.org",
        book: { ...book("ro", "Grace book", false), isSubscribed: true },
      },
    ],
    sharedCards: {},
    sharedLoaded: true,
    selection,
  });
};

/** The administrator's marker, as the session store answers it. */
const asAdmin = (on: boolean) =>
  useSession.setState({ session: on ? ({ gilbert: { isAdmin: true } } as never) : null });

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
    const more = row(name)?.querySelector<HTMLButtonElement>(
      '[aria-label="Address book options"]',
    );
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
    asAdmin(false);
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
    asAdmin(true);
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
    asAdmin(true);
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

  it("draws a group's commands and dims them for a member", async () => {
    asAdmin(false);
    await mountSidebar({ accountId: "me", bookId: "mine" });
    await openMenuOf("Freight directory");
    expect(item("Export address book")?.disabled).toBe(true);
    expect(item("Import contacts…")?.disabled).toBe(true);
  });

  it("draws the directory's menu for everybody, dimmed for a member", async () => {
    asAdmin(false);
    await mountSidebar({ accountId: "me", bookId: "mine" });
    await openMenuOf("Global contacts");
    expect(item("Export address book")?.disabled).toBe(true);
    expect(item("Import contacts…")?.disabled).toBe(true);
  });

  it("gives the directory's commands to an administrator", async () => {
    asAdmin(true);
    const heard = vi.fn();
    window.addEventListener(EVENTS.contactsExport, heard);
    await mountSidebar({ accountId: "me", bookId: "mine" });
    await openMenuOf("Global contacts");
    const exportItem = item("Export address book")!;
    expect(exportItem.disabled).toBe(false);
    expect(item("Import contacts…")?.disabled).toBe(false);
    await act(async () => {
      exportItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      accountId: "master",
      bookId: "global-contacts",
    });
    window.removeEventListener(EVENTS.contactsExport, heard);
  });

  it("keeps the import out of a share that grants no write", async () => {
    asAdmin(true);
    await mountSidebar({ accountId: "me", bookId: "mine" });
    await openMenuOf("Grace book");
    // Reading it is what the share granted, so exporting is still offered.
    expect(item("Export address book")?.disabled).toBe(false);
    expect(item("Import contacts…")?.disabled).toBe(true);
  });

  it("imports into a group's own book like one of yours", async () => {
    asAdmin(true);
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

  it("imports into the directory through the administration's route", async () => {
    asAdmin(true);
    arrange({ accountId: "master", bookId: "global-contacts" });
    const intoDirectory = vi
      .spyOn(useContacts.getState(), "importIntoDirectory")
      .mockResolvedValue({ created: 1 });
    await act(async () => {
      root.render(<ContactsView />);
    });
    const file = new File(["BEGIN:VCARD\nEND:VCARD\n"], "c.vcf", { type: "text/vcard" });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(EVENTS.contactsImport, {
          detail: {
            file,
            bookId: "global-contacts",
            accountId: GLOBAL_CONTACTS_ACCOUNT_ID,
          },
        }),
      );
    });
    await act(async () => {});
    // Not the card writer: the directory is not a JMAP account (ADR 0019).
    expect(intoDirectory).toHaveBeenCalledWith("BEGIN:VCARD\nEND:VCARD\n");
  });

  it("refuses a member's import into a group's book", async () => {
    asAdmin(false);
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
    // The rule is asked where the action runs, not only where the menu draws it.
    expect(importVCard).not.toHaveBeenCalled();
  });
});
