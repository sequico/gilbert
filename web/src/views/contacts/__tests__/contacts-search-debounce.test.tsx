import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the contact list does per keystroke, and per row.
 *
 * Filtering the book sorts every card with a rebuilt sort key per comparison,
 * so running it on each character typed is the difference between a list that
 * answers and one that stutters: the query the list is filtered by is therefore
 * the one the reader stopped typing. The box itself keeps every character.
 *
 * And a row's photo is a blob fetched over the app's own route: without
 * `loading="lazy"` every row of a full book queues its own request the moment
 * the screen opens, whether or not anybody scrolls to it.
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

const card = (id: string, name: string, withPhoto = false) =>
  ({
    id,
    uid: `u-${id}`,
    kind: "individual",
    name: { full: name },
    emails: { e1: { address: `${id}@example.org` } },
    ...(withPhoto
      ? {
          media: { m1: { kind: "photo", blobId: `blob-${id}`, mediaType: "image/jpeg" } },
        }
      : {}),
    addressBookIds: { b1: true },
  }) as unknown as ContactCard;

describe("the contact list while typing", () => {
  let host: HTMLDivElement;
  let root: Root;

  const rows = () => [...host.querySelectorAll(".contact-row")];

  const type = async (text: string) => {
    const input = host.querySelector<HTMLInputElement>(".list-search input")!;
    await act(async () => {
      /*
       * Through the prototype's own setter: React tracks the value on the
       * element, and a plain assignment would be read as "nothing changed".
       */
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!;
      set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    useContacts.setState({
      accountId: "own",
      available: true,
      books: { b1: book("b1", "My book") },
      cards: {
        c1: card("c1", "Ada Person", true),
        c2: card("c2", "Zoe Person"),
      },
      loaded: true,
      loading: false,
      error: null,
      sharedBooks: [],
      sharedCards: {},
      sharedLoaded: true,
      selection: { accountId: null, bookId: "all" },
      principals: [],
      principalsLoaded: false,
      recent: [],
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const render = async () => {
    await act(async () => {
      root.render(<ContactsView />);
    });
  };

  it("draws a row's photo only as it is scrolled to", async () => {
    await render();
    const photo = rows()[0]!.querySelector(".avatar img");
    expect(photo?.getAttribute("loading")).toBe("lazy");
  });

  it("waits for typing to settle before filtering, and keeps what was typed", async () => {
    await render();
    expect(rows()).toHaveLength(2);

    await type("zz");
    // Nothing has moved yet: the box holds the query, the list is still whole.
    expect(host.querySelector<HTMLInputElement>(".list-search input")!.value).toBe("zz");
    expect(rows()).toHaveLength(2);

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("No matches");
  });
});
