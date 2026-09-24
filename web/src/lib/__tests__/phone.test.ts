import { GLOBAL_CONTACTS_BOOK_NAME } from "@gilbert/shared/phone";
import { describe, expect, it } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { isGlobalContactsBook } from "@/lib/contacts";
import {
  contactPhoneNumbers,
  dialTarget,
  iceServers,
  phoneOffered,
} from "@/lib/phone/config";
import { credentialFor, readSipCredentials } from "@/lib/phone/credentials";
import { allDialerCards, dialerSources } from "@/lib/phone/dialer";
import type { SharedBook } from "@/store/contacts";

/**
 * The phone's pure rules (ADR 0023): whether it is offered, what the media
 * stack is built with, which number a contact dials, how the dialer separates
 * its sources, and how a credential is looked up.
 *
 * These are the parts of the phone that can be pinned without a SIP server, a
 * microphone or a browser, and they are the parts a change is most likely to
 * quietly break: the separation the dialer draws, and the credential belonging
 * to the right identity.
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
    book: { id, name, isDefault: false } as AddressBook,
  };
}

describe("whether the phone is offered", () => {
  it("is offered only with a switch on and at least one endpoint", () => {
    expect(phoneOffered(undefined)).toBe(false);
    expect(
      phoneOffered({ enabled: false, endpoints: ["wss://pbx/ws"], stun: [], turn: [] }),
    ).toBe(false);
    expect(phoneOffered({ enabled: true, endpoints: [], stun: [], turn: [] })).toBe(
      false,
    );
    expect(
      phoneOffered({ enabled: true, endpoints: ["wss://pbx/ws"], stun: [], turn: [] }),
    ).toBe(true);
  });
});

describe("the ICE servers media is built with", () => {
  it("groups the STUN servers and carries each TURN server's credential", () => {
    const servers = iceServers({
      enabled: true,
      endpoints: [],
      stun: ["stun:one:3478", "stun:two:3478"],
      turn: [
        { url: "turn:t:3478", username: "u", credential: "c" },
        { url: "", username: "", credential: "" },
      ],
    });
    expect(servers).toEqual([
      { urls: ["stun:one:3478", "stun:two:3478"] },
      { urls: "turn:t:3478", username: "u", credential: "c" },
    ]);
  });
});

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
  });

  it("puts Global contacts first, then each group, then the reader's own", () => {
    expect(sources.map((s) => s.label)).toEqual(["Global contacts", "Team", "Personal"]);
    expect(sources[0]?.global).toBe(true);
    expect(sources[0]?.cards.map((c) => c.id)).toEqual(["ada"]);
    expect(sources[1]?.cards.map((c) => c.id)).toEqual(["marie"]);
    expect(sources[2]?.cards.map((c) => c.id)).toEqual(["mine"]);
  });

  it("leaves a colleague's book out of the named sources", () => {
    expect(sources.some((s) => s.cards.some((c) => c.id === "private"))).toBe(false);
  });

  it("counts a card once, however many sources hold it", () => {
    // `ada` is in the directory and in a colleague's book that shares her id.
    const all = allDialerCards([
      ...sources,
      { id: "extra", label: "Other", global: false, cards: [card("ada", "g1")] },
    ]);
    expect(all.filter((c) => c.id === "ada")).toHaveLength(1);
  });
});

describe("Global contacts is one named book", () => {
  it("is the one the shared constant names, and nothing else", () => {
    expect(isGlobalContactsBook({ name: GLOBAL_CONTACTS_BOOK_NAME })).toBe(true);
    expect(isGlobalContactsBook({ name: "Team contacts" })).toBe(false);
  });
});

describe("the credential an identity registers with", () => {
  it("is looked up without case, and absent means no phone", async () => {
    expect(
      credentialFor(
        { "a@example.com": { address: "sip:a", password: "p" } },
        "A@Example.com",
      ),
    ).toEqual({ address: "sip:a", password: "p" });
    expect(credentialFor({}, "a@example.com")).toBeNull();
    expect(credentialFor({}, null)).toBeNull();
  });

  it("reads nothing from an account whose document is not there", async () => {
    // No account in this test has a folder: the reader answers an empty map
    // rather than throwing, which is what keeps the phone off quietly.
    await expect(readSipCredentials("no-such-account")).resolves.toEqual({});
  });
});
