import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactCard, EmailAddress } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useToasts } from "@/ui/toast";
import { RecipientInput } from "../RecipientInput";
import { RecipientPicker } from "../RecipientPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A group in the two places a recipient is chosen (ADR 0004).
 *
 * Autocomplete answers "finish this name" and the picker answers "who is
 * there?", and a group has to be visible to both: it is a row of its own,
 * marked as a group with the number of people in it, and choosing it is
 * choosing its members. A group with no row anywhere would be a directory of
 * people nobody can address as a set.
 */

const card = (over: Partial<ContactCard>) =>
  ({
    kind: "individual",
    emails: {},
    addressBookIds: { b1: true },
    ...over,
  }) as ContactCard;

const ADA = card({
  id: "c1",
  uid: "u-ada",
  name: { full: "Ada Person" },
  emails: { e1: { address: "ada@example.org" } },
});
const BOB = card({
  id: "c2",
  uid: "u-bob",
  name: { full: "Bob Person" },
  emails: { e1: { address: "bob@example.org" } },
});
const CARL = card({ id: "c3", uid: "u-carl", name: { full: "Carl Person" } }); // no address
const TEAM = card({
  id: "g1",
  uid: "u-team",
  kind: "group",
  name: { full: "Freight team" },
  members: { "u-ada": true, "u-bob": true, "u-carl": true },
});

const reset = () => {
  useContacts.setState({
    accountId: "own",
    available: true,
    books: {},
    cards: { c1: ADA, c2: BOB, c3: CARL, g1: TEAM },
    loaded: true,
    loading: false,
    error: null,
    sharedBooks: [],
    sharedCards: {},
    sharedLoaded: true,
    selection: { accountId: null, bookId: "all" },
    principals: [],
    principalsLoaded: true,
    recent: [],
  });
};

describe("a group as a recipient", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    reset();
    useToasts.setState({ toasts: [] });
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

  describe("in the composer's To field", () => {
    let picked: EmailAddress[][];
    let input: HTMLInputElement | null;

    const type = async (text: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input!, text);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // The suggestion list is debounced.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
    };

    beforeEach(async () => {
      picked = [];
      await act(async () => {
        root.render(
          <RecipientInput
            value={[]}
            onChange={(v) => {
              picked.push(v);
            }}
          />,
        );
      });
      input = host.querySelector<HTMLInputElement>("input");
      expect(input, "the To input").toBeTruthy();
    });

    it("is offered, marked as a group with its size", async () => {
      await type("freight");
      const item = document.querySelector(".suggest-item");
      expect(item).toBeTruthy();
      expect(item!.querySelector(".s-name")?.textContent).toBe("Freight team");
      expect(item!.querySelector(".s-email")?.textContent).toBe("group · 3 members");
    });

    it("becomes its members when it is taken, and says who was left out", async () => {
      await type("freight");
      const item = document.querySelector(".suggest-item")!;
      await act(async () => {
        item.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );
      });
      expect(picked.at(-1)).toEqual([
        { name: "Ada Person", email: "ada@example.org" },
        { name: "Bob Person", email: "bob@example.org" },
      ]);
      // Carl has no address, and a toast says so rather than dropping him in
      // silence. The host is the shell's, so the store is what to read here.
      const said = useToasts
        .getState()
        .toasts.map((t) => t.message)
        .join(" | ");
      expect(said).toContain("1 member of Freight team");
    });
  });

  describe("in the picker behind the address-book button", () => {
    let picked: Array<{ field: string; addresses: EmailAddress[] }>;

    beforeEach(async () => {
      picked = [];
      await act(async () => {
        root.render(
          <RecipientPicker
            onPick={(field, addresses) => {
              picked.push({ field, addresses });
            }}
            onClose={() => undefined}
          />,
        );
      });
    });

    it("has a row of its own, for the group rather than an address", () => {
      const rows = [...document.querySelectorAll(".menu-item")].map(
        (r) => r.textContent ?? "",
      );
      expect(
        rows.some((r) => r.includes("Freight team") && r.includes("group · 3 members")),
      ).toBe(true);
    });

    it("sends its members to the field that was asked for", async () => {
      const row = [...document.querySelectorAll(".menu-item")].find((r) =>
        (r.textContent ?? "").includes("Freight team"),
      )!;
      await act(async () => {
        row
          .querySelector("input")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      const to = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("To"),
      )!;
      await act(async () => {
        to.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(picked.at(-1)?.field).toBe("to");
      expect(picked.at(-1)?.addresses).toEqual([
        { name: "Ada Person", email: "ada@example.org" },
        { name: "Bob Person", email: "bob@example.org" },
      ]);
    });
  });
});
