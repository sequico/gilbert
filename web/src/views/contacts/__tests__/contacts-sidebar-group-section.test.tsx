import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { choiceDialog, promptDialog } from "@/ui/dialog";
import { ContactsSidebar } from "../ContactsSidebar";

vi.mock("@/ui/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/dialog")>()),
  promptDialog: vi.fn(async () => "Freight ledger"),
  choiceDialog: vi.fn(async () => "finance"),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every group's books in one run, not a heading each.
 *
 * The section used to announce one group at a time -- its name as a subheading,
 * its books under it -- so a reader belonging to several groups scrolled past a
 * label per group to reach the book they wanted. They are now one **Group
 * contacts** list, each row naming its group on hover, and the section's single
 * **+** still creates a book the group owns. This pins both: one heading, every
 * book present, and the create still routed to the group the reader picks.
 */

const book = (id: string, name: string, sortOrder = 0) =>
  ({
    id,
    name,
    sortOrder,
    isDefault: false,
    isSubscribed: false,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

describe("the contacts sidebar's group section", () => {
  let host: HTMLDivElement;
  let root: Root;

  const sectionTitles = () =>
    [...host.querySelectorAll(".nav-section > span")].map((s) => s.textContent ?? "");
  const rowNames = () =>
    [...host.querySelectorAll(".nav-item")].map((r) => r.textContent ?? "");

  beforeEach(async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    useMail.setState({
      mailAccounts: [
        { accountId: "me", name: "me@example.org", kind: "own" },
        { accountId: "freight", name: "freight@example.org", kind: "group" },
        { accountId: "finance", name: "finance@example.org", kind: "group" },
      ],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<ContactsSidebar />);
    });
    // After the mount: the sidebar re-asks the session for shares when it opens.
    await act(async () => {
      useContacts.setState({
        accountId: "me",
        available: true,
        books: {},
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
            accountId: "finance",
            accountName: "finance@example.org",
            book: book("fin", "Finance directory", 1),
          },
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("lists every group's books in one run, without a heading per group", () => {
    const titles = sectionTitles();
    expect(titles.filter((s) => s === "Group contacts")).toHaveLength(1);
    expect(titles).not.toContain("freight@example.org");
    expect(titles).not.toContain("finance@example.org");
    const rows = rowNames();
    expect(rows.some((r) => r.includes("Freight directory"))).toBe(true);
    expect(rows.some((r) => r.includes("Finance directory"))).toBe(true);
  });

  it("creates a group book in the group chosen on the section's +", async () => {
    const createBook = vi
      .spyOn(useContacts.getState(), "createBook")
      .mockResolvedValue(undefined as never);
    const header = [...host.querySelectorAll(".nav-section")].find((s) =>
      (s.textContent ?? "").includes("Group contacts"),
    );
    const plus = header?.querySelector("button");
    expect(plus).toBeTruthy();
    await act(async () => {
      plus!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(vi.mocked(choiceDialog)).toHaveBeenCalled();
    expect(vi.mocked(promptDialog)).toHaveBeenCalled();
    expect(createBook).toHaveBeenCalledWith("Freight ledger", "finance");
  });
});
