import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, CalendarEvent, JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";

/**
 * Moving an event to a calendar that lives in another account — the reader's
 * own and a team or shared calendar are different JMAP accounts, and an event
 * cannot change accounts by editing `calendarIds`: the id would name a
 * calendar the old account does not hold. The store's answer is re-filing:
 * the reader's edits go where the event is, then the whole event is recreated
 * under the target account with the same uid, and the original is destroyed.
 * These tests pin the order and the shape of every call.
 */

/** A one-off stored in the reader's own account (`a1`), calendar `c1`. */
const EVENT: CalendarEvent = {
  id: "i",
  "@type": "Event",
  uid: "u1",
  calendarIds: { c1: true },
  title: "Standup",
  start: "2026-09-04T09:00:00",
  duration: "PT30M",
} as unknown as CalendarEvent;

const CALENDAR = (id: string) =>
  ({
    id,
    name: id,
    myRights: { mayWriteAll: true },
    isSubscribed: true,
    isDefault: false,
  }) as unknown as Calendar;

/** A server that answers every calendar call and records what it was asked. */
function stubServer() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses: unknown[] = [];
      for (const [name, args, id] of body.methodCalls) {
        calls.push({ name, args });
        if (name === "CalendarEvent/get") {
          const ids = (args.ids as string[]) ?? [];
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              list: ids.map((x) => ({ ...EVENT, id: x })),
              notFound: [],
            },
            id,
          ]);
        } else if (name === "CalendarEvent/set") {
          const created: Record<string, unknown> = {};
          for (const k of Object.keys((args.create as Record<string, unknown>) ?? {}))
            created[k] = { id: `n${k}` };
          const updated: Record<string, unknown> = {};
          for (const k of Object.keys((args.update as Record<string, unknown>) ?? {}))
            updated[k] = null;
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              created,
              updated,
              destroyed: args.destroy ?? [],
              notCreated: {},
              notUpdated: {},
              notDestroyed: {},
            },
            id,
          ]);
        } else {
          methodResponses.push([
            name,
            { accountId: args.accountId, state: "1", list: [], notFound: [] },
            id,
          ]);
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ methodResponses, sessionState: "1" }),
      } as Response;
    }),
  );
  return calls;
}

const setState = (sharedSubscribed = true) => {
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: { c1: CALENDAR("c1"), c2: CALENDAR("c2") },
    sharedCalendars: [
      {
        accountId: "a2",
        accountName: "Team",
        calendar: {
          ...CALENDAR("s1"),
          isSubscribed: sharedSubscribed,
        },
      },
    ],
    events: { [EVENT.id]: EVENT },
    ranges: {},
    hidden: {},
    sharedEvents: {},
    sharedRanges: {},
    identities: [],
  });
};

