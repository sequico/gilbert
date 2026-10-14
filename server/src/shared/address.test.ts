import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEmailAddress } from "./address.js";

/**
 * What this product accepts as an address.
 *
 * One predicate, read by the policy editor, the identity doors, the assignment
 * document and the browser's own composer. That the browser asked this one is
 * the claim worth pinning: it kept its own copy for a while, stricter in a way
 * that lost mail — it excluded an apostrophe from the local part, so
 * `o'brien@example.com` was accepted by the server, stored, and refused at the
 * composer with the recipient marked invalid and the send stopped.
 *
 * What a server actually accepts is the server's answer; this refuses only the
 * obviously-not, and both tiers must refuse the same obviously-not.
 */
describe("isEmailAddress", () => {
  it("accepts an ordinary address, and one whose local part is punctuated", () => {
    for (const address of [
      "a@b.co",
      "first.last@example.com",
      "o'brien@example.com",
      'weird"quote@example.com',
      "plus+tag@sub.example.co.uk",
      "user_name@example.com",
    ]) {
      assert.equal(isEmailAddress(address), true, address);
    }
  });

  it("trims, because an address read from a form arrives with its edge spaces", () => {
    assert.equal(isEmailAddress("  ada@example.com  "), true);
  });

  it("refuses what is not an address", () => {
    for (const value of [
      "",
      "   ",
      "nope",
      "@example.com",
      "ada@",
      "ada@example",
      "ada@@example.com",
      "ada example@test.com",
      "ada@example.com and bob@example.com",
      "<ada@example.com>",
    ]) {
      assert.equal(isEmailAddress(value), false, JSON.stringify(value));
    }
  });
});
