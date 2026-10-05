import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { ContactEditor } from "../ContactEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A group is a set of people, not a person.
 *
 * Its entry in a book has a name and members; email, phone, post and birthday
 * and a website describe a human being and are not for it. So they are not
 * offered when the entry is a group, and — the half that is easy to forget —
 * they are not written either, whatever the form still holds from a card that
 * was something else a moment ago.
 */

const book = (id: string, name: string) =>
  ({
    id,
    name,
    description: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: true,
    shareWith: {},
    myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  }) as unknown as AddressBook;

describe("the fields a group entry has", () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Array<{ method: string; args: Record<string, unknown> }>;

  const render = async (card: Record<string, unknown>) => {
    await act(async () => {
      root.render(
        <ContactEditor
          card={card as never}
          defaultBookId="b1"
          sourceAccountId={null}
          defaultAccountId={null}
          onClose={() => undefined}
          onSaved={() => undefined}
        />,
      );
    });
  };

  const labels = () =>
    [...document.querySelectorAll("label")].map((l) => l.textContent?.trim() ?? "");

  const fill = async (value: string) => {
    const input = [...document.querySelectorAll<HTMLInputElement>("input.input")].find(
      (i) => i.placeholder.startsWith("Add title"),
    );
    if (!input) return;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const save = async () => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Save",
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  const created = () => {
    const set = calls.find((c) => c.method === "ContactCard/set" && c.args.create);
    return (set?.args.create as { c: Record<string, unknown> } | undefined)?.c;
  };

  beforeEach(() => {
    calls = [];
    client.session = {
      capabilities: { [CAP.core]: {}, [CAP.contacts]: {} },
      accounts: {},
      primaryAccounts: {},
      state: "s1",
    } as unknown as JmapSession;
    vi.spyOn(client, "call").mockImplementation((async (
      method: string,
      args: Record<string, unknown>,
    ) => {
      calls.push({ method, args });
      return {
        accountId: args.accountId,
        state: "1",
        list: [],
        notFound: [],
        created: { c: { id: "new1" } },
        updated: {},
        destroyed: [],
        notCreated: {},
        notUpdated: {},
        notDestroyed: {},
      };
    }) as never);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    useContacts.setState({
      accountId: "own",
      available: true,
      books: { b1: book("b1", "My book") },
      cards: {},
      loaded: true,
      loading: false,
      error: null,
      sharedBooks: [],
      sharedCards: {},
      sharedLoaded: true,
      selection: { accountId: null, bookId: "all" },
    });
    useMail.setState({ mailAccounts: [] });
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
    vi.restoreAllMocks();
  });

  it("offers no email, phone, post, birthday or website", async () => {
    await render({ kind: "group" });
    const shown = labels();
    expect(shown).toContain("Members");
    expect(shown).toContain("Notes");
    for (const gone of ["Email", "Phone", "Address", "Birthday", "Website"]) {
      expect(shown).not.toContain(gone);
    }
  });

  it("still offers them for a person", async () => {
    await render({ kind: "individual" });
    const shown = labels();
    for (const there of ["Email", "Phone", "Address", "Birthday", "Website"]) {
      expect(shown).toContain(there);
    }
    expect(shown).not.toContain("Members");
  });

  it("writes none of them for a group, even with values in the form", async () => {
    // A card that was a person a moment ago: the form still holds what was
    // typed, and the save must not put it on an entry that is now a group.
    await render({
      kind: "group",
      emails: { e1: { address: "ada@example.org", contexts: {} } },
      phones: { p1: { number: "+1 555 0100" } },
      addresses: { a1: { components: [{ kind: "name", value: "Main St" }] } },
      anniversaries: { a1: { kind: "birth", date: { year: 1990, month: 1, day: 2 } } },
      links: { l1: { uri: "https://example.org" } },
    });
    await fill("Freight team");
    await save();
    const c = created();
    expect(c, "the card was created").toBeTruthy();
    for (const gone of ["emails", "phones", "addresses", "anniversaries", "links"]) {
      expect(c![gone]).toBeUndefined();
    }
  });
});
