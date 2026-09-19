import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OCCURRENCE_INHERITED,
  OCCURRENCE_REJECTED,
} from "./calendarOccurrence.js";

/**
 * The contract, pinned.
 *
 * These two lists are the whole reason the client checks a per-occurrence patch
 * before it sends one and the mock splits a patch by them: the properties in
 * the first come back as `invalidProperties`, and the ones in the second are
 * dropped while the response reports success. Dropping a member of either list
 * does not break a build — it silently stops the pair from catching the write it
 * exists to catch — so the membership is asserted here rather than assumed.
 */

test("a single occurrence refuses the properties that belong to the series", () => {
  assert.deepEqual([...OCCURRENCE_REJECTED].sort(), [
    "baseEventId",
    "calendarIds",
    "hideAttendees",
    "isDraft",
    "isOrigin",
    "mayInviteOthers",
    "mayInviteSelf",
    "useDefaultAlerts",
    "utcEnd",
    "utcStart",
  ]);
});

test("the server drops the inherited half in silence", () => {
  assert.deepEqual([...OCCURRENCE_INHERITED].sort(), [
    "@type",
    "method",
    "organizerCalendarAddress",
    "privacy",
    "prodId",
    "recurrenceId",
    "recurrenceIdTimeZone",
    "recurrenceOverrides",
    "recurrenceRule",
    "relatedTo",
    "sentBy",
    "uid",
  ]);
});

test("a property is refused or inherited, never both", () => {
  for (const property of OCCURRENCE_REJECTED) {
    assert.equal(
      OCCURRENCE_INHERITED.has(property),
      false,
      `${property} is in both lists, so neither answer is the server's`,
    );
  }
});
