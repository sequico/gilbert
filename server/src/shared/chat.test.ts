import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addressedToAgent,
  mentionFormRegex,
  mentionsAddress,
  mentionsByName,
  mentionsName,
  unreadCount,
} from "./chat.js";

/**
 * The unread badge of a paged transcript.
 *
 * `unreadCount` lives here and is consumed by the chat store in `web/`, which
 * pages the transcript from the tail (see `loadOlder` there). The ADR kind rule
 * itself is exercised beside that store; what this file pins is the case paging
 * creates — a marker the window in hand does not hold.
 */
const windowOf = (ids: string[]) => ids.map((id) => ({ id }));

test("a marker inside the window counts only what follows it", () => {
  assert.equal(unreadCount(windowOf(["m4", "m5", "m6"]), { lastRead: "m5" }, false), 1);
  assert.equal(unreadCount(windowOf(["m4", "m5", "m6"]), { lastRead: "m6" }, false), 0);
});

test("a marker in the older part makes the whole window unread", () => {
  // The member was away long enough that the messages they had read are not in
  // hand: everything the window holds is newer than their marker, so the badge
  // is the window. Reading that as 0 tells somebody who has hundreds of unread
  // messages that there is nothing new.
  const held = windowOf(["m101", "m102", "m103"]);
  assert.equal(unreadCount(held, { lastRead: "m50" }, false), 3);
});

test("a window that starts at position 0 reads a missing marker as deleted", () => {
  // The one case that is nothing unread: with the whole transcript in hand, a
  // marker whose message is gone cannot mean unread messages ahead of it.
  const whole = windowOf(["m1", "m2", "m3"]);
  assert.equal(unreadCount(whole, { lastRead: "gone" }, true), 0);
  assert.equal(
    unreadCount(whole, { lastRead: "gone" }),
    0,
    "a caller that does not say is assumed to hold the whole transcript",
  );
});

test("no marker, and a marker born on an empty chat, ignore paging", () => {
  assert.equal(unreadCount(windowOf(["m1", "m2"]), null, false), 0);
  assert.equal(unreadCount(windowOf(["m1", "m2"]), { lastRead: null }, false), 2);
});

test("a mention ends at the address, not inside a longer one", () => {
  /*
   * An unanchored `@(address)` test matched `@sam@example.org` inside
   * `@sam@example.orgx`, so the agent's pre-filter woke for a message that
   * addressed somebody else. The full-address form now draws the same boundary
   * `mentionsName` already drew for the local part.
   */
  const address = "sam@example.org";
  assert.equal(mentionsAddress("@sam@example.org", address), true);
  assert.equal(mentionsAddress("hi @sam@example.org, welcome", address), true);
  assert.equal(
    mentionsAddress("@sam@example.orgx", address),
    false,
    "an address that is a prefix of a longer one is not a mention of it",
  );

  assert.equal(mentionsName("@sam can you look?", address), true);
  assert.equal(mentionsName("@samuel no", address), false);
});

const SAM = "sam@example.org";
const ADA = "ada@example.org";

test("a mention is found in the full form and in the local part", () => {
  assert.deepEqual(mentionsByName("hello @sam@example.org", [SAM, ADA]), [
    { kind: "principal", id: SAM },
  ]);
  assert.deepEqual(mentionsByName("hello @sam", [SAM, ADA]), [
    { kind: "principal", id: SAM },
  ]);
  assert.deepEqual(
    mentionsByName("hello @sam and @ada", [SAM, ADA]).map((one) => one.id),
    [SAM, ADA],
  );
  assert.deepEqual(mentionsByName("no mention here", [SAM, ADA]), []);
});

test("a local part shared by two addresses is not a mention of either", () => {
  const list = ["sam@one.example", "sam@two.example"];
  assert.deepEqual(mentionsByName("hi @sam", list), []);
  assert.deepEqual(mentionsByName("hi @sam@one.example", list), [
    { kind: "principal", id: "sam@one.example" },
  ]);
});

test("the renderer splits on either form and leaves an ambiguous local part alone", () => {
  const text = "hi @sam, and @ada@example.org too";
  const parts = text.split(mentionFormRegex([SAM, ADA]));
  assert.ok(parts.includes("sam"), "the local part is a match of its own");
  assert.ok(parts.includes("ada@example.org"), "and the full form is too");

  const ambiguous = "hi @sam".split(
    mentionFormRegex(["sam@one.example", "sam@two.example"]),
  );
  assert.deepEqual(ambiguous, ["hi @sam"], "an ambiguous local part is plain text");
});

test("a mention ends at punctuation, like the stored mark does", () => {
  const text = "thanks @sam, noted.";
  assert.equal(mentionsByName(text, [SAM]).length, 1);
  assert.ok(text.split(mentionFormRegex([SAM])).includes("sam"));
});

/**
 * Who a chat message is for (owner decision 2026-10-22): the agent unless the
 * message names somebody else. The rule is what the wake reads before it spends
 * a decision, so the cases are pinned here rather than in the loop test alone.
 */
test("a chat message is the agent's unless it names somebody else", () => {
  const agent = "gilbert@example.org";
  const isMine = (message: Parameters<typeof addressedToAgent>[0]) =>
    addressedToAgent(message, agent);

  assert.equal(isMine({ text: "what is the status of the shipment?" }), true);
  assert.equal(isMine({ text: "@gilbert what is the status?" }), true);
  assert.equal(isMine({ text: "hello", mentions: [{ id: agent }] }), true);
  assert.equal(
    isMine({ text: "hi @sam", mentions: [{ id: SAM }] }),
    false,
    "another person is named: theirs, not the agent's",
  );
  assert.equal(
    isMine({ text: "hi @sam@example.org" }),
    false,
    "a name typed by hand counts where no mark was stored",
  );
  assert.equal(
    isMine({ text: "@sam and @gilbert, look at this" }),
    true,
    "both named: still the agent's",
  );
  assert.equal(
    isMine({ text: "thanks @gilbert." }),
    true,
    "a sentence ends after the name",
  );
  assert.equal(
    isMine({ text: "hello", mentions: [{ id: SAM }] }),
    false,
    "a stored mark of somebody else, with no words to read",
  );
  assert.equal(
    isMine({ text: "scrivi a josè@example.org" }),
    true,
    "a letter of any script before @ is an address, not a mention",
  );
  assert.equal(
    isMine({ text: "write to ops@shipper.example" }),
    true,
    "an address inside a sentence is not a mention",
  );
  assert.equal(
    isMine({ text: "@here stand-up in five" }),
    false,
    "a call to the room is somebody else's",
  );
});
