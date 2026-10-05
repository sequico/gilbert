import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { ContactEditor } from "../ContactEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Who a group card's members may be is a question about the account the card
 * is being filed into.
 *
 * A member is stored as another card's `uid`, and a uid means nothing outside
 * the account that holds it: a group's members are the group's own cards. The
 * member picker searched the reader's own list, so a group started in the
 * group's directory offered nobody from the group -- and a member already on
 * the card showed as a bare uid, for the same reason.
 */

const card = (over: Partial<ContactCard>) =>
  ({ kind: "individual", emails: {}, ...over }) as unknown as ContactCard;

const OWN_CARD = card({ id: "c1", uid: "u-own", name: { full: "Alice Own" } });
const GROUP_CARD = card({
  id: "c9",
  uid: "u-theirs",
  name: { full: "Katherine Johnson" },
});

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

describe("the members a group card may name", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (bookId: string, accountId: string | null) => {
    await act(async () => {
      root.render(
        <ContactEditor
          card={{ kind: "group" }}
          defaultBookId={bookId}
          sourceAccountId={null}
          defaultAccountId={accountId}
          onClose={() => undefined}
          onSaved={() => undefined}
        />,
      );
    });
  };

  const type = async (text: string) => {
    const input = [...document.querySelectorAll<HTMLInputElement>("input.input")].find(
      (i) => i.placeholder.startsWith("Search contacts"),
    );
    expect(input, "the members box").toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input!, text);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const offered = () =>
    [...document.querySelectorAll(".suggest-item .s-name")].map((e) => e.textContent);

  beforeEach(() => {
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
      cards: { c1: OWN_CARD },
      loaded: true,
      loading: false,
      error: null,
      sharedBooks: [
        {
          accountId: "grp",
          accountName: "freight@example.org",
          book: book("gab1", "Team directory"),
        },
      ],
      sharedCards: { "grp:c9": GROUP_CARD },
      sharedLoaded: true,
      selection: { accountId: null, bookId: "all" },
    });
    useMail.setState({
      mailAccounts: [{ accountId: "grp", name: "freight@example.org", kind: "group" }],
    });
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

  it("offers the group's own cards when the book is the group's", async () => {
    await render("gab1", "grp");
    await type("kath");
    expect(offered()).toEqual(["Katherine Johnson"]);
  });

  it("offers the reader's own cards when the book is theirs", async () => {
    await render("b1", null);
    await type("ali");
    expect(offered()).toEqual(["Alice Own"]);
  });

  it("names a member already on the card, instead of showing its uid", async () => {
    await act(async () => {
      root.render(
        <ContactEditor
          card={
            {
              id: "g1",
              kind: "group",
              members: { "u-theirs": true },
            } as Partial<ContactCard>
          }
          defaultBookId="gab1"
          sourceAccountId="grp"
          defaultAccountId="grp"
          onClose={() => undefined}
          onSaved={() => undefined}
        />,
      );
    });
    expect(document.querySelector(".chip")?.textContent).toContain("Katherine Johnson");
  });
});
