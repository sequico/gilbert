import { queryThenGet } from "@gilbert/shared/jmapQuery";
import { batchedSet, client, setErrorMessage } from "@/jmap/client";
import type { CalendarEvent, GetResponse, Id, QueryResponse } from "@/jmap/types";
import { toIcs } from "@/lib/ics";
import { SERIES_PROPS } from "../shared";
import type { CalendarGet, CalendarSet, CalendarState } from "../types";

function forImport(event: Partial<CalendarEvent>): Partial<CalendarEvent> {
  const {
    id: _id,
    calendarIds: _c,
    baseEventId: _b,
    utcStart: _us,
    utcEnd: _ue,
    isOrigin: _io,
    method: _m,
    ...rest
  } = event as CalendarEvent & { method?: string };
  return rest;
}

/**
 * The events a calendar already holds, for recognising a re-import.
 *
 * A UID is what makes an event the same event across calendars, and the import
 * keeps the file's own wherever there is one -- which is what makes a re-import
 * recognisable. Asked for
 * once per import rather than once per event: `CalendarEvent/query` does take a
 * `uid` filter, but a file of two thousand events would be two thousand
 * queries.
 *
 * Read without `expandRecurrences`, so a weekly series is one event with one
 * UID rather than one per occurrence, and filtered to the target calendar here
 * rather than in the query -- the same event legitimately lives in two
 * calendars, and `calendarIds` says which without relying on a filter this
 * client has not confirmed the server supports.
 */
async function eventsInCalendar(
  accountId: Id,
  calendarId: Id,
  properties: string[],
): Promise<CalendarEvent[]> {
  const found: CalendarEvent[] = [];
  const page = client.maxObjectsInGet;
  for (let position = 0; ; ) {
    const res = await client.chain(
      queryThenGet({
        query: "CalendarEvent/query",
        get: "CalendarEvent/get",
        accountId,
        position,
        limit: page,
        maxObjectsInGet: page,
        properties,
      }),
    );
    const q = res.get("q")?.[0] as unknown as QueryResponse;
    const g = res.get("g")?.[0] as unknown as GetResponse<CalendarEvent>;
    const ids = q.ids ?? [];
    if (!ids.length) break;
    for (const e of g.list) if (e.calendarIds?.[calendarId]) found.push(e);
    position += ids.length;
    // `total` is optional, so the empty page above is what actually ends this;
    // this only saves the round trip that would find it.
    if (q.total != null && position >= q.total) break;
  }
  return found;
}

/**
 * uid -> the id of the event carrying it, for deciding what a re-import updates.
 *
 * The id and not just the UID, because an event already here is updated rather
 * than skipped, and updating needs something to address -- the same
 * arrangement, and for the same reason, as contacts' `scanBook`. A UID the
 * calendar somehow holds twice keeps the first: two events with one UID is
 * already a state nothing here can make sense of, and addressing one of them
 * is better than writing the file over both.
 */
async function eventIdsByUid(accountId: Id, calendarId: Id): Promise<Map<string, Id>> {
  const events = await eventsInCalendar(accountId, calendarId, ["uid", "calendarIds"]);
  const byUid = new Map<string, Id>();
  for (const e of events) if (e.uid && !byUid.has(e.uid)) byUid.set(e.uid, e.id);
  return byUid;
}

