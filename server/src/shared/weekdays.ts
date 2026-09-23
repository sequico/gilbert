/**
 * JSCalendar's two-letter weekdays, Monday first, once for both tiers.
 *
 * The set is a contract: the client builds a recurrence rule from it, reads
 * an occurrence back with it, and names a day in the reader's locale from it,
 * and the mock reproduces the server's answer with the same seven days. A
 * second copy spelled anywhere is a day a picker can offer and a rule cannot
 * carry.
 *
 * Pure: the constant and the type derived from it, nothing else.
 */

/** The seven days, Monday first, as JSCalendar spells them. */
export const WEEKDAY_KEYS = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;

/** One of JSCalendar's days: the type is the array's own, so the two agree. */
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
