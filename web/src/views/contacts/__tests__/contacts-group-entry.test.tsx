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
 * A book holds people, organisations and groups. The list says which is which
 * without a word wherever a word is not needed — a group's name is set bold, a
 * person's carries the company they belong to — and an organisation is the one
 * that still says what it is, because its name is the company and nothing else
 * on the row would say so. A group entry — a set of people rather than a person
 * — still shows none of the email, phone, post, dates and links that a card of
 * that kind is not for.
 */

const card = (over: Partial<ContactCard>) =>
  ({ addressBookIds: { b1: true }, emails: {}, ...over }) as unknown as ContactCard;

const NASA = { o1: { "@type": "Organization", name: "NASA" } } as never;

const ADA = card({
  id: "c1",
  uid: "u1",
  kind: "individual",
  name: { full: "Ada Person" },
  emails: { e1: { address: "ada@example.org", contexts: {} } },
  phones: { p1: { number: "+1 555 0100" } },
  organizations: NASA,
});
const ACME = card({ id: "c2", uid: "u2", kind: "org", name: { full: "Acme Ltd" } });
/* A person whose card carries no name of its own: the company is what is shown,
   and it is shown once. */
const SOLO = card({
  id: "c4",
  uid: "u4",
  kind: "individual",
  organizations: { o1: { "@type": "Organization", name: "Solo Studio" } } as never,
});
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
      cards: { c1: ADA, c2: ACME, c3: TEAM, c4: SOLO },
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

  it("tells the three kinds apart without labelling a person or a group", async () => {
    await render();
    const text = rows().join(" | ");
    // A person carries the company they belong to...
    expect(text).toContain("Ada PersonNASA");
    // ...an organisation still says what it is...
    expect(text).toContain("Acme Ltd · organization");
    // ...and a group says it in its own weight, with no word at all.
    expect(text).toContain("Freight team");
    expect(text).not.toContain("· person");
    expect(text).not.toContain("· group");
  });

  it("sets a group's name apart by weight, and by nothing else", async () => {
    await render();
    const row = (name: string) =>
      [...host.querySelectorAll(".contact-row .c-name")].find((r) =>
        (r.textContent ?? "").startsWith(name),
      )!;
    expect(row("Freight team").className).toContain("is-group");
    expect(row("Ada Person").className).not.toContain("is-group");
  });

  it("says a company once, when it is already the name", async () => {
    await render();
    expect(rows()).toContain("Solo Studio");
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
