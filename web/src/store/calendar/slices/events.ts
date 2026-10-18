import {
  OCCURRENCE_INHERITED,
  OCCURRENCE_REJECTED,
} from "@gilbert/shared/calendarOccurrence";
import { ref } from "@gilbert/shared/jmapQuery";
import { client, setErrorMessage } from "@/jmap/client";
import type {
  Calendar,
  CalendarEvent,
  GetResponse,
  Id,
  JSCalendarParticipant,
  JSCalendarRecurrenceRule,
  ParticipantIdentity,
  SetResponse,
} from "@/jmap/types";
import {
  BIRTHDAY_CALENDAR_ID,
  type Birthday,
  birthdaysInRange,
  isBirthdayEvent,
} from "@/lib/birthdays";
import {
  addDays,
  DAY_MS,
  formatDuration,
  parseDuration,
  toLocalDateTime,
  zonedToDate,
} from "@/lib/dates";
import { shiftStoredStart } from "@/lib/eventDrag";
import { t } from "@/lib/i18n";
import type { IcsEvent } from "@/lib/ics";
import { accountOfSharedKey, sharedKey } from "@/lib/sharedKey";
import { useContacts } from "../../contacts";
import { useSession } from "../../session";
import { settings } from "../../settings";
import { accountOfCalendar, EVENT_PROPS, groupAccountIds } from "../shared";
import type {
  CalendarGet,
  CalendarSet,
  CalendarState,
  EventInstance,
  EventScope,
} from "../types";

/**
 * The id to send for `scope`.
 *
 * `series` walks up to the master; `occurrence` sends the instance as it came.
 * A one-off is safe either way — it has a synthetic id like everything an
 * expanded query returns, and Stalwart resolves a synthetic id on a component
 * that is neither recurrent nor an override back to the base event itself.
 */
export function eventIdForScope(event: CalendarEvent, scope: EventScope): Id {
  return scope === "series" ? (event.baseEventId ?? event.id) : event.id;
}

/** Whether this object is an expanded occurrence rather than a master. */
export function isOccurrence(event: CalendarEvent): boolean {
  return event.baseEventId != null && event.baseEventId !== event.id;
}

/**
 * What `CalendarEvent/set` will not take on a single occurrence, and why the
 * client has to know rather than letting the server sort it out.
 *
 * 0.16.20's per-occurrence validator sorts properties into three groups, and
 * only one of them is honest about itself:
 *
 * - **Rejected** — `invalidProperties`, *"This property cannot be modified on a
 *   single occurrence."* Loud, and fine.
 * - **Inherited** — dropped from the patch, and the response still says the
 *   update succeeded. Nothing anywhere reports it.
 * - Everything else, which is applied to the override.
 *
 * The middle group is the whole problem. It is the same failure as upstream
 * issue #26, where a participant map addressed the RFC 8984 way is discarded
 * without an error and the client shows the guests as saved: a successful
 * response is not evidence that anything was written. So a per-occurrence patch
 * is checked here before it is sent — rejected properties throw, inherited ones
 * are reported to the caller — rather than being posted hopefully and believed.
 *
 * Which properties are in which group is `@gilbert/shared/calendarOccurrence`:
 * the mock splits a patch by the same two lists, so a client that stopped asking
 * them meets the refusal there instead of on a live instance.
 */

/**
 * A `notUpdated`/`notDestroyed` entry, kept whole rather than flattened.
 *
 * Some refusals are worth acting on rather than only showing: 0.16.20 will not
 * edit an occurrence that belongs to a this-and-future change, and the useful
 * response to that is to offer the series, which needs the reason and not just
 * its text.
 */
export class CalendarSetError extends Error {
  constructor(
    readonly setError: { type: string; description?: string; properties?: string[] },
  ) {
    super(setErrorMessage(setError));
    this.name = "CalendarSetError";
  }
}

/** Whether a refusal was "this occurrence belongs to a this-and-future change". */
export function isThisAndFutureRefusal(err: unknown): boolean {
  return (
    err instanceof CalendarSetError &&
    /this-and-future/i.test(err.setError.description ?? "")
  );
}

/**
 * A synthetic id is only true until the next write, so an occurrence is
 * re-resolved from its `recurrenceId` immediately before it is touched.
 *
 * **Confirmed live on 0.16.20 (2026-08-31.)** Stalwart's synthetic ids encode a
 * position in the expanded series, and writing a `recurrenceOverrides` entry
 * adds a component that renumbers it. A five-week series held ids `e i m q u`
 * over 03-01…03-29; after one override was written to 03-08 the *same ids*
 * addressed 03-01, 03-15, 03-29, 03-08, 03-22. Not one of them was rejected —
 * `i` simply meant a week later than it had a moment before.
 *
 * So an id cached across a write silently points at a different date, and a
 * delete aimed at one occurrence removes another. `recurrenceId` is the stable
 * name for a slot in a series — it is the date itself — so that is what we hold
 * and what we look the current id up by.
 */
