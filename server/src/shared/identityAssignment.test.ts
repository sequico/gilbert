import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountOwnIdentity,
  assignmentFor,
  groupSenderIdentity,
  isAccountOwnIdentity,
  isMemberKey,
  toAssignmentDoc,
} from "./identityAssignment.js";

/**
 * What a member sends as in a group (ADR 0007), and what a saved document may
 * say.
 *
 * A group's account holds one identity per member, and the fact that binds a
 * member to theirs is an **assignment the administration wrote** — a member
 * address mapped to an id of that account — not a display name compared on both
 * sides. Two things follow, and each case below fails when its own is taken
 * away:
 *
 *   - the cascade: the identity assigned to the member, else **the group's own**
 *     (which is what the agent sends as too), else nothing at all;
 *   - the document's own shape, read rather than trusted, because a corrupt file
 *     read as an assignment is a member sending under somebody else's name.
 *
 * Both tiers import this module, so a case here is a case for the composer and
 * for the administration at once.
 */

const GROUP = "team@example.org";
const other = { id: "b", email: GROUP };
const mine = { id: "c", email: GROUP };
const identities = [other, mine];

describe("which identity a group mailbox sends as", () => {
  it("offers the identity assigned to the member", () => {
    assert.equal(groupSenderIdentity(identities, "c", GROUP), mine);
  });

  it("offers the group's own identity when nothing is assigned", () => {
    // The middle step, which is what keeps a member from being stuck: an
    // identity nobody is assigned is the group's own voice, and it is what the
    // agent sends as too.
    assert.equal(groupSenderIdentity(identities, null, GROUP), other);
    assert.equal(groupSenderIdentity(identities, undefined, GROUP), other);
  });

  it("never offers another member's identity", () => {
    // Somebody else's identity is in the list and is not the group's own; the
    // reader is assigned nothing, and what they get is the group's own.
    const theirs = { id: "x", email: GROUP };
    assert.equal(groupSenderIdentity([other, theirs], null, GROUP), other);
  });

  it("falls back to the group's own when the assignment names an identity it no longer holds", () => {
    // An identity deleted in Stalwart's own administration leaves the entry
    // behind; it is no assignment, and it is not an error either.
    assert.equal(groupSenderIdentity(identities, "gone", GROUP), other);
  });

  it("offers nothing at all when the group holds no identity", () => {
    // The one state with nothing to send as, and the only one the composer
    // reports.
    assert.equal(groupSenderIdentity([], null, GROUP), undefined);
    assert.equal(groupSenderIdentity([], "c", GROUP), undefined);
  });

  it("takes the account's own address for the group's identity, else the first", () => {
    // The same rule the installation's agent sends by, so a member with no
    // assignment and the agent send a group's mail identically.
    const list = [
      { id: "g1", email: "alias@example.net" },
      { id: "g2", email: GROUP },
    ];
    assert.equal(accountOwnIdentity(list, GROUP)?.id, "g2");
    assert.equal(accountOwnIdentity(list, "nobody@example.org")?.id, "g1");
    assert.equal(accountOwnIdentity(list, null)?.id, "g1");
    assert.equal(accountOwnIdentity([], GROUP), undefined);
  });

  it("compares addresses without case or surrounding space", () => {
    const list = [{ id: "g1", email: " Team@Example.ORG " }];
    assert.equal(accountOwnIdentity(list, "team@example.org")?.id, "g1");
  });

  it("says whether an identity is the account's own", () => {
    const list = [
      { id: "g1", email: "alias@example.net" },
      { id: "g2", email: GROUP },
    ];
    assert.equal(isAccountOwnIdentity(list[1]!, GROUP, list), true);
    assert.equal(isAccountOwnIdentity(list[0]!, GROUP, list), false);
  });
});

describe("the document the assignment lives in", () => {
  it("reads the shape a writer wrote", () => {
    const doc = toAssignmentDoc({
      v: 1,
      members: { "sq@example.org": "b" },
      updatedAt: "2026-09-15T00:00:00.000Z",
      updatedBy: "admin@example.org",
    });
    assert.deepEqual(doc?.members, { "sq@example.org": "b" });
    assert.equal(assignmentFor(doc?.members ?? {}, "sq@example.org"), "b");
    assert.equal(assignmentFor(doc?.members ?? {}, "SQ@Example.ORG"), "b");
    assert.equal(assignmentFor(doc?.members ?? {}, "other@example.org"), null);
    assert.equal(assignmentFor(doc?.members ?? {}, null), null);
  });

  it("reads nothing rather than trusting a document it does not know", () => {
    // A version this reader does not know, a members field that is not an
    // object, an absent one: each is read as no assignment, which is a state
    // every caller already handles, rather than as one.
    assert.equal(toAssignmentDoc(null), null);
    assert.equal(toAssignmentDoc([]), null);
    assert.equal(toAssignmentDoc({ members: {} }), null);
    assert.equal(toAssignmentDoc({ v: 2, members: {} }), null);
    assert.equal(toAssignmentDoc({ v: 1, members: [] }), null);
    assert.equal(toAssignmentDoc({ v: 1 }), null);
  });

  it("drops an entry that names no identity or no member, and keeps the rest", () => {
    const doc = toAssignmentDoc({
      v: 1,
      members: { "sq@example.org": "b", "other@example.org": "", nonsense: "c" },
    });
    assert.deepEqual(doc?.members, { "sq@example.org": "b" });
  });

  it("folds the key it keeps, so a lookup cannot miss on case", () => {
    const doc = toAssignmentDoc({ v: 1, members: { " SQ@Example.ORG ": "b" } });
    assert.deepEqual(doc?.members, { "sq@example.org": "b" });
  });

  it("knows what a member key is", () => {
    assert.equal(isMemberKey("sq@example.org"), true);
    assert.equal(isMemberKey(" sq@example.org "), true);
    assert.equal(isMemberKey("nonsense"), false);
    assert.equal(isMemberKey(""), false);
  });
});
