/**
 * The tools over the account's own calendars (ADR 0027).
 *
 * The calendars a person may write to, the events in a window, one event read
 * by its id, and an event saved or removed. The group's calendar is the
 * account's own, like its mail and its Files: the run acts on what the people
 * in the group can already see, and nothing here reaches a person outside it —
 * an event carries no invitation and no scheduling message.
 */

import type { Ctx } from "../../appFolder.js";
import { cachedMail } from "../../mailCache.js";
import { CAPABILITIES } from "../../shared/capabilities.js";
import { refusalOf, type SetResponse } from "../../shared/jmap.js";
import { isRecord } from "../../shared/json.js";
import { clientOf } from "../../util.js";
import { argsRecord, notFound, optionalTextArg, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

/** How many events one window answers with, whatever the model asks for. */
const FIND_MAX = 50;

/** A calendar as this tier reads it, for the model to choose from. */
interface CalendarRow {
  id: string;
  name: string;
  isDefault: boolean;
  timeZone: string | null;
  mayWrite: boolean;
}

async function calendarsOf(ctx: Ctx, accountId: string): Promise<CalendarRow[]> {
  /*
   * One calendar list per unit of work: every calendar write resolves a name
   * through it, so a plan of three creates read the same tree three times.
   * `Calendar/set` forgets it (`jmap.ts`), and the TTL bounds a change made by
   * another process.
   */
  return await cachedMail(ctx, accountId, "calendars", async () => {
    const res = await clientOf(ctx).call<{ list?: unknown[] }>(
      "Calendar/get",
      { accountId },
      [CAPABILITIES.calendars],
    );
    return (res.list ?? []).flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.id !== "string") return [];
      const rights = isRecord(raw.myRights) ? raw.myRights : {};
      return [
        {
          id: raw.id,
          name: typeof raw.name === "string" ? raw.name : raw.id,
          isDefault: raw.isDefault === true,
          timeZone: typeof raw.timeZone === "string" ? raw.timeZone : null,
          mayWrite: rights.mayWriteAll === true || rights.mayWriteOwn === true,
        },
      ];
    });
  });
}

function findCalendar(
  calendars: readonly CalendarRow[],
  name: string,
): CalendarRow | undefined {
  const wanted = name.trim().toLowerCase();
  return (
    calendars.find((one) => one.id === name) ??
    calendars.find((one) => one.name.toLowerCase() === wanted)
  );
}

/** What a listing says about one event: enough to choose what to read next. */
function eventRow(raw: Record<string, unknown>) {
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    baseEventId: typeof raw.baseEventId === "string" ? raw.baseEventId : null,
    calendars: isRecord(raw.calendarIds) ? Object.keys(raw.calendarIds) : [],
    title: typeof raw.title === "string" ? raw.title : "",
    start: typeof raw.start === "string" ? raw.start : null,
    duration: typeof raw.duration === "string" ? raw.duration : null,
    timeZone: typeof raw.timeZone === "string" ? raw.timeZone : null,
    showWithoutTime: raw.showWithoutTime === true,
    status: typeof raw.status === "string" ? raw.status : null,
  };
}

export const listCalendars = defineTool({
  name: "calendar.list",
  description:
    "List this account's calendars, each with its id, its name, its time zone " +
    "and whether you may write to it. Choose an event's calendar from this " +
    "answer rather than guessing a name.",
  authority: "reversible",
  writes: false,
  keys: [],
  args: {},
  parse: () => ({}),
  run: async ({ ctx, accountId }) => ({ calendars: await calendarsOf(ctx, accountId) }),
});

export const findEvents = defineTool({
  name: "calendar.find",
  description:
    "Find events in this account between two instants (`from` and `to`, ISO " +
    "8601, e.g. 2026-10-20T00:00:00Z). Recurring events are expanded, so each " +
    `occurrence in the window is a row and carries the id that answers it. At most ${FIND_MAX} rows.`,
  authority: "reversible",
  writes: false,
  keys: ["from", "to"],
  args: { from: { type: "text" }, to: { type: "text" } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { from: textArg(args, "from"), to: textArg(args, "to") };
  },
  run: async ({ ctx, accountId }, { from, to }) => {
    const client = clientOf(ctx);
    const queried = await client.call<{ ids?: string[] }>(
      "CalendarEvent/query",
      {
        accountId,
        filter: { after: from, before: to },
        expandRecurrences: true,
        limit: FIND_MAX,
      },
      [CAPABILITIES.calendars],
    );
    const ids = (queried.ids ?? []).slice(0, FIND_MAX);
    if (!ids.length) return { events: [] };
    const read = await client.call<{ list?: unknown[]; notFound?: string[] }>(
      "CalendarEvent/get",
      { accountId, ids },
      [CAPABILITIES.calendars],
    );
    const events = (read.list ?? []).flatMap((raw) =>
      isRecord(raw) ? [eventRow(raw)] : [],
    );
    const missing = (read.notFound ?? []).map((id) => ({ id }));
    return missing.length ? { events, missing } : { events };
  },
});

