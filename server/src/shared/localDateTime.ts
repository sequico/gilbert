/**
 * The naive local datetime — `2026-08-31T09:00:00`, no zone and no offset.
 *
 * JSCalendar's `LocalDateTime`: the wall clock a reader in any zone reads the
 * same way, which is what an event's `start` is when the event is not pinned
 * to an instant. `Date.toISOString` is the wrong tool for it — it converts to
 * UTC and appends a `Z`, so a 09:00 appointment in Berlin would be stored as
 * 07:00 — and its inverse is worse. Every component below is therefore the
 * **local** one, and the string carries no zone precisely because the reader's
 * zone is the one that gives it meaning.
 *
 * Both tiers compose it: the browser when it turns a `Date` into a stored
 * start (`lib/dates.ts`, `lib/eventDrag.ts`, `store/calendar.ts`), the mock
 * when it fabricates a server's answer (`mock/recurrence.ts`, `mock/index.ts`)
 * — and the events the mock serves have to be the shape the client sends, or
 * the dev loop exercises a format no real server sees.
 *
 * The names here are the mock's: the client's `dates.ts` keeps `toLocalDateTime`
 * and `toLocalDateOnly` as its own spellings of the same two functions, for
 * the ~20 call sites that already read that way.
 */

/** Two digits, which is what every component of the form below is. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DDTHH:MM:SS`, from `d`'s local components. */
export function localDateTime(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** `YYYY-MM-DD`, from `d`'s local components. */
export function localDateOnly(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
