import { isSharedAccountRecord } from "@gilbert/shared/sessionAccount";
import { create } from "zustand";
import { CAP } from "@/jmap/client";
import type { Id } from "@/jmap/types";
import { useSession } from "../session";
import { accountOfCalendar, stopReminderTimer } from "./shared";
import { availabilitySlice } from "./slices/availability";
import { calendarsSlice } from "./slices/calendars";
import { eventsSlice } from "./slices/events";
import { icsSlice } from "./slices/ics";
import { pushSlice } from "./slices/push";
import { sharingSlice } from "./slices/sharing";
import { windowsSlice } from "./slices/windows";
import type { CalendarState } from "./types";

/*
 * Declared once, in `@/lib/sharedKey`: its format is what the reader's own
 * `settings.addedShares` stores, so a second spelling here would be a selection
 * that stops being found. Re-exported because this store's callers key shared
 * calendars by it.
 */
export { sharedKey } from "@/lib/sharedKey";
export { CALENDAR_PROPS } from "./shared";
export {
  CalendarSetError,
  eventIdForScope,
  eventRule,
  isAttendee,
  isOccurrence,
  isRecurring,
  isThisAndFutureRefusal,
  keepRecent,
  makeParticipant,
  myParticipantKeys,
  OccurrenceScopeError,
  occurrencePatch,
  participantAddresses,
  participantEmail,
  RANGES_KEPT,
  subscriptionCalendarId,
  toInstance,
} from "./slices/events";
export type { CalendarState, EventDraft, EventInstance, EventScope } from "./types";

export const useCalendar = create<CalendarState>((set, get) => ({
  accountId: null,
  available: false,
  calendars: {},
  sharedCalendars: [],
  sharedEvents: {},
  sharedRanges: {},
  events: {},
  ranges: {},
  loading: false,
  error: null,
  sharedError: null,
  identities: [],
  hidden: {},
  subscriptionEvents: {},
  subscriptionErrors: {},
  subscriptionsLoading: false,
  draft: null,

  ...eventsSlice(set, get),
  ...windowsSlice(set, get),
  ...calendarsSlice(set, get),
  ...sharingSlice(set, get),
  ...icsSlice(set, get),
  ...availabilitySlice(set, get),
  ...pushSlice(set, get),
}));

/**
 * The account that holds a calendar id, from what the store has loaded.
 *
 * Shared and group calendars are not the reader's own, and an id means nothing
 * outside the account that holds it — the editor asks for an event's master
 * with this rather than with the reader's own account.
 */
export function accountOfCalendarId(calendarId: string | null | undefined): Id | null {
  const s = useCalendar.getState();
  return accountOfCalendar(calendarId, s.calendars, s.accountId, s.sharedCalendars);
}

/*
 * Calendars from other accounts (a colleague's share, a group mailbox) are
 * fetched when the calendar store starts. A session refresh can add such an
 * account later — the mail pane discovers a group mailbox after the calendar
 * has already asked — so the fetch is repeated whenever the set of
 * non-personal accounts changes, not only at startup.
 */
let lastSharedAccounts = "";
function sharedAccountsSignature(
  s: { accounts?: Record<string, { isPersonal?: boolean }> } | null,
): string {
  const own = useSession.getState().ownAccountFor(CAP.calendars);
  return Object.keys(s?.accounts ?? {})
    .filter((id) => isSharedAccountRecord(s?.accounts?.[id]) && id !== own)
    .sort()
    .join("|");
}
useSession.subscribe((s, prev) => {
  if (s.status !== "authenticated") {
    lastSharedAccounts = "";
    stopReminderTimer();
    // A sign-out must not leave the previous reader's shared content behind:
    // the calendar store outlives the session, and on a shared machine the
    // next reader would briefly see it.
    useCalendar.setState({
      accountId: null,
      calendars: {},
      events: {},
      ranges: {},
      sharedCalendars: [],
      sharedEvents: {},
      sharedRanges: {},
      sharedError: null,
      identities: [],
    });
    return;
  }
  const sig = sharedAccountsSignature(s.session);
  if (prev.status === "authenticated") {
    if (sig !== lastSharedAccounts) {
      // Changed -- shrunk to nothing included. A revoke that empties the set
      // must still clear what was on screen; an empty `Calendar/get` round
      // over zero accounts is exactly that clearing.
      lastSharedAccounts = sig;
      void useCalendar.getState().loadSharedCalendars();
    }
  } else {
    // The store's init (driven by the app on sign-in) does the first fetch.
    lastSharedAccounts = sig;
  }
});
