import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSipCredential,
  parseSipCredentials,
  SIP_CREDENTIALS_VERSION,
  withSipCredential,
} from "./phone.js";

/**
 * The one parse and the one writer for the SIP credential document (ADR 0023).
 *
 * The administration writes it and the account's phone reads it, so the shape
 * is a contract between two tiers: a key folded differently on one side is a
 * credential the other never finds. These pin the folding, the clearing and the
 * refusal to read a document that is not one.
 */

test("a credential is a record with an address and a password", () => {
  assert.equal(isSipCredential({ address: "sip:a@b", password: "p" }), true);
  assert.equal(isSipCredential({ address: "sip:a@b" }), false);
  assert.equal(isSipCredential({ address: 1, password: "p" }), false);
  assert.equal(isSipCredential(null), false);
});

test("the document is read keyed by lower-cased email, and malformed entries are dropped", () => {
  const read = parseSipCredentials({
    version: 1,
    identities: {
      "Alice@Example.com": { address: "sip:1001@pbx", password: "p" },
      broken: { address: "sip:x@pbx" },
    },
  });
  assert.deepEqual(read, {
    "alice@example.com": { address: "sip:1001@pbx", password: "p" },
  });
});

test("not a document reads as no credentials, not as a fault", () => {
  assert.deepEqual(parseSipCredentials(null), {});
  assert.deepEqual(parseSipCredentials("nonsense"), {});
  assert.deepEqual(parseSipCredentials({ identities: 3 }), {});
  assert.deepEqual(parseSipCredentials({}), {});
});

test("setting a credential folds the key; clearing removes the entry", () => {
  const start = withSipCredential({}, "Alice@Example.com", {
    address: " sip:1001@pbx ",
    password: "p",
  });
  assert.deepEqual(start, {
    version: SIP_CREDENTIALS_VERSION,
    identities: { "alice@example.com": { address: "sip:1001@pbx", password: "p" } },
  });

  const cleared = withSipCredential(start.identities, "alice@example.com", null);
  assert.deepEqual(cleared.identities, {});

  /* An address of blanks is a clear too: an identity with no SIP address is
     one the phone does not register, not a credential of spaces. */
  const blank = withSipCredential(start.identities, "alice@example.com", {
    address: "   ",
    password: "p",
  });
  assert.deepEqual(blank.identities, {});
});