export const readEvent = defineTool({
  name: "calendar.read",
  description:
    "Read one calendar event of this account by its id, as the calendar holds " +
    "it: its title, its start and duration, its description, its location and " +
    "the calendar it is on.",
  authority: "reversible",
  writes: false,
  keys: ["id"],
  args: { id: { type: "text" } },
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    const res = await clientOf(ctx).call<{ list?: unknown[]; notFound?: string[] }>(
      "CalendarEvent/get",
      { accountId, ids: [id] },
      [CAPABILITIES.calendars],
    );
    const event = (res.list ?? []).find(isRecord);
    if (!event) throw notFound(`event "${id}" in this account's calendar`);
    return { event };
  },
});

/** The fields a change of an event may name, and only the ones it named. */
function patchOf(args: {
  title?: string;
  start?: string;
  duration?: string;
  timeZone?: string;
  description?: string;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.start !== undefined) patch.start = args.start;
  if (args.duration !== undefined) patch.duration = args.duration;
  if (args.timeZone !== undefined) patch.timeZone = args.timeZone;
  if (args.description !== undefined) patch.description = args.description;
  if (!Object.keys(patch).length)
    throw new ToolError("bad_arguments", "A change names at least one field.", 400);
  return patch;
}

/** The one event read by id, with the occurrence refusal a change needs. */
async function eventOf(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const read = await clientOf(ctx).call<{ list?: unknown[] }>(
    "CalendarEvent/get",
    { accountId, ids: [id] },
    [CAPABILITIES.calendars],
  );
  const event = (read.list ?? []).find(isRecord);
  if (!event) throw notFound(`event "${id}" in this account's calendar`);
  return event;
}

/**
 * A new event: the only calendar act the agent does alone. A start with a time
 * is a JSCalendar `LocalDateTime` and needs the zone the calendar keeps; a date
 * alone is an all-day event, and no invitation is sent.
 */
export const createEvent = defineTool({
  name: "calendar.create",
  description:
    "Create an event in this account's calendar: `calendar` (an id or name from " +
    "calendar.list), `title` and `start` are required. `start` is a wall-clock " +
    "datetime (2026-10-20T09:00:00) or a date alone (2026-10-20) for an all-day " +
    "event; `duration` is an ISO 8601 duration (PT1H, P1D) and defaults to one " +
    "hour. No invitation is sent.",
  authority: "reversible",
  writes: true,
  surface: "calendar",
  spend: { steps: 1 },
  keys: ["calendar", "description", "duration", "start", "timeZone", "title"],
  args: {
    calendar: { type: "text" },
    title: { type: "text" },
    start: { type: "text" },
    duration: { type: "text" },
    timeZone: { type: "text" },
    description: { type: "text" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      calendar: textArg(args, "calendar"),
      title: textArg(args, "title"),
      start: textArg(args, "start"),
      duration: optionalTextArg(args, "duration"),
      timeZone: optionalTextArg(args, "timeZone"),
      description: optionalTextArg(args, "description"),
    };
  },
  run: async (
    { ctx, accountId },
    { calendar, title, start, duration, timeZone, description },
  ) => {
    const chosen = findCalendar(await calendarsOf(ctx, accountId), calendar);
    if (!chosen) throw notFound(`calendar "${calendar}" in this account`);
    if (!chosen.mayWrite)
      throw new ToolError(
        "forbidden",
        `"${chosen.name}" is readable and this account may not write to it.`,
        403,
      );
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
    const zone = timeZone ?? chosen.timeZone;
    if (!allDay && !zone)
      throw new ToolError(
        "bad_arguments",
        `"${chosen.name}" keeps no time zone of its own; name one to place "${start}".`,
        400,
      );
    const event = {
      "@type": "Event",
      uid: crypto.randomUUID(),
      ...(allDay ? { start, showWithoutTime: true } : { start, timeZone: zone }),
      duration: duration ?? (allDay ? "P1D" : "PT1H"),
      title,
      ...(description ? { description } : {}),
      calendarIds: { [chosen.id]: true },
    };
    const res = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
      "CalendarEvent/set",
      { accountId, create: { e: event } },
      [CAPABILITIES.calendars],
    );
    const refused = res.notCreated?.e;
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    const created = res.created?.e?.id;
    if (!created)
      throw new ToolError(
        "write_refused",
        "The mail server created the event but returned no id.",
        502,
      );
    // Its own write, so the change reading does not answer it.
    rememberOwnEvent(created);
    return { id: created, calendar: chosen.id, title, start, duration: event.duration };
  },
});

