import assert from "node:assert/strict";
import { test } from "node:test";
import { hasChatGroupAccounts } from "./upstream.js";

/*
 * The server-side chat-flag classifier (ADR 0006). It is the wire-level
 * superset of the client's groupMailboxAccounts -- the client probes mail
 * trees, the server only reads account names -- so the tests pin the two
 * directions that matter: the admin group never counts, and calendar/files
 * shares (non-personal, non-admin) do count, keeping the flag wider than the
 * client's offer.
 */

const session = (accounts: Record<string, { name: string; isPersonal: boolean }>) => ({
  accounts,
});

test("the admin group never counts, on any domain", () => {
  const s = session({
    a1: { name: "demo@example.com", isPersonal: true },
    a4: { name: "gilbert-admin@example.org", isPersonal: false },
  });
  assert.equal(hasChatGroupAccounts(s), false);
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

test("a session with no session accounts has no chat", () => {
  assert.equal(hasChatGroupAccounts(null), false);
  assert.equal(hasChatGroupAccounts(session({})), false);
});