/**
 * ICS: an .ics file in and out, and a single event parsed from an invitation.
 *
 * A slice of the calendar store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function icsSlice(
  _set: CalendarSet,
  get: CalendarGet,
): Pick<CalendarState, "parseIcs" | "importEvent" | "importIcs" | "exportIcs"> {
  return {
    async parseIcs(blobId) {
      const accountId = get().accountId;
      if (!accountId) return [];
      const res = await client.call<{
        parsed?: Record<string, CalendarEvent[] | CalendarEvent>;
        notParsable?: Id[];
      }>("CalendarEvent/parse", { accountId, blobIds: [blobId] });
      const entry = res.parsed?.[blobId];
      if (!entry) return [];
      return Array.isArray(entry) ? entry : [entry];
    },

    async importEvent(event, calendarId) {
      return get().createEvent(forImport(event), calendarId, false);
    },

    /*
     * A file, rather than the single event an invitation carries.
     *
     * The parsing is the server's, the same `CalendarEvent/parse` an emailed
     * invitation goes through -- an .ics is not a format worth reimplementing in
     * a browser, and the one already in Stalwart handles what a hand-rolled
     * parser would not.
     *
     * The events go out `maxObjectsInSet` at a time -- the ceiling the session
     * advertises, 500 where a server does not say. A call carrying more than that
     * is refused whole with `requestTooLarge` and creates nothing, so a real
     * export -- an 800 KB file is thousands of events -- imports nothing at all
     * when it goes out in a single call.
     *
     * Batches rather than a call per event, though: `createEvent` refreshes on
     * the way out, and a refresh re-fetches every cached range, so importing a
     * year of events one at a time would refetch the calendar a few hundred
     * times. One refreshWindows here, after the last batch.
     *
     * No scheduling messages, on a create or an update. Importing a file is
     * filing something you already have, and mailing its participants would be a
     * surprise to everyone. That is plainly right for a create and it is a real
     * cost on an update -- moving an event without telling anyone leaves every
     * attendee's own copy saying the old time, with nothing anywhere reporting
     * the disagreement. Weighed on #279 and kept: an import is not the place to
     * start sending mail on somebody's behalf, and the alternative is a file
     * dropped into a calendar mailing a room full of people who never asked for
     * it. Whoever is organising can send the update from the event itself.
     */
    async importIcs(text, calendarId) {
      const accountId = get().accountId!;
      const up = await client.upload(
        accountId,
        new Blob([text], { type: "text/calendar" }),
        { type: "text/calendar" },
      );
      const events = await get().parseIcs(up.blobId);
      if (!events.length) throw new Error("it has no events in it");
      const already = await eventIdsByUid(accountId, calendarId);
      const create: Record<string, unknown> = {};
      const update: Record<Id, unknown> = {};
      events.forEach((e, i) => {
        const rest = forImport(e);
        /*
         * A UID is what makes an event the same event across calendars, so the
         * file's own is kept wherever it has one. Only what arrives without gets
         * invented, and an event with no UID is not one anything can match to --
         * which is also why an event without one is imported rather than guessed
         * about. Re-importing an export without that match leaves second copies of
         * everything; asked for on #173, decided there.
         */
        const existing = rest.uid ? already.get(rest.uid) : undefined;
        if (existing) {
          /*
           * An event this calendar already holds is updated from the file, the
           * way a re-imported contact is (#242, #274): the reason to import a
           * file a second time is usually that the first one was not right, and
           * skipping means a corrected export corrects nothing.
           *
           * Two properties are held back, decided on #279. `participants` carries
           * every attendee's accepted/declined and `recurrenceOverrides` holds
           * every "just this Wednesday" edit made here -- both are answers and
           * decisions that happened after the file was written, and a file that
           * mentions them at all describes them as they were at export. Writing
           * either one over would destroy work nobody asked to lose, silently,
           * with no error returned anywhere. So a corrected export fixes the
           * time, the title and the location and leaves who said yes alone.
           *
           * The cost runs the other way: an attendee added at the source since
           * the last import does not arrive, and nothing here can tell that apart
           * from an RSVP given in Gilbert. Losing an answer somebody gave is
           * worse than not gaining an attendee somebody can still be told about.
           *
           * `uid` is held back too -- it is what the two were matched on, so it
           * is already equal, and it is the event's identity rather than a field
           * of it worth re-asserting.
           */
          const { uid: _u, participants: _p, recurrenceOverrides: _r, ...patch } = rest;
          update[existing] = patch;
          return;
        }
        create[`e${i}`] = {
          "@type": "Event",
          ...rest,
          uid: rest.uid || crypto.randomUUID(),
          calendarIds: { [calendarId]: true },
        };
      });
      /*
       * Creates and updates share one budget, and `batchedSet` is the loop that
       * spends it: the ceiling is counted across the whole call, so the two kinds
       * cannot be batched apart. One refresh at the end, not one per batch.
       */
      const { created, updated, refused } = await batchedSet<CalendarEvent>({
        method: "CalendarEvent",
        accountId,
        create,
        update,
        extra: { sendSchedulingMessages: false },
        noun: "events",
        onSettled: (landed) => {
          if (landed) get().refreshWindows();
        },
      });
      // Nothing at all got in: say why rather than report importing zero events
      // as though the file had been empty.
      if (!created && !updated)
        throw new Error(
          refused
            ? setErrorMessage(refused)
            : "the server did not accept any of its events",
        );
      return { created, updated };
    },

    /*
     * The calendar out to a file, which is the import read backwards.
     *
     * The masters, not the occurrences: the query runs without
     * `expandRecurrences`, so a weekly series leaves here as one VEVENT carrying
     * its RRULE rather than as a year of identical ones. An export that had
     * flattened the rule would import somewhere else as an unmaintainable pile.
     *
     * Written in the browser, unlike the import, which hands the parsing to the
     * server. There is no `CalendarEvent/serialise` to hand this to -- the JMAP
     * calendar drafts define parsing and nothing the other way -- so it is done
     * here from the objects the server already returns.
     */
    async exportIcs(calendarId) {
      const accountId = get().accountId!;
      const events = await eventsInCalendar(accountId, calendarId, SERIES_PROPS);
      if (!events.length) throw new Error("there is nothing in it to export");
      return {
        text: toIcs(events, get().calendars[calendarId]?.name),
        count: events.length,
      };
    },
  };
}
