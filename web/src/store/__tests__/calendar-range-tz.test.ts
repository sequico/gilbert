import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, JmapSession } from "@/jmap/types";
import { dateToZonedLocal, toLocalDateTime } from "@/lib/dates";
import { useCalendar } from "@/store/calendar";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/*
 * Calendar range queries were sent with `after`/`before` formatted in the
 * browser frame while the filter carried the settings `timeZone`. Stalwart
 * reads those bounds as wall-clock text in that zone, so when the settings
 * zone and the browser disagree, the server compared the wrong instants and
 * the events in the first and last |offset| hours of the visible window were
 * never fetched. These tests pin that the bounds are written as the zone the
 * server is told about — which is exactly `dateToZonedLocal` in that zone.
 */

const CALENDAR = (id: string) =>
  ({
    id,
    name: id,
    myRights: { mayWriteAll: true },
    isSubscribed: true,
    isDefault: false,
  }) as unknown as Calendar;

/** A window of instants whose text differs between the browser and a real zone. */
const START = new Date("2026-09-04T22:30:00Z");
const END = new Date("2026-09-11T22:30:00Z");

/** A timezone whose wall clock at START differs from the browser frame's. */
const ZONES = [
  "Pacific/Kiritimati",
  "Pacific/Marquesas",
  "Asia/Tokyo",
  "America/New_York",
  "Europe/Berlin",
];
const tz =
  ZONES.find((z) => dateToZonedLocal(START, z) !== toLocalDateTime(START)) ??
  "Pacific/Kiritimati";

function stubServer() {
  const queries: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses: unknown[] = [];
      for (const [name, args, id] of body.methodCalls) {
        if (name === "CalendarEvent/query") {
          queries.push(args);
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              queryState: "q",
              ids: [],
              position: (args.position as number) ?? 0,
              total: 0,
              canCalculateChanges: false,
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
  return queries;
}

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
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, timeZone: tz } });
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: { c1: CALENDAR("c1") },
    events: {},
    ranges: {},
    loading: false,
    error: null,
    hidden: {},
    sharedCalendars: [
      {
        accountId: "a2",
        accountName: "Team",
        calendar: { ...CALENDAR("s1"), isSubscribed: true },
      },
    ],
    sharedEvents: {},
    sharedRanges: {},
    identities: [],
  });
});

afterEach(() => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useCalendar.setState({ ranges: {}, sharedRanges: {} });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("calendar range query bounds follow the zone the server is told", () => {
  it("asks the own-account window in the settings zone's clock", async () => {
    const queries = stubServer();
    await useCalendar.getState().loadRange(START, END);
    const q = queries[0]!;
    expect(q.accountId).toBe("a1");
    expect(q.timeZone).toBe(tz);
    expect(q.filter).toEqual({
      after: dateToZonedLocal(START, tz),
      before: dateToZonedLocal(END, tz),
    });
    // The point of the fix: the browser frame's text for the same instants is
    // different, and sending that under `timeZone: tz` moved the window.
    expect(q.filter).not.toEqual({
      after: toLocalDateTime(START),
      before: toLocalDateTime(END),
    });
  });

  it("asks the shared window in the settings zone's clock", async () => {
    const queries = stubServer();
    await useCalendar.getState().loadSharedRange(START, END);
    const q = queries[0]!;
    expect(q.accountId).toBe("a2");
    expect(q.timeZone).toBe(tz);
    expect(q.filter).toEqual({
      after: dateToZonedLocal(START, tz),
      before: dateToZonedLocal(END, tz),
    });
  });
});