async function currentOccurrenceId(accountId: Id, event: CalendarEvent): Promise<Id> {
  const base = event.baseEventId;
  const rid = event.recurrenceId;
  // A one-off, or an object with nothing to re-resolve from: its own id is all
  // there is, and there is no series for a write to have renumbered.
  if (!base || !rid) return event.id;

  const around = new Date(rid);
  if (Number.isNaN(around.getTime())) return event.id;
  const from = new Date(around.getTime() - DAY_MS);
  const to = new Date(around.getTime() + DAY_MS);

  const res = await client.chain([
    [
      "CalendarEvent/query",
      {
        accountId,
        filter: { after: toLocalDateTime(from), before: toLocalDateTime(to) },
        expandRecurrences: true,
        limit: 200,
      },
      "q",
    ],
    [
      "CalendarEvent/get",
      {
        accountId,
        "#ids": ref("q", "CalendarEvent/query", "/ids"),
        properties: ["id", "baseEventId", "recurrenceId"],
      },
      "g",
    ],
  ]);
  const list =
    (res.get("g")?.[0] as unknown as GetResponse<CalendarEvent> | undefined)?.list ?? [];
  const found = list.find((e) => e.baseEventId === base && e.recurrenceId === rid);
  if (!found) {
    // The date is gone -- already excluded, or the series no longer reaches it.
    // Better to say so than to act on an id that means something else now.
    throw new Error(
      "That occurrence is no longer part of this series. Reload the calendar and try again.",
    );
  }
  return found.id;
}

export class OccurrenceScopeError extends Error {
  constructor(readonly property: string) {
    super(
      `"${property}" applies to the whole series and cannot be changed for one occurrence.`,
    );
    this.name = "OccurrenceScopeError";
  }
}

/**
 * A patch narrowed to what one occurrence will actually accept.
 *
 * Throws `OccurrenceScopeError` on a property the server would refuse, and
 * returns the inherited ones it removed so a caller can say what it could not
 * do for this date alone instead of claiming it did.
 *
 * Patch *pointers* are judged on their first token, the way the server does:
 * `participants/{key}/participationStatus` is allowed, and
 * `participants/{key}/calendarAddress` is one of the silent drops.
 */
export function occurrencePatch(patch: Record<string, unknown>): {
  patch: Record<string, unknown>;
  dropped: string[];
} {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const [head, , third] = key.split("/");
    const root = head ?? key;
    if (OCCURRENCE_REJECTED.has(root)) throw new OccurrenceScopeError(root);
    if (OCCURRENCE_INHERITED.has(root)) {
      dropped.push(root);
      continue;
    }
    if (root === "participants" && third === "calendarAddress") {
      dropped.push(key);
      continue;
    }
    // `id` is immutable; the server errors on a value that is not the event's
    // own, and ignores one that is. Neither is worth sending.
    if (root === "id") {
      dropped.push(root);
      continue;
    }
    out[key] = value;
  }
  return { patch: out, dropped };
}

/**
 * How many loaded windows are held.
 *
 * Every week or month the reader visited used to stay, and each was queried
 * again whenever any event changed, and walked by every render. A window
 * dropped here is simply loaded again if the reader goes back to it.
 */
export const RANGES_KEPT = 4;

/** `ranges` with `key` set and moved to the end, trimmed to the most recent `RANGES_KEPT`. */
export function keepRecent(
  ranges: Record<string, Id[]>,
  key: string,
  ids: Id[],
): Record<string, Id[]> {
  const { [key]: _previous, ...rest } = ranges;
  const entries = [...Object.entries(rest), [key, ids] as [string, Id[]]];
  return Object.fromEntries(entries.slice(-RANGES_KEPT));
}

/* Shift an event's cached times by `deltaMs` for the optimistic copy of a
   move: the zoned `start`, and — when present — the utc pair that toInstance
   reads first. */
function shiftEvent(e: CalendarEvent, deltaMs: number): CalendarEvent {
  const next = { ...e };
  if (typeof e.start === "string") {
    const s = shiftStoredStart(e.start, deltaMs);
    if (s) next.start = s;
  }
  if (e.utcStart && e.utcEnd) {
    const us = new Date(e.utcStart).getTime();
    const ue = new Date(e.utcEnd).getTime();
    if (!Number.isNaN(us)) next.utcStart = new Date(us + deltaMs).toISOString();
    if (!Number.isNaN(ue)) next.utcEnd = new Date(ue + deltaMs).toISOString();
  }
  return next;
}

