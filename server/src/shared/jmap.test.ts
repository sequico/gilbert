import assert from "node:assert/strict";
import { test } from "node:test";
import { moveMailboxPatch } from "./jmap.js";

/**
 * A move's patch, as both tiers write it.
 *
 * One function, two callers with different knowledge: the client's optimistic
 * move knows the folder the message is leaving, and the agent's `mail.file` is
 * a move out of every folder the message was read in. The pin is that the two
 * modes stay the two they are — clearing one folder and clearing all of them
 * are different claims about a message that sits in several.
 */
test("a move's patch clears the folder it left, or every folder it was in", () => {
  assert.deepEqual(
    moveMailboxPatch({ a: true, b: true }, "c", "a"),
    { "mailboxIds/a": null, "mailboxIds/c": true },
    "a known source folder is the only one cleared",
  );
  assert.deepEqual(
    moveMailboxPatch({ a: true, b: true }, "c", null),
    { "mailboxIds/a": null, "mailboxIds/b": null, "mailboxIds/c": true },
    "no source named is a move out of every folder the message was read in",
  );
  assert.deepEqual(
    moveMailboxPatch({ a: true }, "a", "a"),
    { "mailboxIds/a": true },
    "a move into the folder it is already in clears nothing",
  );
});
