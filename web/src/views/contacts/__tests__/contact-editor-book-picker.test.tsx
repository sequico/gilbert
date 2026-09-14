import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { ContactEditor } from "../ContactEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the editor offers as a place to file a contact.
 *
 * A group mailbox's address books are readable without anybody adding them --
 * membership of the group is the subscription -- and the sidebar shows them
 * under the group, the list browses them, and `loadShared` loads their cards.
 * The editor is the one surface that reads `isSubscribed` instead, so a group's
 * book that no member has subscribed (one another member created, or one that
 * came with the group) is missing from the picker while the card is still filed
 * into it -- the target comes from the book being browsed, not from the list.
 *
 * The failure to catch is therefore not "the wrong book was chosen": it is a
 * control that cannot show where the contact is about to go.
 */

const book = (id: string, name: string, isSubscribed: boolean) =>
  ({
    id,
    name,
    isSubscribed,
    isDefault: false,
    sortOrder: 0,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
  }) as unknown as AddressBook;

describe("the address book a new contact is filed into", () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Array<{ name: string; args: Record<string, unknown> }>;

  const render = async () => {
    await act(async () => {
      root.render(
        <ContactEditor
          card={{}}
          // The group's book is the one being browsed, so it is where a new
          // card goes -- this is what the "+" in the group's section leads to.
          defaultBookId="bk9"
          sourceAccountId={null}
          defaultAccountId="grp"
          onClose={() => undefined}
          onSaved={() => undefined}
        />,
      );
    });
  };

  /** The Address book `<select>`, told from the kind one by its values. The
      editor is a Dialog, so it is portalled to document.body, not to `host`. */
  const bookSelect = () =>
    [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
      [...s.options].some((o) => o.value.includes("\u0000")),
    );

  beforeEach(() => {
    calls = [];
    client.session = {
      capabilities: {
        [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
        [CAP.contacts]: {},
      },
      accounts: {},
      primaryAccounts: {},
      state: "s1",
    } as unknown as JmapSession;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          methodCalls: [string, Record<string, unknown>, string][];
        };
        const methodResponses: unknown[] = [];
        for (const [name, args, id] of body.methodCalls) {
          calls.push({ name, args });
          const created = name === "ContactCard/set" ? { c: { id: "new1" } } : {};
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              list: [],
              notFound: [],
              created,
              updated: {},
              destroyed: [],
              notCreated: {},
              notUpdated: {},
              notDestroyed: {},
            },
            id,
          ]);
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ methodResponses, sessionState: "1" }),
        } as Response;
      }),
    );
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    useContacts.setState({
      accountId: "own",
      available: true,
      books: { b1: book("b1", "My book", true) },
      cards: {},
      loaded: true,
      loading: false,
      error: null,
      sharedBooks: [
        {
          accountId: "grp",
          accountName: "freight@example.org",
          book: book("bk9", "Freight book", false),
        },
      ],
      sharedCards: {},
      sharedLoaded: true,
      selection: { accountId: "grp", bookId: "bk9" },
      principals: [],
      principalsLoaded: false,
      recent: [],
    });
    useSettings.setState((s) => ({ settings: { ...s.settings, addedShares: [] } }));
    /* What makes "grp" a group is the mail store's own probe, not this test:
       the picker has to agree with the sidebar and with `loadShared`, which
       both read it from here. */
    useMail.setState({
      mailAccounts: [{ accountId: "grp", name: "freight@example.org", kind: "group" }],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows the group's book the card is going into", async () => {
    await render();
    const sel = bookSelect();
    expect(sel).toBeTruthy();
    expect([...sel!.options].map((o) => o.textContent)).toEqual([
      "My book",
      "Freight book · freight@example.org",
    ]);
  });

  it("has the group's book selected, since that is where it will go", async () => {
    await render();
    const sel = bookSelect();
    expect(sel!.value).toBe("grp\u0000bk9");
    expect(sel!.selectedIndex).toBeGreaterThanOrEqual(0);
  });

  it("files the card into the group's book, and names it too", async () => {
    await render();
    const sel = bookSelect();
    const shown =
      sel!.selectedIndex >= 0 ? sel!.options[sel!.selectedIndex]!.textContent : "";

    const save = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Save",
    );
    await act(async () => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const set = calls.find((c) => c.name === "ContactCard/set");
    if (!set) throw new Error("no ContactCard/set was made");
    const create = set.args.create as { c: { addressBookIds: Record<string, boolean> } };
    expect(set.args.accountId).toBe("grp");
    expect(create.c.addressBookIds).toEqual({ bk9: true });
    /* The control has to name the book the card went into. Without the group's
       book among the options the `<select>` falls back to its first -- the
       reader's own -- while the create still goes to the group. */
    expect(shown).toBe("Freight book · freight@example.org");
  });
});
