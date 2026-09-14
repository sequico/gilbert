import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { ContactsView } from "../ContactsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * How the three kinds of entry are told apart, and what a group one shows.
 *
 * A book holds people, organisations and groups. The list said which were
 * groups and left the other two to be guessed; and a group entry — a set of
 * people rather than a person — showed the email, phone, post, dates and
 * links that a card of that kind is not for.
 */

const card = (over: Partial<ContactCard>) =>
  ({ addressBookIds: { b1: true }, emails: {}, ...over }) as unknown as ContactCard;

const ADA = card({
  id: "c1",
  uid: "u1",
  kind: "individual",
  name: { full: "Ada Person" },
  emails: { e1: { address: "ada@example.org", contexts: {} } },
  phones: { p1: { number: "+1 555 0100" } },
});
const ACME = card({ id: "c2", uid: "u2", kind: "org", name: { full: "Acme Ltd" } });
const TEAM = card({
  id: "c3",
  uid: "u3",
  kind: "group",
  name: { full: "Freight team" },
  // Left behind by a client that did not know better; never shown here.
  emails: { e1: { address: "freight@example.org", contexts: {} } },
  phones: { p1: { number: "+1 555 0199" } },
});

describe("the contacts list and its group entries", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (id?: string) => {
    await act(async () => {
      root.render(<ContactsView id={id} />);
    });
  };

  const rows = () =>
    [...host.querySelectorAll(".contact-row .c-name")].map((r) => r.textContent ?? "");
  const headings = () =>
    [...host.querySelectorAll(".contact-section h3")].map((h) => h.textContent ?? "");

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
      books: {},
      cards: { c1: ADA, c2: ACME, c3: TEAM },
      loaded: true,
      loading: false,
      error: null,
      sharedBooks: [],
      sharedCards: {},
      sharedLoaded: true,
      selection: { accountId: null, bookId: "all" },
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

  it("says which kind every row is", async () => {
    await render();
    const text = rows().join(" | ");
    expect(text).toContain("Ada Person · person");
    expect(text).toContain("Acme Ltd · organization");
    expect(text).toContain("Freight team · group");
  });

  it("shows a person's email, phone, post, dates and links", async () => {
    await render("c1");
    expect(headings()).toContain("Email");
    expect(headings()).toContain("Phone");
  });

  it("shows none of them on a group entry, even when the card carries them", async () => {
    await render("c3");
    for (const gone of ["Email", "Phone", "Address", "Dates", "Online"]) {
      expect(headings()).not.toContain(gone);
    }
  });
});
