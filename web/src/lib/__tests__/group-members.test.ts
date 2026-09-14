import { describe, expect, it } from "vitest";
import type { ContactCard } from "@/jmap/types";
import { memberCards } from "@/lib/contacts";

/**
 * A group's members are its own cards, looked up in the account that holds them.
 *
 * A member is stored as a uid, and a uid means nothing outside that account, so
 * the card has to be found in the account's list. What the lookup must not do is
 * read that list again for every member -- drawing a group card then costs
 * members × cards, which is what made opening one heavy on an account with a
 * real address book in it.
 */

const card = (uid: string, name: string) =>
  ({ uid, kind: "individual", name: { full: name } }) as unknown as ContactCard;

describe("a group's member cards", () => {
  it("names the members in the order the group lists them", () => {
    const cards = [card("u1", "One"), card("u2", "Two"), card("u3", "Three")];
    expect(memberCards(cards, { u2: true, u1: true }).map((c) => c.name?.full)).toEqual([
      "Two",
      "One",
    ]);
  });

  it("skips a uid the account does not hold, rather than inventing a card", () => {
    expect(memberCards([card("u1", "One")], { u9: true })).toEqual([]);
  });

  it("is empty when the card names nobody", () => {
    expect(memberCards([card("u1", "One")], null)).toEqual([]);
    expect(memberCards([card("u1", "One")], undefined)).toEqual([]);
  });
});