/**
 * Event-shape helpers: what an event is, how a series is named, and the shapes
 * the views read. They are exported from the store because more than one view
 * asks the same question.
 */

/**
 * Whether an event is part of a series.
 *
 * Three facts about a live 0.16.19 decide this, and the mock reproduces none of
 * them:
 *
 * - `baseEventId` says nothing. `CalendarEvent/query` runs with
 *   `expandRecurrences`, and a one-off comes back as id `eaaaaai` over base
 *   `i` — an instance id of its own, and a base that is a different id.
 * - The rules say nothing on an instance. An occurrence of a weekly series
 *   arrives with no rule attached at all; only the master carries one.
 * - Stalwart names that rule `recurrenceRule`, singular, not the RFC 8984
 *   `recurrenceRules` array.
 *
 * What an occurrence does carry is a `recurrenceId`, and a one-off never has
 * one. Master or occurrence, that is what makes this a series.
 */
export function isRecurring(ev: CalendarEvent): boolean {
  return Boolean(
    ev.recurrenceRule ||
      ev.recurrenceRules?.length ||
      ev.excludedRecurrenceRules?.length ||
      ev.recurrenceId,
  );
}

/**
 * The virtual calendar the birthdays hang off. Not a JMAP calendar and
 * deliberately not shaped like one: it has no account, cannot be shared, and
 * every write path checks the id before it does anything.
 */
/**
 * The rights of a calendar Gilbert only reads — a birthday feed, a
 * subscription. Both synthetic calendars are read-only, and one object is what
 * says so: an edit affordance reads these fields, so a copy that drifted would
 * offer an edit the calendar cannot take.
 */
const READ_ONLY_RIGHTS = {
  mayReadItems: true,
  mayWriteAll: false,
  mayWriteOwn: false,
  mayUpdatePrivate: false,
  mayRSVP: false,
  mayAdmin: false,
  mayDelete: false,
};

function birthdayCalendar(): Calendar {
  return {
    id: BIRTHDAY_CALENDAR_ID,
    name: t("Birthdays"),
    color: "#e0a33e",
    isSubscribed: true,
    isVisible: true,
    myRights: READ_ONLY_RIGHTS,
  } as unknown as Calendar;
}

/** A CalendarEvent shaped enough for the views, and for nothing else. */
function synthesiseBirthdayEvent(b: Birthday): CalendarEvent {
  const local = toLocalDateTime(b.date);
  return {
    id: b.id,
    calendarIds: { [BIRTHDAY_CALENDAR_ID]: true },
    title:
      b.age === null
        ? t("{name}\u2019s birthday", { name: b.name })
        : t("{name}\u2019s birthday ({age})", { name: b.name, age: String(b.age) }),
    start: local,
    duration: "P1D",
    showWithoutTime: true,
    freeBusyStatus: "free",
  } as unknown as CalendarEvent;
}

/** The virtual calendar id for a subscription; never a JMAP id. */
export function subscriptionCalendarId(subId: string): string {
  return `gilbert-ics:${subId}`;
}

function isSubscriptionEvent(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith("gilbert-ics:"));
}

function subscriptionCalendar(sub: {
  id: string;
  name: string;
  color: string;
}): Calendar {
  return {
    id: subscriptionCalendarId(sub.id),
    name: sub.name,
    color: sub.color,
    isSubscribed: true,
    isVisible: true,
    // Read-only, and honestly so: everything that asks before offering an edit
    // reads these rights, so nothing has to know a subscription is special.
    myRights: READ_ONLY_RIGHTS,
  } as unknown as Calendar;
}

function synthesiseSubscriptionEvent(subId: string, e: IcsEvent): CalendarEvent {
  // The feed's instants carry seconds; a subscribed event is placed to the
  // minute, which is the precision the grid has for it.
  const minute = new Date(e.start.getTime());
  minute.setSeconds(0, 0);
  const local = toLocalDateTime(minute);
  // The feed says when the event ends, and a subscribed event drawn without it
  // is an event of no length: the grid can only place what it is told.
  const seconds = Math.max(0, Math.round((e.end.getTime() - e.start.getTime()) / 1000));
  return {
    id: `${subscriptionCalendarId(subId)}:${e.uid}`,
    calendarIds: { [subscriptionCalendarId(subId)]: true },
    title: e.summary,
    start: local,
    duration: seconds > 0 ? formatDuration(seconds) : "P0D",
    showWithoutTime: e.allDay,
    location: e.location,
    description: e.description,
    freeBusyStatus: "free",
  } as unknown as CalendarEvent;
}

/**
 * Add a shared calendar to the reader's view unless it is there already.
 *
 * A write aimed at a shared calendar the reader has not added would land
 * where they cannot see it — the calendar is drawn only once subscribed or
 * held in `addedShares`. The write itself (a create or a move) is the
 * deliberate act, so the calendar is added here rather than left invisible.
 */
