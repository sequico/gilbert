import { describe, expect, it } from "vitest";
import {
  isAlwaysVisible,
  offeredInGroupAccount,
  visibleIdentities,
} from "@/lib/identityVisibility";

/**
 * Issue #73: a unique address per service, on a server with an alias domain,
 * gives every local part twice and a compose picker nobody can use — while only
 * a handful are ever sent from.
 *
 * The interesting cases are not the hiding. They are the three refusals, all of
 * which exist because a sender picker with nothing usable in it is worse than a
 * cluttered one.
 */

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i + 1}`,
    email: `a${i + 1}@example.com`,
  }));

describe("hiding identities from the picker", () => {
  it("removes the hidden ones", () => {
    expect(visibleIdentities(ids(4), ["i2", "i4"]).map((i) => i.id)).toEqual([
      "i1",
      "i3",
    ]);
  });

  it("changes nothing when none are hidden", () => {
    const all = ids(3);
    expect(visibleIdentities(all, [])).toBe(all);
  });
});

describe("what it refuses to hide", () => {
  it("keeps the identity the draft is already using", () => {
    // Otherwise the select has no matching option and the From line moves
    // under the writer.
    expect(visibleIdentities(ids(3), ["i2"], ["i2"]).map((i) => i.id)).toEqual([
      "i1",
      "i2",
      "i3",
    ]);
  });

  it("keeps the default, which a new draft starts on", () => {
    expect(
      visibleIdentities(ids(3), ["i1", "i3"], [null, "i1"]).map((i) => i.id),
    ).toEqual(["i1", "i2"]);
  });

  it("shows everything rather than nothing when all are hidden", () => {
    const all = ids(3);
    expect(visibleIdentities(all, ["i1", "i2", "i3"]).map((i) => i.id)).toEqual([
      "i1",
      "i2",
      "i3",
    ]);
  });

  it("ignores an id for an identity that no longer exists", () => {
    // A deleted identity leaves its id behind in the setting; it must not
    // silently hide anything else or empty the list.
    expect(visibleIdentities(ids(2), ["gone"]).map((i) => i.id)).toEqual(["i1", "i2"]);
  });

  it("tolerates nulls among the ids to keep", () => {
    expect(visibleIdentities(ids(2), ["i1"], [null, undefined]).map((i) => i.id)).toEqual(
      ["i2"],
    );
  });
});

describe("what the settings row may offer", () => {
  it("refuses to offer hiding for an always-visible identity", () => {
    expect(isAlwaysVisible("i1", ["i1"])).toBe(true);
    expect(isAlwaysVisible("i2", ["i1"])).toBe(false);
    expect(isAlwaysVisible("i2", [null, undefined])).toBe(false);
  });
});

/**
 * ADR 0007: a group's account holds one identity per member, all carrying the
 * group's own address and each carrying that member's own name. The member is
 * bound to their identity by that name. Enforcing identities means nothing
 * while the picker under it still offers somebody else's, so the rule is the
 * member's own name or nothing of theirs.
 */
const members = [
  { id: "g1", name: "Ann Other" },
  { id: "g2", name: "Robin Reader" },
  { id: "g3", name: "Robin Reader Jr" },
];

describe("who a group mailbox offers", () => {
  it("offers the identities carrying the reader's own name, and nothing else", () => {
    expect(
      offeredInGroupAccount(members, { name: "Robin Reader" }).map((i) => i.id),
    ).toEqual(["g2"]);
  });

  it("matches on the name trimmed and without case", () => {
    // The name as the group stored it is not necessarily the spacing or case
    // the member's own account carries it in.
    expect(
      offeredInGroupAccount(members, { name: "  robin reader " }).map((i) => i.id),
    ).toEqual(["g2"]);
  });

  it("does not match a name that merely starts the same way", () => {
    const offered = offeredInGroupAccount(members, { name: "Robin" }).map((i) => i.id);
    expect(offered).toEqual([]);
  });

  it("offers nothing rather than another member's identity when no name matches", () => {
    // The account's own default may name somebody else -- `defaultId` is a
    // fallback for an unknown list, never a stand-in for a name that matched
    // nothing.
    expect(offeredInGroupAccount(members, { name: "Nobody" }, "g3")).toEqual([]);
    expect(offeredInGroupAccount(members, { name: "Nobody" }, "g1")).toEqual([]);
  });

  it("offers nothing when the reader's own identity carries no name", () => {
    expect(offeredInGroupAccount(members, { name: "" })).toEqual([]);
    expect(offeredInGroupAccount(members, { name: null })).toEqual([]);
    expect(offeredInGroupAccount(members, { name: "   " }, "g2")).toEqual([]);
  });

  it("falls back to the account's default identity while the reader's own list is unknown", () => {
    const offered = offeredInGroupAccount(members, undefined, "g3").map((i) => i.id);
    expect(offered).toEqual(["g3"]);
  });

  it("falls back to the first while the reader's own list is unknown and the default is gone", () => {
    const offered = offeredInGroupAccount(members, undefined, "gone").map((i) => i.id);
    expect(offered).toEqual(["g1"]);
  });

  it("offers one identity, never the membership, before the reader's own list is here", () => {
    expect(offeredInGroupAccount(members, undefined).map((i) => i.id)).toEqual(["g1"]);
    expect(offeredInGroupAccount(members, undefined, "g2").map((i) => i.id)).toEqual([
      "g2",
    ]);
  });

  it("ignores an empty name rather than matching the identities that have none", () => {
    const unnamed = [
      { id: "g1", name: "" },
      { id: "g2", name: "Robin Reader" },
    ];
    // Neither a match on the blank names nor a fallback to somebody else's.
    expect(offeredInGroupAccount(unnamed, { name: "   " }, "g1")).toEqual([]);
  });

  it("offers nothing at all when the group's list is empty", () => {
    expect(offeredInGroupAccount([], { name: "Robin Reader" })).toEqual([]);
    expect(offeredInGroupAccount([], undefined, "gone")).toEqual([]);
  });
});
