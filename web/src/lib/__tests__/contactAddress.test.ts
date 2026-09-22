/**
 * Where an opened contact lives: its id, and the account holding it.
 *
 * The two are one address, and that is the whole point: Stalwart's ids are the
 * account's own, so the reader's own card and a group's can carry the same one —
 * and a bare id resolves to the reader's own, which leaves the other card
 * unreachable from any list that holds both.
 */
import { describe, expect, it } from "vitest";
import type { ContactCard, Id } from "@/jmap/types";
import { cardAddressFrom, cardAt, cardPath } from "@/lib/contactAddress";
import { sharedKey } from "@/lib/sharedKey";

const card = (id: string, full: string) =>
  ({ id, name: { full } }) as unknown as ContactCard;

const cards: Record<Id, ContactCard> = { k9: card("k9", "Ada Person") };
const sharedCards: Record<string, ContactCard> = {
  [sharedKey("grp", "k9")]: card("k9", "Freight team"),
};

describe("cardPath", () => {
  it("qualifies another account's card and leaves the reader's own bare", () => {
    expect(cardPath({ id: "k9", accountId: null })).toBe("/contacts/k9");
    expect(cardPath({ id: "k9", accountId: "grp" })).toBe("/contacts/k9?account=grp");
  });
});

describe("cardAddressFrom", () => {
  it("reads the account a route names, and treats the reader's own as no qualifier", () => {
    expect(cardAddressFrom("k9", "", "own")).toEqual({ id: "k9", accountId: null });
    expect(cardAddressFrom("k9", "?account=grp", "own")).toEqual({
      id: "k9",
      accountId: "grp",
    });
    // The session's own account named explicitly is the reader's own card.
    expect(cardAddressFrom("k9", "?account=own", "own")).toEqual({
      id: "k9",
      accountId: null,
    });
    expect(cardAddressFrom(undefined, "", "own")).toBeNull();
  });
});

describe("cardAt", () => {
  it("answers with the account the address names, not the reader's own map", () => {
    expect(cardAt(cards, sharedCards, { id: "k9", accountId: "grp" })).toEqual({
      card: sharedCards[sharedKey("grp", "k9")],
      accountId: "grp",
    });
    expect(cardAt(cards, sharedCards, { id: "k9", accountId: null })).toEqual({
      card: cards.k9,
      accountId: null,
    });
  });

  it("falls back to the reader's own card for an address naming another account that holds none", () => {
    expect(cardAt(cards, sharedCards, { id: "k9", accountId: "other" })).toEqual({
      card: cards.k9,
      accountId: null,
    });
    expect(cardAt(cards, sharedCards, null)).toBeUndefined();
  });
});