async function ensureCalendarVisible(
  get: CalendarGet,
  accountId: Id,
  calendarId: Id,
): Promise<void> {
  const cal = get();
  const known = cal.sharedCalendars.find(
    (c) => c.accountId === accountId && c.calendar.id === calendarId,
  );
  const added = new Set(settings().addedShares);
  if (!known?.calendar.isSubscribed && !added.has(sharedKey(accountId, calendarId)))
    await cal.setSharedSubscribed(accountId, calendarId, true);
}

/** The event, as the account that holds it stores it. */
async function readEvent(accountId: Id, id: Id): Promise<CalendarEvent | null> {
  const res = await client.call<GetResponse<CalendarEvent>>("CalendarEvent/get", {
    accountId,
    ids: [id],
    properties: EVENT_PROPS,
  });
  return res.list[0] ?? null;
}

/**
 * Fields that say where an event sits in an account, not what the event is.
 *
 * Everything else — the uid, the rule and its overrides, the participants,
 * the alerts — rides along untouched when an event is re-filed under another
 * account.
 */
const MOVE_STRIP = new Set([
  "id",
  "baseEventId",
  "calendarIds",
  "recurrenceId",
  "recurrenceIdTimeZone",
  "utcStart",
  "utcEnd",
  "isOrigin",
  "created",
  "updated",
]);

/** The same event, aimed at another account's calendar. */
function moveCopy(stored: CalendarEvent, targetCalendarId: Id): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (!MOVE_STRIP.has(k)) copy[k] = v;
  copy.calendarIds = { [targetCalendarId]: true };
  return copy;
}

export function toInstance(
  e: CalendarEvent,
  calendars: Record<Id, Calendar>,
  accountId: Id,
): EventInstance | null {
  const allDay = Boolean(e.showWithoutTime);
  let start: Date;
  let end: Date;
  if (e.utcStart && e.utcEnd && !allDay) {
    start = new Date(e.utcStart);
    end = new Date(e.utcEnd);
  } else {
    const tz = allDay ? null : e.timeZone;
    start = zonedToDate(e.start, tz);
    const dur = parseDuration(e.duration);
    /*
     * An all-day event ends at the start of a later day, and a day is not
     * 86 400 000 milliseconds: on the day a clock changes the span between the
     * same two midnights differs by an hour, so a stored span is read as whole
     * days here and placed by `addDays`. A timed event keeps its span exactly.
     */
    end = allDay
      ? addDays(start, Math.max(1, Math.round((dur ?? 0) / 86400)))
      : new Date(start.getTime() + (dur ?? 0) * 1000);
  }
  if (Number.isNaN(start.getTime())) return null;
  if (end <= start)
    end = allDay ? addDays(start, 1) : new Date(start.getTime() + 30 * 60_000);
  const calId = Object.keys(e.calendarIds ?? {})[0];
  return {
    key: e.id,
    accountId,
    event: e,
    start,
    end,
    allDay,
    calendar: calId ? calendars[calId] : undefined,
  };
}

/**
 * Every address a participant answers to, as lowercase `mailto:` URIs.
 *
 * Stalwart 0.16 keeps one address under `calendarAddress`; RFC 8984 spreads it
 * over `sendTo` and `email`. Reading has to accept all three — a mailbox may
 * hold events written by either, and by other clients besides.
 */
export function participantAddresses(p: JSCalendarParticipant): string[] {
  return [
    p.calendarAddress ?? "",
    ...Object.values(p.sendTo ?? {}),
    p.email ? `mailto:${p.email}` : "",
  ]
    .filter(Boolean)
    .map((a) => a.toLowerCase());
}

/** The address to show or write to, without the `mailto:`. */
export function participantEmail(p: JSCalendarParticipant): string {
  return (participantAddresses(p)[0] ?? "").replace(/^mailto:/i, "");
}

/** Whether this participant is attending, under any of the role names in use. */
export function isAttendee(p: JSCalendarParticipant): boolean {
  return Boolean(
    p.roles?.attendee || p.roles?.required || p.roles?.optional || p.roles?.chair,
  );
}

/** The event's recurrence rule, under either spelling. */
export function eventRule(ev: CalendarEvent): JSCalendarRecurrenceRule | undefined {
  return ev.recurrenceRule ?? ev.recurrenceRules?.[0];
}

/**
 * Builds a participant the way Stalwart 0.16 stores them: the address under
 * `calendarAddress`. Sent under RFC 8984's `sendTo`/`email` instead, the server
 * keeps the event and drops the whole participant map without saying so — which
 * is why an invitation sent that way vanishes (#26).
 */
