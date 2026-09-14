import { describe, expect, it } from "vitest";
import type { ContactCard } from "@/jmap/types";
import { groupRecipients } from "@/lib/contacts";

/**
 * Who a group stands for (ADR 0004).
 *
 * A group is a name for people who are already cards, and the resolution is
 * one address per member -- the preferred one, because a card carrying two is
 * one person and must not receive two copies. A member that is not there, has
 * no address, or is itself a group is skipped and counted: the reader is owed
 * the number of people left out of what they asked for.
 */

const card = (over: Partial<ContactCard>) =>
  ({ kind: "individual", ...over }) as ContactCard;

const ADA = card({
  id: "c1",
  uid: "u-ada",
  name: { full: "Ada" },
  emails: {
    e2: { address: "ada@personal.example" },
    e1: { address: "ada@work.example", pref: 1 },
  },
});
const BOB = card({ id: "c2", uid: "u-bob", name: { full: "Bob" } }); // no address
const NESTED = card({
  id: "c3",
  uid: "u-nested",
  kind: "group",
  name: { full: "Inner" },
});

const GROUP = card({
  id: "g1",
  uid: "u-group",
  kind: "group",
  name: { full: "Freight team" },
  members: { "u-ada": true, "u-bob": true, "u-nested": true, "u-gone": true },
});

describe("the addresses a group stands for", () => {
  it("gives one address per member, the preferred one", () => {
    const { addresses, skipped } = groupRecipients(GROUP, [ADA, BOB, NESTED]);
    expect(addresses).toEqual([{ name: "Ada", email: "ada@work.example" }]);
    // Bob has no address, the nested group is not followed, and `u-gone` is
    // not in these cards at all.
    expect(skipped).toBe(3);
  });

  it("does not send one person two copies for two cards of them", () => {
    const twin = card({
      id: "c9",
      uid: "u-twin",
      name: { full: "Ada again" },
      emails: { e1: { address: "ada@work.example" } },
    });
    const group = card({ kind: "group", members: { "u-ada": true, "u-twin": true } });
    const { addresses, skipped } = groupRecipients(group, [ADA, twin]);
    expect(addresses).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  it("says nothing at all for an empty group", () => {
    expect(groupRecipients(card({ kind: "group" }), [ADA])).toEqual({
      addresses: [],
      skipped: 0,
    });
  });
});
