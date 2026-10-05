import assert from "node:assert/strict";
import { test } from "node:test";
import { unreadCount } from "./chat.js";

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
