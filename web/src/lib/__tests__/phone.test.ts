import { GLOBAL_CONTACTS_BOOK_NAME } from "@gilbert/shared/phone";
import { describe, expect, it } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { isGlobalContactsBook } from "@/lib/contacts";
import { accountFor, readSipAccounts } from "@/lib/phone/credential";
import {
  allDialerCards,
  contactNameFor,
  contactPhoneNumbers,
  dialerSources,
  dialTarget,
} from "@/lib/phone/dialer";
import { callUri, sipAddress } from "@/lib/phone/sip";
import type { SharedBook } from "@/store/contacts";

/**
 * The phone's pure rules (ADR 0023): which number a contact dials, how the
 * dialer separates its sources, and how the account's own server becomes the
 * address of record and a dialled target.
 *
 * These are the parts of the phone that can be pinned without a bridge, a
 * microphone or a browser, and they are the parts a change is most likely to
 * quietly break: the separation the dialer draws, and the server a call is
 * sent through.
 */

function card(
  id: string,
  bookId: string,
  phones: ContactCard["phones"] = {},
): ContactCard {
  return {
    id,
    addressBookIds: { [bookId]: true },
    name: { full: id },
    emails: {},
    phones,
  } as ContactCard;
}

function book(accountId: string, id: string, name: string): SharedBook {
  return {
    accountId,
    accountName: accountId,
    book: {
      id,
      name,
      isDefault: false,
      // Shared books are read-only, which is what marks the directory apart
      // from a book somebody may write.
      myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
    } as AddressBook,
  };
}

describe("the number a contact dials", () => {
  it("takes the preferred one first and null when there is none", () => {
    const two = card("c", "b", {
      p1: { number: " 222 ", pref: 2 },
      p2: { number: "111", pref: 1 },
    });
    expect(contactPhoneNumbers(two)).toEqual(["111", "222"]);
    expect(dialTarget(two)).toBe("111");
    expect(dialTarget(card("d", "b"))).toBeNull();
  });

  it("turns a call's number back into the contact that carries it", () => {
    const ada = card("ada", "b", { p1: { number: "+44 20 7946 0001" } });
    expect(contactNameFor([ada], "sip:442079460001@pbx.example.com")).toBe("ada");
    expect(contactNameFor([ada], "sip:999@pbx.example.com")).toBeNull();
  });
});

describe("the address a call is sent to", () => {
  const account = { server: "pbx.example.com", username: "1001", password: "p" };

  it("is the account's own address of record", () => {
    expect(sipAddress(account)).toBe("sip:1001@pbx.example.com");
  });

  it("sends a bare number through the account's server, and leaves an address as it is", () => {
    expect(callUri(account, "5551234")).toBe("sip:5551234@pbx.example.com");
    expect(callUri(account, "sip:someone@elsewhere.example")).toBe(
      "sip:someone@elsewhere.example",
    );
    expect(callUri(account, "someone@elsewhere.example")).toBe(
      "sip:someone@elsewhere.example",
    );
  });
});

describe("the dialer's sources", () => {
  const global = book("master", "g1", GLOBAL_CONTACTS_BOOK_NAME);
  const group = book("team", "t1", "Team directory");
  const colleague = book("grace", "c1", "Colleague's book");

  const byAccount: Record<string, ContactCard[]> = {
    master: [card("ada", "g1", { p: { number: "1" } })],
    team: [card("marie", "t1")],
    grace: [card("private", "c1"), card("ada", "g1")],
  };

  const sources = dialerSources({
    ownCards: [card("mine", "own")],
    sharedBooks: [global, group, colleague],
    cardsIn: (accountId) => byAccount[accountId] ?? [],
    groups: [{ accountId: "team", name: "Team" }],
    personalLabel: "Personal",
    ownAccountId: "me",
  });

  it("puts Global contacts first, then each group, then the reader's own", () => {
    expect(sources.map((s) => s.label)).toEqual(["Global contacts", "Team", "Personal"]);
    expect(sources[0]?.kind).toBe("global");
    expect(sources[0]?.cards.map((c) => c.id)).toEqual(["ada"]);
    expect(sources[1]?.cards.map((c) => c.id)).toEqual(["marie"]);
    expect(sources[2]?.cards.map((c) => c.id)).toEqual(["mine"]);
  });

  it("names each source's kind, so a surface can filter by it", () => {
    // The dialer's category tabs are built on this: one label per source, and
    // no surface has to parse an id to know what it is looking at.
    expect(sources.map((s) => s.kind)).toEqual(["global", "group", "personal"]);
  });

  it("leaves a colleague's book out of the named sources", () => {
    expect(sources.some((s) => s.cards.some((c) => c.id === "private"))).toBe(false);
  });

  it("counts a card once per account, and keeps the same id from another", () => {
    // `ada` is listed twice in the directory's account, and once in another
    // account's book under the same id — which is a different person.
    const all = allDialerCards([
      ...sources,
      {
        id: "extra",
        label: "Other",
        kind: "group",
        accountId: "master",
        cards: [card("ada", "g1")],
      },
      {
        id: "elsewhere",
        label: "Elsewhere",
        kind: "personal",
        accountId: "grace",
        cards: [card("ada", "c1")],
      },
    ]);
    expect(all.filter((c) => c.id === "ada")).toHaveLength(2);
  });
});

describe("Global contacts is one named book", () => {
  it("is the book the shared constant names, whatever rights it comes back with", () => {
    const readOnly = {
      mayRead: true,
      mayWrite: false,
      mayShare: false,
      mayDelete: false,
    };
    const writable = { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true };
    expect(
      isGlobalContactsBook({ name: GLOBAL_CONTACTS_BOOK_NAME, myRights: readOnly }),
    ).toBe(true);
    // An administrator may see it writable; it is still the directory.
    expect(
      isGlobalContactsBook({ name: GLOBAL_CONTACTS_BOOK_NAME, myRights: writable }),
    ).toBe(true);
    expect(isGlobalContactsBook({ name: "Team contacts", myRights: readOnly })).toBe(
      false,
    );
  });
});

describe("the account an identity registers with", () => {
  it("is looked up without case, and absent means no phone", () => {
    const account = { server: "pbx.example.com", username: "1001", password: "p" };
    expect(accountFor({ "a@example.com": account }, "A@Example.com")).toEqual(account);
    expect(accountFor({}, "a@example.com")).toBeNull();
    expect(accountFor({}, null)).toBeNull();
  });

  it("reads nothing from an account whose document is not there", async () => {
    // No account in this test has a folder: the reader answers an empty map
    // rather than throwing, which is what keeps the phone off quietly.
    await expect(readSipAccounts("no-such-account")).resolves.toEqual({});
  });
});
