import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSipCredential,
  parseSipCredentials,
  SIP_CREDENTIALS_VERSION,
  withSipCredential,
} from "./phone.js";

/**
 * The one parse and the one writer for the SIP account document (ADR 0023).
 *
 * The administration writes it and the account's phone reads it, so the shape
 * is a contract between two tiers: a key folded differently on one side is an
 * account the other never finds. These pin the folding, the clearing and the
 * refusal to read a document that is not one.
 */

test("an account is a record with a server, a user name and a password", () => {
  assert.equal(isSipCredential({ server: "pbx", username: "1001", password: "p" }), true);
  assert.equal(isSipCredential({ server: "pbx", username: "1001" }), false);
  assert.equal(isSipCredential({ server: 1, username: "1001", password: "p" }), false);
  assert.equal(isSipCredential(null), false);
});

test("the document is read keyed by lower-cased email, and malformed entries are dropped", () => {
  const read = parseSipCredentials({
    version: 2,
    identities: {
      "Alice@Example.com": { server: "pbx", username: "1001", password: "p" },
      broken: { server: "pbx" },
    },
  });
  assert.deepEqual(read, {
    "alice@example.com": { server: "pbx", username: "1001", password: "p" },
  });
});

test("not a document reads as no accounts, not as a fault", () => {
  assert.deepEqual(parseSipCredentials(null), {});
  assert.deepEqual(parseSipCredentials("nonsense"), {});
  assert.deepEqual(parseSipCredentials({ identities: 3 }), {});
  assert.deepEqual(parseSipCredentials({}), {});
});

test("setting an account folds the key; clearing removes the entry", () => {
  const start = withSipCredential({}, "Alice@Example.com", {
    server: " pbx ",
    username: " 1001 ",
    password: "p",
  });
  assert.deepEqual(start, {
    version: SIP_CREDENTIALS_VERSION,
    identities: {
      "alice@example.com": { server: "pbx", username: "1001", password: "p" },
    },
  });

  const cleared = withSipCredential(start.identities, "alice@example.com", null);
  assert.deepEqual(cleared.identities, {});

  /* A server or user name of blanks is a clear too: an identity that names
     nothing to register with is one the phone does not register, not an
     account of spaces. */
  const blank = withSipCredential(start.identities, "alice@example.com", {
    server: "   ",
    username: "1001",
    password: "p",
  });
  assert.deepEqual(blank.identities, {});
});
