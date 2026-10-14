import { describe, expect, it } from "vitest";
import type { ContactCard } from "@/jmap/types";
import { useContacts } from "@/store/contacts";

/*
 * A card's search text is built once per card object and reused until that
 * object is replaced, because a card is an immutable value the store swaps
 * rather than edits. These pin the two ways that reuse can go wrong: the build
 * running again for a query it already answered, and a new object being handed
 * the previous one's text.
 */

const CARD = {
  id: "c1",
  "@type": "Card",
  version: "1.0",
  uid: "u1",
  kind: "individual",
  name: { "@type": "Name", full: "Ada Lovelace" },
  emails: { e1: { "@type": "EmailAddress", address: "ada@example.com" } },
} as unknown as ContactCard;

/*
 * A card that counts the reads of `emails` -- the one field the search text
 * reads and nothing else reads for a card whose `name.full` is set, so one read
 * is one build.
 */
function countingCard(card: ContactCard): { card: ContactCard; reads: () => number } {
  let reads = 0;
  const emails = card.emails;
  const counted = { ...card } as ContactCard;
  Object.defineProperty(counted, "emails", {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return emails;
    },
  });
  return { card: counted, reads: () => reads };
}

describe("the contact search filter", () => {
  it("builds a card's text once, not once per query", () => {
    const { card, reads } = countingCard(CARD);
    const { filterCards } = useContacts.getState();

    expect(filterCards([card], "ada")).toHaveLength(1);
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThan(0);

    // Reused, and still answering: a second query on another field and one that
    // matches nothing add no build.
    expect(filterCards([card], "lovelace")).toHaveLength(1);
    expect(filterCards([card], "nobody")).toHaveLength(0);
    expect(reads()).toBe(afterFirst);
  });

  it("gives a changed card its new text instead of the old object's", () => {
    const before = { ...CARD } as ContactCard;
    const { filterCards } = useContacts.getState();
    expect(filterCards([before], "ada")).toHaveLength(1);

    // The store replaces a card object when the card changes: same id, a new
    // object with the new values.
    const after = {
      ...before,
      name: { "@type": "Name", full: "Grace Hopper" },
      emails: {},
    } as ContactCard;

    expect(filterCards([after], "grace")).toHaveLength(1);
    expect(filterCards([after], "ada")).toHaveLength(0);
  });

  it("matches name, address, phone, organisation and nickname", () => {
    const card = {
      ...CARD,
      phones: { p1: { "@type": "Phone", number: "+39061234" } },
      organizations: { o1: { "@type": "Organization", name: "Analytical Engines" } },
      nicknames: { n1: { "@type": "Nickname", name: "Enchantress" } },
    } as ContactCard;
    const { filterCards } = useContacts.getState();

    for (const q of ["lovelace", "ada@example.com", "061234", "engines", "enchantress"])
      expect(filterCards([card], q)).toHaveLength(1);
    // Joined by a space, so a query may run across two fields.
    expect(filterCards([card], "lovelace ada@example.com")).toHaveLength(1);
    expect(filterCards([card], "nobody@example.org")).toHaveLength(0);
  });
});
