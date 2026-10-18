import type { StoreApi } from "zustand";
import type {
  BusyPeriod,
  Calendar,
  CalendarEvent,
  EmailAddress,
  Id,
  ParticipantIdentity,
} from "@/jmap/types";
import type { IcsEvent } from "@/lib/ics";

export interface EventInstance {
  /** Unique key for rendering: `${id}` (synthetic ids already unique per instance). */
  key: string;
  /** The account that holds this event — ids mean nothing outside it. */
  accountId: Id;
  event: CalendarEvent;
  start: Date;
  end: Date;
  allDay: boolean;
  calendar: Calendar | undefined;
}

/** A calendar somebody else shared, and the account it lives in. */
export interface SharedCalendar {
  accountId: Id;
  accountName: string;
  calendar: Calendar;
}

/**
 * An event begun outside the calendar -- from a message, so far.
 *
 * The editor lives inside CalendarView and the reader is somewhere else when
 * they ask for this, so the draft waits here until that view mounts and takes
 * it. It is taken exactly once: a draft left behind would reopen the editor
 * every time the reader came back to the calendar.
 */
export interface EventDraft {
  title: string;
  description: string;
  start: Date;
  end: Date;
  allDay: boolean;
  attendees: EmailAddress[];
}

/**
 * Which of an event's two ids a mutation means.
 *
 * `CalendarEvent/query` runs with `expandRecurrences`, so an occurrence arrives
 * carrying a synthetic `id` of its own *and* a `baseEventId` pointing at the
 * master it was expanded from. Sending one where the other was meant is not a
 * distinction the server will make for us:
 *
 * - 0.16.19 refuses a synthetic id outright — *"Updating synthetic ids is not
 *   yet supported"*.
 * - 0.16.20 accepts it, and writes a `recurrenceOverrides` entry instead: a
 *   destroy that means the series removes one date and reports success, under
 *   a dialog that said "Delete all occurrences?".
 *
 * So the choice is named and required rather than left to each caller to
 * remember a `??`. There is exactly one place that turns an event into an id,
 * and it is `eventIdForScope`.
 */
export type EventScope = "series" | "occurrence";

export interface CalendarState {
  accountId: Id | null;
  available: boolean;
  calendars: Record<Id, Calendar>;
  /** Calendars shared with the reader, from every non-personal account. */
  sharedCalendars: SharedCalendar[];
  /** Their events, keyed by account and id. See `sharedKey`. */
  sharedEvents: Record<string, CalendarEvent>;
  /** Which shared keys each loaded window holds, alongside `ranges`. */
  sharedRanges: Record<string, string[]>;
  events: Record<Id, CalendarEvent>;
  /** Loaded ranges keyed "start|end" → event ids */
  ranges: Record<string, Id[]>;
  loading: boolean;
  error: string | null;
  /**
   * Which shared accounts a window read could not reach.
   *
   * Its own field rather than a second writer of `error`: that one belongs to
   * the reader's own calendars and range, and a shared window that read cleanly
   * must not clear a failure the reader was just shown — nor must a failed one
   * hide it.
   */
  sharedError: string | null;
  identities: ParticipantIdentity[];
  hidden: Record<Id, true>;
  /** Events from each subscribed calendar, by subscription id. Never persisted. */
  subscriptionEvents: Record<string, IcsEvent[]>;
  /** Why a subscription last failed, if it did. */
  subscriptionErrors: Record<string, string>;
  subscriptionsLoading: boolean;
  /** Waiting to be opened in the editor; see `EventDraft`. */
  draft: EventDraft | null;

