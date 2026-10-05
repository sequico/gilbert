/**
 * What a patch aimed at one occurrence may carry, and what it may not.
 *
 * Stalwart's per-occurrence validator sorts the properties of such a patch into
 * three groups, and only one of them is honest about itself:
 *
 *   - **rejected** — answered with `invalidProperties`: the property belongs to
 *     the series, and no override can carry it. Loud, and fine;
 *   - **inherited** — dropped from the patch, while the response still reports
 *     the update succeeded. Nothing anywhere says so, and a successful response
 *     is therefore no evidence that anything was written. This is the group
 *     #26 came from: a participant map addressed the RFC 8984 way was discarded
 *     without an error, and the client showed the guests as saved;
 *   - everything else, which lands on the override.
 *
 * The two lists are one definition because each tier is the other's check. The
 * client asks them before it sends, so a patch the server would swallow is
 * refused or reported rather than believed; the mock splits a patch by them, so
 * a client that sends one anyway meets the refusal here instead of on a live
 * instance. A mock that *applied* the inherited half would agree with a client
 * that sends it, and the belief would ship — which is exactly the road #26 took
 * to a live server.
 */

/** Refused outright, with `invalidProperties`. */
export const OCCURRENCE_REJECTED: ReadonlySet<string> = new Set([
  "baseEventId",
  "calendarIds",
  "isDraft",
  "isOrigin",
  "utcStart",
  "utcEnd",
  "useDefaultAlerts",
  "mayInviteSelf",
  "mayInviteOthers",
  "hideAttendees",
]);

/**
 * Applied to the series and never to one date; dropped in silence if sent.
 *
 * The half that has to be reproduced most carefully, on both sides: a refusal
 * nobody notices is what the client has to ask about before it writes.
 */
export const OCCURRENCE_INHERITED: ReadonlySet<string> = new Set([
  "@type",
  "method",
  "organizerCalendarAddress",
  "privacy",
  "prodId",
  "recurrenceId",
  "recurrenceIdTimeZone",
  "sentBy",
  "uid",
  "recurrenceOverrides",
  "recurrenceRule",
  "relatedTo",
]);