/**
 * A change of an existing event: destructive (ADR 0028 names a document
 * overwritten), so it runs only under a person's word for that event.
 */
export const updateEvent = defineTool({
  name: "calendar.update",
  description:
    "Change an event of this account's calendar by its id: name only the fields " +
    "to change (`title`, `start`, `duration`, `timeZone`, `description`); " +
    "nothing else is touched. An occurrence of a recurring event is not changed " +
    "on its own. The act is the event: a person's word for it names the event.",
  authority: "destructive",
  writes: true,
  surface: "calendar",
  spend: { steps: 1 },
  act: (args: { id: string }) => ({ target: args.id, content: null }),
  keys: ["description", "duration", "id", "start", "timeZone", "title"],
  args: {
    id: { type: "text" },
    title: { type: "text" },
    start: { type: "text" },
    duration: { type: "text" },
    timeZone: { type: "text" },
    description: { type: "text" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      id: textArg(args, "id"),
      title: optionalTextArg(args, "title"),
      start: optionalTextArg(args, "start"),
      duration: optionalTextArg(args, "duration"),
      timeZone: optionalTextArg(args, "timeZone"),
      description: optionalTextArg(args, "description"),
    };
  },
  run: async (
    { ctx, accountId },
    { id, title, start, duration, timeZone, description },
  ) => {
    const current = await eventOf(ctx, accountId, id);
    if (typeof current.baseEventId === "string")
      throw new ToolError(
        "recurring_occurrence",
        `"${id}" is one occurrence of a recurring event; change the series by its id "${current.baseEventId}".`,
        409,
      );
    const patch = patchOf({ title, start, duration, timeZone, description });
    const res = await clientOf(ctx).call<SetResponse>(
      "CalendarEvent/set",
      { accountId, update: { [id]: patch } },
      [CAPABILITIES.calendars],
    );
    const refused = res.notUpdated?.[id];
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    // Its own write, so the change reading does not answer it.
    rememberOwnEvent(id);
    return { id, changed: Object.keys(patch) };
  },
});

/**
 * The events this process wrote, so the change reading can tell the agent's own
 * act from a person's.
 *
 * A create, a change or a removal the agent made is activity, but not activity
 * to answer: a rule watching the calendar that woke on its own write would open
 * a run, whose write would wake it again. The ids are the server's, the set is
 * bounded because it is a speed-up and never a store, and the mark is taken by
 * the first change it explains — one write is one change.
 */
const ownEvents = new Set<string>();
const OWN_EVENTS_KEPT = 500;

function rememberOwnEvent(id: string): void {
  if (ownEvents.has(id)) return;
  ownEvents.add(id);
  if (ownEvents.size > OWN_EVENTS_KEPT) {
    const oldest = ownEvents.values().next().value;
    if (oldest !== undefined) ownEvents.delete(oldest);
  }
}

/** Whether the next change of this event is the agent's own write, taking the mark with it. */
export function takeOwnCalendarChange(id: string): boolean {
  return ownEvents.delete(id);
}

export const deleteEvent = defineTool({
  name: "calendar.delete",
  description:
    "Remove one event of this account's calendar by its id. A recurring event " +
    "is removed as the series; one occurrence is not removed on its own. The " +
    "act is the event: a person's word for it names the event.",
  authority: "destructive",
  writes: true,
  surface: "calendar",
  spend: { steps: 1 },
  act: (args: { id: string }) => ({ target: args.id, content: null }),
  keys: ["id"],
  args: { id: { type: "text" } },
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    const client = clientOf(ctx);
    const read = await client.call<{ list?: unknown[] }>(
      "CalendarEvent/get",
      { accountId, ids: [id] },
      [CAPABILITIES.calendars],
    );
    const event = (read.list ?? []).find(isRecord);
    if (!event) throw notFound(`event "${id}" in this account's calendar`);
    if (typeof event.baseEventId === "string")
      throw new ToolError(
        "recurring_occurrence",
        `"${id}" is one occurrence of a recurring event; remove the series by its id "${event.baseEventId}".`,
        409,
      );
    const res = await client.call<SetResponse>(
      "CalendarEvent/set",
      { accountId, destroy: [id] },
      [CAPABILITIES.calendars],
    );
    const refused = res.notDestroyed?.[id];
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    // Its own removal, so the change reading does not answer it.
    rememberOwnEvent(id);
    return { id, removed: true };
  },
});
