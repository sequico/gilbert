/**
 * The tools over the account's own calendars (ADR 0031).
 *
 * The calendars a person may write to, the events in a window, one event read
 * by its id, and an event saved or removed. The group's calendar is the
 * account's own, like its mail and its Files: the run acts on what the people
 * in the group can already see, and nothing here reaches a person outside it —
 * an event carries no invitation and no scheduling message.
 */

import type { Ctx } from "../../appFolder.js";
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

/**
 * The event a save writes: what the caller named, and nothing this build did
 * not read the shape of. A start with a time is a JSCalendar `LocalDateTime`
 * and needs the zone the calendar keeps; a date alone is an all-day event.
 */
export const saveEvent = defineTool({
  name: "calendar.save",
  description:
    "Create or change an event in this account's calendar. Name no `id` to " +
    "create one: then `calendar` (an id or name from calendar.list), `title` " +
    "and `start` are required. `start` is a wall-clock datetime " +
    "(2026-10-20T09:00:00) or a date alone (2026-10-20) for an all-day event; " +
    "`duration` is an ISO 8601 duration (PT1H, P1D) and defaults to one hour. " +
    "Changed fields are those named beside the `id`; nothing else is touched.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  keys: ["calendar", "description", "duration", "id", "start", "timeZone", "title"],
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      id: optionalTextArg(args, "id"),
      calendar: optionalTextArg(args, "calendar"),
      title: optionalTextArg(args, "title"),
      start: optionalTextArg(args, "start"),
      duration: optionalTextArg(args, "duration"),
      timeZone: optionalTextArg(args, "timeZone"),
      description: optionalTextArg(args, "description"),
    };
  },
  run: async (
    { ctx, accountId },
    { id, calendar, title, start, duration, timeZone, description },
  ) => {
    const client = clientOf(ctx);
    if (id) {
      const read = await client.call<{ list?: unknown[]; notFound?: string[] }>(
        "CalendarEvent/get",
        { accountId, ids: [id] },
        [CAPABILITIES.calendars],
      );
      const current = (read.list ?? []).find(isRecord);
      if (!current) throw notFound(`event "${id}" in this account's calendar`);
      if (typeof current.baseEventId === "string")
        throw new ToolError(
          "recurring_occurrence",
          `"${id}" is one occurrence of a recurring event; change the series by its id "${current.baseEventId}".`,
          409,
        );
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (start !== undefined) patch.start = start;
      if (duration !== undefined) patch.duration = duration;
      if (timeZone !== undefined) patch.timeZone = timeZone;
      if (description !== undefined) patch.description = description;
      if (!Object.keys(patch).length)
        throw new ToolError("bad_arguments", "A change names at least one field.", 400);
      const res = await client.call<SetResponse>(
        "CalendarEvent/set",
        { accountId, update: { [id]: patch } },
        [CAPABILITIES.calendars],
      );
      const refused = res.notUpdated?.[id];
      if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
      return { id, changed: Object.keys(patch) };
    }
    if (!calendar)
      throw new ToolError("bad_arguments", 'Creating an event takes "calendar".', 400);
    if (!title)
      throw new ToolError("bad_arguments", 'Creating an event takes "title".', 400);
    if (!start)
      throw new ToolError("bad_arguments", 'Creating an event takes "start".', 400);
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
    const res = await client.call<SetResponse<{ id?: string }>>(
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
    return { id: created, calendar: chosen.id, title, start, duration: event.duration };
  },
});

export const deleteEvent = defineTool({
  name: "calendar.delete",
  description:
    "Remove one event of this account's calendar by its id. A recurring event " +
    "is removed as the series; one occurrence is not removed on its own.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  keys: ["id"],
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
    return { id, removed: true };
  },
});