export function makeParticipant(
  email: string,
  name: string | null | undefined,
  role: "owner" | "attendee",
  status?: string,
): JSCalendarParticipant {
  return {
    "@type": "Participant",
    name: name || undefined,
    calendarAddress: `mailto:${email}`,
    kind: "individual",
    roles:
      role === "owner"
        ? { owner: true, attendee: true }
        : { attendee: true, required: true },
    participationStatus:
      (status as JSCalendarParticipant["participationStatus"]) ??
      (role === "owner" ? "accepted" : "needs-action"),
    expectReply: role !== "owner",
  };
}

export function myParticipantKeys(
  ev: CalendarEvent,
  identities: ParticipantIdentity[],
): string[] {
  const mine = new Set<string>();
  for (const i of identities) {
    mine.add(i.calendarAddress.toLowerCase());
    for (const v of Object.values(i.sendTo ?? {})) mine.add(v.toLowerCase());
  }
  const session = useSession.getState().session;
  if (session?.username?.includes("@"))
    mine.add(`mailto:${session.username.toLowerCase()}`);
  const keys: string[] = [];
  for (const [k, p] of Object.entries(ev.participants ?? {})) {
    if (participantAddresses(p).some((a) => mine.has(a))) keys.push(k);
  }
  return keys;
}

