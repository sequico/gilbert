import assert from "node:assert/strict";
import { test } from "node:test";
import { hasChatGroupAccounts } from "./upstream.js";

/*
 * The server-side chat-flag classifier (ADR 0005). It is the wire-level
 * superset of the client's groupMailboxAccounts -- the client probes mail
 * trees, the server only reads account names -- so the tests pin the two
 * directions that matter: any non-personal account with an address counts,
 * which keeps the flag wider than the client's offer. Since ADR 0001 there
 * is no product-admin group to exclude: an account named `gilbert-admin@…`,
 * if an operator ever keeps one, is just another group mailbox.
 */

const session = (accounts: Record<string, { name: string; isPersonal: boolean }>) => ({
  accounts,
});

test("a group mailbox counts — including one named gilbert-admin (ADR 0001)", () => {
  const s = session({
    a1: { name: "demo@example.com", isPersonal: true },
    a4: { name: "gilbert-admin@example.org", isPersonal: false },
  });
  assert.equal(hasChatGroupAccounts(s), true);
});

test("a working group mailbox counts", () => {
  const s = session({
    a1: { name: "demo@example.com", isPersonal: true },
    a3: { name: "team@example.org", isPersonal: false },
  });
  assert.equal(hasChatGroupAccounts(s), true);
});

test("non-personal shares count too: the flag stays a superset of the client offer", () => {
  const s = session({
    a1: { name: "demo@example.com", isPersonal: true },
    a2: { name: "grace@example.org", isPersonal: false },
  });
  assert.equal(hasChatGroupAccounts(s), true);
});

test("an address-less non-personal account does not count", () => {
  const s = session({
    a1: { name: "demo@example.com", isPersonal: true },
    a2: { name: "Calendar share", isPersonal: false },
  });
  assert.equal(hasChatGroupAccounts(s), false);
});

test("a session with no session accounts has no chat", () => {
  assert.equal(hasChatGroupAccounts(null), false);
  assert.equal(hasChatGroupAccounts(session({})), false);
});