  init(): Promise<void>;
  loadCalendars(): Promise<void>;
  /** Calendars from accounts that shared with the reader, and their events. */
  loadSharedCalendars(): Promise<void>;
  loadSharedRange(start: Date, end: Date): Promise<void>;
  /** Add a shared calendar to, or remove it from, the reader's own view. */
  /**
   * Arm or disarm a shared calendar, and say whether the server took it.
   *
   * `false` means the write was refused and the choice was recorded for this
   * reader alone (`addedShares`), which the surface has to say: the calendar is
   * not subscribed on the server, it is remembered here.
   */
  setSharedSubscribed(
    accountId: Id,
    calendarId: Id,
    subscribed: boolean,
  ): Promise<boolean>;
  loadRange(start: Date, end: Date, force?: boolean): Promise<void>;
  instancesIn(start: Date, end: Date): EventInstance[];
  /** Re-fetch every subscribed calendar. */
  refreshSubscriptions(): Promise<void>;
  /**
   * `accountId` defaults to the reader's own. Pass it when the event lives in
   * a shared or group account: an id means nothing outside the account that
   * holds it.
   */
  getEvent(id: Id, accountId?: Id | null): Promise<CalendarEvent | null>;
  /**
   * `accountId` names the account that owns the target calendar. A calendar id
   * means nothing outside its account — the reader's own and a shared or group
   * account can both hold a calendar with the same id, and the caller that
   * picked one of them is the only thing that knows which.
   */
  createEvent(
    event: Partial<CalendarEvent>,
    calendarId: Id,
    sendInvites: boolean,
    accountId?: Id | null,
  ): Promise<Id>;
  /**
   * Returns the properties that had to be left to the series, if any.
   *
   * `opts.accountId` names the account that holds `event` (a bare id is
   * ambiguous when two accounts hold same-id events); `opts.moveTo` names the
   * calendar the patch is moving it to, account included.
   */
  updateEvent(
    event: CalendarEvent,
    patch: Record<string, unknown>,
    sendInvites: boolean,
    scope: EventScope,
    opts?: { accountId?: Id | null; moveTo?: { accountId: Id; calendarId: Id } },
  ): Promise<string[]>;
  destroyEvent(
    event: CalendarEvent,
    sendInvites: boolean,
    scope: EventScope,
    accountId?: Id | null,
  ): Promise<void>;
  rsvp(
    event: CalendarEvent,
    status: "accepted" | "tentative" | "declined",
    comment?: string,
    accountId?: Id | null,
  ): Promise<void>;
  /** Create a calendar; pass `accountId` to create it in a group account, owned by the group. */
  createCalendar(data: Partial<Calendar>, accountId?: Id): Promise<Id>;
  updateCalendar(id: Id, patch: Partial<Calendar>): Promise<void>;
  /** Rename/colour a calendar that lives in a shared account (a group
   *  mailbox): the write goes to that account, not the reader's own. */
  updateSharedCalendar(accountId: Id, id: Id, patch: Partial<Calendar>): Promise<void>;
  destroyCalendar(id: Id): Promise<void>;
  toggleHidden(id: Id): void;
  availability(principalId: Id, start: Date, end: Date): Promise<BusyPeriod[]>;
  findByUid(uid: string): Promise<CalendarEvent | null>;
  parseIcs(blobId: Id): Promise<CalendarEvent[]>;
  importEvent(event: Partial<CalendarEvent>, calendarId: Id): Promise<Id>;
  /** Import a whole .ics file. Says how many it created and how many it updated. */
  importIcs(text: string, calendarId: Id): Promise<{ created: number; updated: number }>;
  /** The whole calendar as one .ics document, and how many events went into it. */
  exportIcs(calendarId: Id): Promise<{ text: string; count: number }>;
  applyChanges(types: Set<string>, accountId?: Id): void;
  refreshWindows(shared?: boolean): void;
  setDraft(draft: EventDraft | null): void;
}

/**
 * What `create` hands a slice: the store's own reader and writer.
 *
 * The store is assembled in `index.ts` from one function per job, and a slice
 * never imports the store it belongs to -- it is handed these two, which is what
 * keeps the modules acyclic and each one readable on its own.
 */
export type CalendarSet = StoreApi<CalendarState>["setState"];
export type CalendarGet = StoreApi<CalendarState>["getState"];
