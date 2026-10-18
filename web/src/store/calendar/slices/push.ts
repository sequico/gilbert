import type { CalendarGet, CalendarSet, CalendarState } from "../types";

/**
 * Push: what a change set arriving from the server makes this store re-read.
 *
 * A slice of the calendar store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function pushSlice(
  _set: CalendarSet,
  get: CalendarGet,
): Pick<CalendarState, "applyChanges"> {
  return {
    applyChanges(types, accountId) {
      /*
       * A change to a shared account (a colleague's share, a group mailbox) is
       * not aimed at the reader's own account, so the own-account caches do not
       * cover it. The shared caches do: the calendars of that account and the
       * windows of its events already on screen.
       */
      const own = get().accountId;
      if (accountId && accountId !== own) {
        /* An account with nothing listed here has either never been read or lost
         its read. Either way the answer is to read it now: ignoring what
         arrives from it is what keeps a group's calendars out of the app for a
         whole session, since nothing else asks again. */
        if (!get().sharedCalendars.some((c) => c.accountId === accountId)) {
          void get().loadSharedCalendars();
          return;
        }
        if (types.has("Calendar")) void get().loadSharedCalendars();
        /* Through the same coalescing the reader's own windows go through: the
         events of a shared account arrive one per change too. */
        if (types.has("CalendarEvent")) get().refreshWindows(true);
        return;
      }
      if (types.has("Calendar")) void get().loadCalendars();
      if (types.has("CalendarEvent")) get().refreshWindows();
    },
  };
}