/**
 * Events: the reader's own calendar, its windows, and the writes that change
 * what is in them.
 *
 * A slice of the calendar store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function eventsSlice(
  set: CalendarSet,
  get: CalendarGet,
): Pick<
  CalendarState,
  | "instancesIn"
  | "getEvent"
  | "createEvent"
  | "updateEvent"
  | "destroyEvent"
  | "rsvp"
  | "findByUid"
  | "setDraft"
> {
  return {
    instancesIn(start, end) {
      const {
        events,
        ranges,
        calendars,
        hidden,
        sharedEvents,
        sharedRanges,
        sharedCalendars,
      } = get();
      /*
       * Built once per call, not once per event. `instancesIn` runs on every
       * render of the calendar, and the set it used to build sits inside the
       * loop over every event in range -- a new Set per event, per render, over
       * a list of settings that has not changed.
       */
      const addedShares = new Set(settings().addedShares);
      /*
       * Birthdays are derived here rather than fetched, and they go through the
       * same funnel as everything else so no view has to know they are different.
       * Nothing is stored: the dates live on the contact cards, and a second copy
       * of the same fact would drift the first time somebody corrected one.
       */
      const birthdays: EventInstance[] = [];
      const ownAccount = get().accountId ?? "";
      if (settings().birthdayCalendar && !hidden[BIRTHDAY_CALENDAR_ID]) {
        const cal = birthdayCalendar();
        for (const b of birthdaysInRange(
          Object.values(useContacts.getState().cards),
          start,
          end,
        )) {
          birthdays.push({
            key: b.id,
            accountId: ownAccount,
            event: synthesiseBirthdayEvent(b),
            start: b.date,
            end: new Date(b.date.getTime() + DAY_MS),
            allDay: true,
            calendar: cal,
          });
        }
      }
      /*
       * Subscribed calendars, from whatever the last refresh fetched. Same funnel
       * as the birthdays and for the same reason: no view has to know they are
       * not real calendars, and nothing about them is stored.
       */
      for (const sub of settings().icalSubscriptions) {
        const calId = subscriptionCalendarId(sub.id);
        if (hidden[calId]) continue;
        const cal = subscriptionCalendar(sub);
        for (const e of get().subscriptionEvents[sub.id] ?? []) {
          if (e.end <= start || e.start >= end) continue;
          birthdays.push({
            key: `${calId}:${e.uid}:${e.start.getTime()}`,
            accountId: ownAccount,
            event: synthesiseSubscriptionEvent(sub.id, e),
            start: e.start,
            end: e.end,
            allDay: e.allDay,
            calendar: cal,
          });
        }
      }
      const ids = new Set<Id>();
      for (const list of Object.values(ranges)) for (const id of list) ids.add(id);
      const out: EventInstance[] = [];
      for (const id of ids) {
        const e = events[id];
        if (!e) continue;
        /*
         * An event may sit in more than one calendar, and hiding one of them must
         * not take the event down while another it is in stays visible -- so it is
         * hidden only when every calendar it names is.
         */
        const calIds = Object.keys(e.calendarIds ?? {});
        if (calIds.length && calIds.every((cal) => hidden[cal])) continue;
        const inst = toInstance(e, calendars, ownAccount);
        if (!inst) continue;
        if (inst.end > start && inst.start < end) out.push(inst);
      }
      /* Shared events go through the same funnel, so every view gets them
       without knowing they exist. Their calendars are looked up per account:
       a shared calendar id means nothing outside the account holding it, and
       hiding one is remembered under the same account-qualified key. */
      const groupIds = groupAccountIds();
      const sharedKeys = new Set<string>();
      for (const list of Object.values(sharedRanges))
        for (const k of list) sharedKeys.add(k);
      for (const k of sharedKeys) {
        const e = sharedEvents[k];
        if (!e) continue;
        const accountId = accountOfSharedKey(k, e.id);
        const calIds = Object.keys(e.calendarIds ?? {});
        if (calIds.length && calIds.every((cal) => hidden[sharedKey(accountId, cal)]))
          continue;
        /* Stalwart hands back every calendar in an account the reader can reach,
         with full rights on each, whether or not anybody meant to share it --
         an account linked for its files offered its calendar too. `isSubscribed`
         is the only thing separating "shared with me" from "reachable", so
         nothing unsubscribed is drawn -- except a group's, where membership is
         the subscription: it is drawn whether or not `isSubscribed` survived,
         the same rule a group's books follow (contacts' `wanted`). */
        const theirs: Record<Id, Calendar> = {};
        for (const c of sharedCalendars) {
          if (c.accountId !== accountId) continue;
          if (
            !c.calendar.isSubscribed &&
            !addedShares.has(sharedKey(c.accountId, c.calendar.id)) &&
            !groupIds.has(c.accountId)
          )
            continue;
          theirs[c.calendar.id] = c.calendar;
        }
        if (calIds.length && !calIds.some((cal) => theirs[cal])) continue;
        const inst = toInstance(e, theirs, accountId);
        if (!inst) continue;
        // Ids are unique only within an account, so a key that is the bare id
        // would collide when the reader's own account and a shared one (own
        // events and the group's) both hold an event with the same id on the
        // same day -- duplicate React keys, and a drag that grabs both.
        inst.key = sharedKey(accountId, e.id);
        if (inst.end > start && inst.start < end) out.push(inst);
      }
      out.push(...birthdays);
      out.sort(
        (a, b) =>
          a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime(),
      );
      return out;
    },

    async getEvent(id, accountId) {
      const own = get().accountId;
      const acc = accountId ?? own;
      if (!acc) return null;
      const res = await client.call<GetResponse<CalendarEvent>>("CalendarEvent/get", {
        accountId: acc,
        ids: [id],
        properties: EVENT_PROPS,
      });
      const e = res.list[0];
      /* Cached under the own-account map only when it is an own event: an id is
       unique within an account, so a shared master fetched here must not
       overwrite a same-id event of the reader's own. */
      if (e && acc === own) set((s) => ({ events: { ...s.events, [e.id]: e } }));
      return e ?? null;
    },

    async createEvent(event, calendarId, sendInvites, accountId) {
      /*
       * `accountId` names the account that owns the target calendar — required
       * when the same calendar id exists in more than one account. Without it,
       * the account is guessed from the calendars the store has loaded.
       */
      const acc =
        accountId ??
        accountOfCalendar(
          calendarId,
          get().calendars,
          get().accountId,
          get().sharedCalendars,
        );
      if (!acc) throw new Error("Calendar is not available");
      /*
       * A shared calendar the reader may write to but has not added is still a
       * fine place for an event; the event simply would not be drawn back until
       * the calendar was added. This create is the deliberate act, so the
       * calendar is added here rather than left invisible.
       */
      if (acc !== get().accountId) await ensureCalendarVisible(get, acc, calendarId);
      const obj = {
        "@type": "Event",
        uid: crypto.randomUUID(),
        ...event,
        calendarIds: { [calendarId]: true },
      };
      const res = await client.call<SetResponse<CalendarEvent>>("CalendarEvent/set", {
        accountId: acc,
        create: { e: obj },
        sendSchedulingMessages: sendInvites,
      });
      const err = res.notCreated?.e;
      if (err) throw new Error(setErrorMessage(err));
      get().refreshWindows();
      return res.created!.e!.id;
    },

    async updateEvent(event, patch, sendInvites, scope, opts) {
      /*
       * A derived birthday has no server-side existence, so there is nothing to
       * write and an id that would mean nothing if sent. The UI already keeps
       * these out of reach by giving the virtual calendar no write rights; this
       * is the check that makes that true of the store as well, whatever calls
       * it.
       */
      if (isBirthdayEvent(event.id) || isSubscriptionEvent(event.id)) return [];
      const currentCalId = Object.keys(event.calendarIds ?? {})[0];
      /*
       * Which account holds the event. The caller holding the instance knows
       * (an id means nothing outside its account, and the reader's own and a
       * shared account can both hold a same-id event), and says so through
       * `opts.accountId`; the account is only guessed from the calendars
       * loaded so far when nobody said.
       */
      const accountId =
        opts?.accountId ??
        accountOfCalendar(
          currentCalId,
          get().calendars,
          get().accountId,
          get().sharedCalendars,
        );
      if (!accountId) throw new Error("Calendar is not available");
      const id =
        scope === "occurrence"
          ? await currentOccurrenceId(accountId, event)
          : eventIdForScope(event, scope);
      // An occurrence takes less than the series does, and says so about only
      // half of it. Narrow the patch here rather than posting it hopefully.
      const { patch: body, dropped } =
        scope === "occurrence"
          ? occurrencePatch(patch)
          : { patch, dropped: [] as string[] };
      if (!Object.keys(body).length) return dropped;

      /*
       * Where the patch is moving the event, if it moves it at all. The target
       * account comes from the caller when it chose one of several same-id
       * calendars (`opts.moveTo`); without that, it is guessed the same way the
       * source is.
       */
      const targetCalId = Object.keys(
        (body.calendarIds as Record<string, true> | undefined) ?? {},
      )[0];
      const targetAccount =
        opts?.moveTo?.accountId ??
        (targetCalId
          ? accountOfCalendar(
              targetCalId,
              get().calendars,
              get().accountId,
              get().sharedCalendars,
            )
          : accountId);
      const sameCalendar =
        !targetCalId || (targetCalId === currentCalId && targetAccount === accountId);
      /*
       * Moving the event to a calendar in another account.
       *
       * Two accounts are two JMAP accounts, and an event cannot change accounts
       * by editing `calendarIds` — the id would name a calendar the old account
       * does not hold, so the event would either be refused or simply stop
       * being drawn. A move across accounts is re-filing: the reader's edits
       * land on the event where it is, then the whole event is recreated under
       * the target account with the same uid (so an attendee's copy updates
       * rather than duplicating), and the original is destroyed.
       */
      if (targetCalId && !sameCalendar && !targetAccount)
        throw new Error("Calendar is not available");
      if (targetCalId && !sameCalendar && targetAccount && targetAccount !== accountId) {
        // An occurrence belongs to the series that holds it and cannot leave
        // for another account on its own; the editor already disables the
        // picker for one, and occurrencePatch refused the id above.
        if (scope === "occurrence") throw new OccurrenceScopeError("calendarIds");
        /* A calendar that is not on the reader's own account is added first,
           or the moved event would not be drawn back where it went. */
        if (targetAccount !== get().accountId)
          await ensureCalendarVisible(get, targetAccount, targetCalId);
        /* 1. The reader's edits, where the event already is. Invitations wait
              for the re-filed copy, which is what guests will answer. A pure
              move edits nothing here, so there is nothing to send. */
        const { calendarIds: _moved, ...sameAccount } = body;
        if (Object.keys(sameAccount).length) {
          const res0 = await client.call<SetResponse>("CalendarEvent/set", {
            accountId,
            update: { [id]: sameAccount },
            sendSchedulingMessages: false,
          });
          const err0 = res0.notUpdated?.[id];
          if (err0) throw new CalendarSetError(err0);
        }
        /* 2. The event as the source account stores it now — a fresh read, so
              nothing of it (a recurrence and its overrides among the rest) is
              lost on the way to the other account. */
        const stored = await readEvent(accountId, id);
        if (!stored)
          throw new Error(
            "The event could not be read again after saving, so it was not moved.",
          );
        /* 3. Recreate it under the target account, same uid. */
        const res1 = await client.call<SetResponse<CalendarEvent>>("CalendarEvent/set", {
          accountId: targetAccount,
          create: { e: moveCopy(stored, targetCalId) },
          sendSchedulingMessages: sendInvites,
        });
        const err1 = res1.notCreated?.e;
        if (err1) throw new Error(setErrorMessage(err1));
        /* 4. Drop the original. A failure here leaves the event in both
              accounts — better a duplicate than a loss, and the message says
              which half happened. */
        const res2 = await client.call<SetResponse>("CalendarEvent/set", {
          accountId,
          destroy: [id],
          sendSchedulingMessages: false,
        });
        const err2 = res2.notDestroyed?.[id];
        get().refreshWindows();
        if (err2)
          throw new Error(
            "The event was moved, but the copy on the old calendar could not be deleted. Delete it by hand.",
          );
        return dropped;
      }
      // Show the change at once instead of snapping back until the refresh
      // lands: patch the cached copy now and restore it if the server refuses.
      // A move shifts every cached copy of the series (a series is cached as its
      // occurrences, keyed under the base id), so the whole run of chips lands
      // at once rather than one chip snapping back to its old slot.
      const delta =
        typeof body.start === "string" && typeof event.start === "string"
          ? new Date(body.start).getTime() - new Date(event.start).getTime()
          : NaN;
      const moved = !Number.isNaN(delta) && delta !== 0;
      const previous = get().events[id];
      const seriesKeys = !previous
        ? Object.keys(get().events).filter((k) => get().events[k]?.baseEventId === id)
        : [];
      const originals = previous
        ? { [id]: previous }
        : Object.fromEntries(seriesKeys.map((k) => [k, get().events[k]!]));
      if (previous || seriesKeys.length) {
        set((s) => {
          const events = { ...s.events };
          if (previous) {
            events[id] = moved
              ? shiftEvent(previous, delta)
              : ({ ...previous, ...(body as object) } as CalendarEvent);
          } else {
            for (const k of seriesKeys) events[k] = shiftEvent(events[k]!, delta);
          }
          return { events };
        });
      }
      try {
        const res = await client.call<SetResponse>("CalendarEvent/set", {
          accountId,
          update: { [id]: body },
          sendSchedulingMessages: sendInvites,
        });
        const err = res.notUpdated?.[id];
        if (err) throw new CalendarSetError(err);
      } catch (err) {
        if (Object.keys(originals).length)
          set((s) => ({ events: { ...s.events, ...originals } }));
        throw err;
      }
      get().refreshWindows();
      return dropped;
    },

    async destroyEvent(event, sendInvites, scope, accountId) {
      /*
       * A derived birthday has no server-side existence, so there is nothing to
       * write and an id that would mean nothing if sent. The UI already keeps
       * these out of reach by giving the virtual calendar no write rights; this
       * is the check that makes that true of the store as well, whatever calls
       * it.
       */
      if (isBirthdayEvent(event.id) || isSubscriptionEvent(event.id)) return;
      const accountId_ =
        accountId ??
        accountOfCalendar(
          Object.keys(event.calendarIds ?? {})[0],
          get().calendars,
          get().accountId,
          get().sharedCalendars,
        );
      if (!accountId_) throw new Error("Calendar is not available");
      const id =
        scope === "occurrence"
          ? await currentOccurrenceId(accountId_, event)
          : eventIdForScope(event, scope);
      const res = await client.call<SetResponse>("CalendarEvent/set", {
        accountId: accountId_,
        destroy: [id],
        sendSchedulingMessages: sendInvites,
      });
      const err = res.notDestroyed?.[id];
      if (err) throw new CalendarSetError(err);
      set((s) => {
        const events = { ...s.events };
        // Drop both ids: the one that was sent, and the object as the caller
        // held it. An occurrence destroy leaves the master alone on purpose.
        delete events[id];
        if (scope === "occurrence") delete events[event.id];
        return { events };
      });
      get().refreshWindows();
    },

    async rsvp(event, status, comment, accountId) {
      const mine = myParticipantKeys(event, get().identities);
      if (!mine.length) throw new Error("You are not a participant of this event");
      const patch: Record<string, unknown> = {};
      for (const k of mine) {
        patch[`participants/${k}/participationStatus`] = status;
        if (comment) patch[`participants/${k}/participationComment`] = comment;
      }
      // Answering for the series, not for one date. The patch itself survives
      // either scope -- `participants/{key}/participationStatus` is one of the
      // pointers 0.16.20 allows on an occurrence -- so this would silently mean
      // "only that day" if it were aimed at an instance. Accepting an invitation
      // means accepting the series.
      await get().updateEvent(event, patch, true, "series", { accountId });
    },

    /**
     * The event with this uid, as a master rather than an occurrence.
     *
     * The query deliberately omits `expandRecurrences`, so what comes back is the
     * stored event and `id` is a real id. Callers rely on that — `InviteCard`
     * removes a cancelled event by handing this straight to `destroyEvent` — so
     * it is a property of this method, not an accident of the default.
     */
    async findByUid(uid) {
      const accountId = get().accountId;
      if (!accountId) return null;
      /*
       * No `catch`. `null` from here means "this calendar does not hold that
       * event", and the one caller reads it as the difference between offering
       * **Update** and offering **Add**: a failure that answered `null` therefore
       * told the reader an invitation they had already added was new, and pressing
       * Add made a second copy of it. The caller is inside a promise chain with its
       * own `catch` that draws "This invitation could not be read", which is the
       * answer a failed read has; a failed read is not an empty calendar.
       */
      const res = await client.chain([
        ["CalendarEvent/query", { accountId, filter: { uid }, limit: 1 }, "q"],
        [
          "CalendarEvent/get",
          {
            accountId,
            "#ids": ref("q", "CalendarEvent/query", "/ids"),
            properties: EVENT_PROPS,
          },
          "g",
        ],
      ]);
      const g = res.get("g")?.[0] as unknown as GetResponse<CalendarEvent>;
      const e = g.list[0];
      if (e) set((s) => ({ events: { ...s.events, [e.id]: e } }));
      return e ?? null;
    },

    setDraft(draft) {
      set({ draft });
    },
  };
}
