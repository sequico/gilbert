import { describe, expect, it } from "vitest";
import { byAddress, compareAddress } from "@/lib/addressOrder";

/**
 * The order accounts and group mailboxes are listed in.
 *
 * The address is the key a person reads a list by, so the rule is one thing:
 * sort by it, case-insensitively, and never by a display name or the order the
 * input arrived in. The fixture below is deliberately out of order and
 * mixed-case, so a comparator that lost either property would show it.
 */

describe("the order accounts are listed in", () => {
  it("sorts by the address, not by the order the input arrived in", () => {
    const entries = [
      { name: "carol@example.org" },
      { name: "bob@example.org" },
      { name: "alice@example.org" },
    ];
    expect(byAddress(entries).map((e) => e.name)).toEqual([
      "alice@example.org",
      "bob@example.org",
      "carol@example.org",
    ]);
  });

  it("sorts case-insensitively, so a capital is not a second place", () => {
    const entries = [
      { name: "carol@example.org" },
      { name: "ALICE@example.org" },
      { name: "bob@example.org" },
    ];
    expect(byAddress(entries).map((e) => e.name)).toEqual([
      "ALICE@example.org",
      "bob@example.org",
      "carol@example.org",
    ]);
    expect(compareAddress("Alice@example.org", "alice@example.org")).toBe(0);
  });

  it("sorts a copy, not the list it was handed", () => {
    const entries = [{ name: "b@example.org" }, { name: "a@example.org" }];
    byAddress(entries);
    expect(entries.map((e) => e.name)).toEqual(["b@example.org", "a@example.org"]);
  });
});
