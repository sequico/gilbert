import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { downloadFile } from "@/lib/download";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { ContactsView } from "../ContactsView";

vi.mock("@/lib/download", () => ({ downloadFile: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What "All contacts" holds, and how a row says where it came from.
 *
 * A group mailbox's books are the group's and its members reach them without
 * anybody adding them -- membership is the subscription, the rule the sidebar,
 * `loadShared` and the composer's suggestions all follow. The reader's one list
 * of everything therefore has to be their own cards **and** every group's, with
 * the group named on the row, because a name in a group's directory and a name
 * in somebody's own book are not the same contact.
 *
 * A colleague's share is the other half of the rule and is asserted here too:
 * that one is added deliberately, it lives under *Shared with me*, and its
 * cards must not arrive in this list by being reachable.
 */

const book = (id: string, name: string) =>
  ({
    id,
    name,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: true,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

const card = (id: string, name: string, bookId: string) =>
  ({
    id,
    uid: `u-${id}`,
    kind: "individual",
    name: { full: name },
    emails: {},
    addressBookIds: { [bookId]: true },
  }) as unknown as ContactCard;

describe("All contacts, and the group a card came from", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(<ContactsView />);
    });
  };
  const rows = () => [...host.querySelectorAll(".contact-row")];
  const names = () =>
    [...host.querySelectorAll(".contact-row .c-name")].map((r) => r.textContent ?? "");
  const badges = () =>
    [...host.querySelectorAll(".contact-row .c-group")].map((b) => b.textContent ?? "");

  const arrange = async (selection: { accountId: string | null; bookId: string }) => {
    await act(async () => {
      useContacts.setState({
        accountId: "own",
        available: true,
        books: { b1: book("b1", "My book") },
        cards: { c1: card("c1", "Ada Person", "b1") },
        loaded: true,
        loading: false,
        error: null,
        sharedBooks: [
          {
            accountId: "grp",
            accountName: "freight@example.org",
            book: book("bk9", "Freight"),
          },
          {
            accountId: "col",
            accountName: "collins@example.org",
            book: book("cb", "Collins"),
          },
        ],
        sharedCards: {
          "grp:g1": card("g1", "Freight team", "bk9"),
          "col:x1": card("x1", "A colleague's friend", "cb"),
        },
        sharedLoaded: true,
        selection,
        principals: [],
        principalsLoaded: false,
        recent: [],
      });
      // The probe's answer: one of the two shared accounts is a group mailbox.
      useMail.setState({
        mailAccounts: [
          { accountId: "own", name: "me@example.org", kind: "own" },
          { accountId: "grp", name: "freight@example.org", kind: "group" },
        ],
      });
    });
  };

  beforeEach(() => {
    vi.mocked(downloadFile).mockClear();
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
    vi.unstubAllGlobals();
  });

  it("holds the reader's own cards and every group's, each naming its group", async () => {
    await arrange({ accountId: null, bookId: "all" });
    await render();
    expect(names()).toEqual(["Ada Person", "Freight team"]);
    // One badge, on the group's row, and the reader's own row carries none.
    expect(badges()).toEqual(["freight@example.org"]);
    expect(rows()[1]!.querySelector(".c-group")).not.toBeNull();
    expect(rows()[0]!.querySelector(".c-group")).toBeNull();
  });

  it("leaves a colleague's shared book out until the reader opens it", async () => {
    await arrange({ accountId: null, bookId: "all" });
    await render();
    expect(names()).not.toContain("A colleague's friend");
    // ...and it is there when its own account is the one being shown.
    await arrange({ accountId: "col", bookId: "all" });
    await render();
    expect(names()).toEqual(["A colleague's friend"]);
  });

  it("names no group when the list is already the group's own section", async () => {
    await arrange({ accountId: "grp", bookId: "all" });
    await render();
    expect(names()).toEqual(["Freight team"]);
    expect(badges()).toEqual([]);
  });

  it("exports what All contacts shows, the groups included", async () => {
    await arrange({ accountId: null, bookId: "all" });
    await render();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("ihm:contacts-export", {
          detail: { accountId: null, bookId: "all" },
        }),
      );
    });
    const written = vi.mocked(downloadFile).mock.calls[0]?.[0];
    expect(String(written)).toContain("Ada Person");
    expect(String(written)).toContain("Freight team");
    // The colleague's share is not in this list, so it is not in the file.
    expect(String(written)).not.toContain("A colleague's friend");
  });
});