beforeEach(() => {
  client.session = {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.calendars]: {},
    },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  setState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("moving an event to a calendar in another account", () => {
  it("re-files the event: create on the target account, then destroy the source", async () => {
    const calls = stubServer();
    const dropped = await useCalendar
      .getState()
      .updateEvent(EVENT, { calendarIds: { s1: true } }, false, "series");
    expect(dropped).toEqual([]);

    const sets = calls.filter((c) => c.name === "CalendarEvent/set");
    expect(sets).toHaveLength(2);
    // The target account first: the event exists somewhere before it stops
    // existing somewhere else.
    const create = sets[0]!;
    expect(create.args.accountId).toBe("a2");
    const made = (create.args.create as Record<string, Record<string, unknown>>).e!;
    expect(made.uid).toBe("u1");
    expect(made.calendarIds).toEqual({ s1: true });
    expect(made.id).toBeUndefined();
    expect(made.baseEventId).toBeUndefined();
    // Then the original goes.
    const destroy = sets[1]!;
    expect(destroy.args.accountId).toBe("a1");
    expect(destroy.args.destroy).toEqual(["i"]);
    // And a fresh read of the stored event sat between them.
    const gets = calls.filter((c) => c.name === "CalendarEvent/get");
    expect(gets).toHaveLength(1);
    expect(gets[0]!.args.accountId).toBe("a1");
    expect(gets[0]!.args.ids).toEqual(["i"]);
  });

  it("applies the reader's edits on the source before re-filing", async () => {
    const calls = stubServer();
    await useCalendar
      .getState()
      .updateEvent(
        EVENT,
        { calendarIds: { s1: true }, title: "Renamed" },
        false,
        "series",
      );
    const sets = calls.filter((c) => c.name === "CalendarEvent/set");
    expect(sets).toHaveLength(3);
    // 1: the edit, where the event already is, with no calendar move in it.
    expect(sets[0]!.args.accountId).toBe("a1");
    const first = (sets[0]!.args.update as Record<string, Record<string, unknown>>).i!;
    expect(first.title).toBe("Renamed");
    expect(first.calendarIds).toBeUndefined();
    // 2 + 3: the re-file and the destroy.
    expect(sets[1]!.args.accountId).toBe("a2");
    expect(sets[2]!.args.destroy).toEqual(["i"]);
  });

  it("moves within the same account with a single update that names the calendar", async () => {
    const calls = stubServer();
    const dropped = await useCalendar
      .getState()
      .updateEvent(EVENT, { calendarIds: { c2: true } }, false, "series");
    expect(dropped).toEqual([]);
    const sets = calls.filter((c) => c.name === "CalendarEvent/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args.accountId).toBe("a1");
    const patch = (sets[0]!.args.update as Record<string, Record<string, unknown>>).i!;
    expect(patch.calendarIds).toEqual({ c2: true });
  });

  it("adds a shared calendar first when an event is created into one not yet added", async () => {
    setState(false); // s1 not subscribed
    const calls = stubServer();
    await useCalendar.getState().createEvent({ title: "Team sync" }, "s1", false);
    const calendarSets = calls.filter((c) => c.name === "Calendar/set");
    expect(calendarSets).toHaveLength(1);
    expect(calendarSets[0]!.args.accountId).toBe("a2");
    expect(calendarSets[0]!.args.update).toEqual({
      s1: { isSubscribed: true },
    });
    const eventSets = calls.filter((c) => c.name === "CalendarEvent/set");
    expect(eventSets[0]!.args.accountId).toBe("a2");
    const made = (eventSets[0]!.args.create as Record<string, Record<string, unknown>>)
      .e!;
    expect(made.calendarIds).toEqual({ s1: true });
  });

  it("does not write the subscription again for a calendar already added", async () => {
    setState(true); // s1 subscribed already
    const calls = stubServer();
    await useCalendar.getState().createEvent({ title: "Team sync" }, "s1", false);
    expect(calls.filter((c) => c.name === "Calendar/set")).toHaveLength(0);
    expect(calls.some((c) => c.name === "CalendarEvent/set")).toBe(true);
  });

  it("reads a shared master from the account that holds it", async () => {
    const calls = stubServer();
    const found = await useCalendar.getState().getEvent("i", "a2");
    expect(found?.id).toBe("i");
    const gets = calls.filter((c) => c.name === "CalendarEvent/get");
    expect(gets).toHaveLength(1);
    expect(gets[0]!.args.accountId).toBe("a2");
  });
});

describe("when two accounts hold a same-id calendar", () => {
  /* Calendar ids are unique only within an account, so the reader's own
     default and a group's default can both be "c1". Every write that picked a
     calendar has to say which account it meant, or the own one wins by
     default and the group calendar can never be aimed at. */
  const collide = () => {
    setState();
    useCalendar.setState({
      calendars: { c1: CALENDAR("c1") },
      sharedCalendars: [
        {
          accountId: "a2",
          accountName: "Team",
          calendar: { ...CALENDAR("c1"), name: "Team", isSubscribed: true },
        },
      ],
    });
  };

  it("creates into the account of the picked calendar, not the same-id own one", async () => {
    collide();
    const calls = stubServer();
    await useCalendar.getState().createEvent({ title: "Team sync" }, "c1", false, "a2");
    const sets = calls.filter((c) => c.name === "CalendarEvent/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args.accountId).toBe("a2");
    const made = (sets[0]!.args.create as Record<string, Record<string, unknown>>).e!;
    expect(made.calendarIds).toEqual({ c1: true });
  });

  it("moves an event to the same-id calendar of another account when told which", async () => {
    collide();
    const calls = stubServer();
    await useCalendar
      .getState()
      .updateEvent(
        EVENT,
        { calendarIds: { c1: true }, title: "Renamed" },
        false,
        "series",
        { accountId: "a1", moveTo: { accountId: "a2", calendarId: "c1" } },
      );
    const sets = calls.filter((c) => c.name === "CalendarEvent/set");
    // Edit on the source, re-file on the target, destroy the original.
    expect(sets[0]!.args.accountId).toBe("a1");
    const patch = (sets[0]!.args.update as Record<string, Record<string, unknown>>).i!;
    expect(patch.title).toBe("Renamed");
    expect(patch.calendarIds).toBeUndefined();
    expect(sets[1]!.args.accountId).toBe("a2");
    const made = (sets[1]!.args.create as Record<string, Record<string, unknown>>).e!;
    expect(made.uid).toBe("u1");
    expect(made.calendarIds).toEqual({ c1: true });
    expect(sets[2]!.args.destroy).toEqual(["i"]);
  });

  it("leaves the event alone when the picked pair is its own", async () => {
    collide();
    const calls = stubServer();
    const dropped = await useCalendar
      .getState()
      .updateEvent(
        EVENT,
        { calendarIds: { c1: true }, title: "Renamed" },
        false,
        "series",
        { accountId: "a1", moveTo: { accountId: "a1", calendarId: "c1" } },
      );
    expect(dropped).toEqual([]);
    const sets = calls.filter((c) => c.name === "CalendarEvent/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args.accountId).toBe("a1");
    const patch = (sets[0]!.args.update as Record<string, Record<string, unknown>>).i!;
    expect(patch.title).toBe("Renamed");
  });
});
