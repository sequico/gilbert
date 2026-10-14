import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGroupAccountRecord, sessionIsAdmin } from "./sessionAccount.js";

/**
 * The two questions both tiers ask about a session, asked the way the code
 * asks them.
 *
 * `sessionIsAdmin` is one comparison, and the comparison is the point: eight
 * surfaces read the flag, and a surface that read it as "truthy" would draw an
 * administration control to somebody who had lost the grant. A `"true"` off the
 * wire, a `1`, and a session that has not arrived all read as *not* an
 * administrator here, which is the answer that refuses.
 */
describe("sessionIsAdmin", () => {
  it("is true only for the marker the session really carries", () => {
    assert.equal(sessionIsAdmin({ gilbert: { isAdmin: true } }), true);
  });

  it("reads anything else as not an administrator", () => {
    assert.equal(sessionIsAdmin({ gilbert: { isAdmin: "true" } }), false);
    assert.equal(sessionIsAdmin({ gilbert: { isAdmin: 1 } }), false);
    assert.equal(sessionIsAdmin({ gilbert: {} }), false);
    assert.equal(sessionIsAdmin({}), false);
    assert.equal(sessionIsAdmin(null), false);
    assert.equal(sessionIsAdmin(undefined), false);
  });
});

describe("isGroupAccountRecord", () => {
  it("is a non-personal account named by an address", () => {
    assert.equal(
      isGroupAccountRecord({ isPersonal: false, name: "team@example.com" }),
      true,
    );
    assert.equal(
      isGroupAccountRecord({ isPersonal: false, name: " team@example.com " }),
      true,
    );
  });

  it("is neither a personal account nor one without an address", () => {
    assert.equal(
      isGroupAccountRecord({ isPersonal: true, name: "team@example.com" }),
      false,
    );
    assert.equal(isGroupAccountRecord({ name: "team@example.com" }), false);
    assert.equal(isGroupAccountRecord({ isPersonal: false, name: "team" }), false);
    assert.equal(isGroupAccountRecord({ isPersonal: false }), false);
    assert.equal(isGroupAccountRecord(undefined), false);
  });
});
