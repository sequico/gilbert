import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, CalendarEvent, JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";

/**
 * A task *is* a `CalendarEvent` in a task-list calendar, so the grid has to
 * recognise one to leave it alone — and the sidebar draws no row for such a
 * calendar, so a task it drew would appear with nothing to explain where it
 * came from, looking like an ordinary event of the reader's own.
 *
 * `@type` is what tells them apart, and it has to be asked for: `EVENT_PROPS`
 * without it gets objects without it from a server that honours `properties`,
 * and the check then never fires — a task carrying a `start` (JSCalendar turns
 * a task's `due` into one) drawn as an event.
 *
 * The stub filters like a conforming server: what was not asked for is not
 * returned. That is the whole point of the pair of tests below — the first
 * pins the property being asked for, the second pins the answer that does not
 * depend on the server returning it at all.
 */

const TASK = {
  id: "x1",
  "@type": "Task",
  uid: "x1",
  title: "Prepare the shipping manifest",
  progress: "in-process",
  calendarIds: { t1: true },
  // A task's `due` reaches the wire as a `start`, which is why a task is an
  // instance the grid can build at all.
  start: "2026-09-15T09:00:00",
  timeZone: "UTC",
} as unknown as CalendarEvent;

const EVENT = {
  id: "e1",
  "@type": "Event",
  uid: "e1",
  title: "Team sync",
  calendarIds: { c1: true },
  start: "2026-09-15T11:00:00",
  duration: "PT45M",
  timeZone: "UTC",
} as unknown as CalendarEvent;

const calendar = (id: string, name: string, description: string | null) =>
  ({
    id,
    name,
    description,
    color: "#0f766e",
    sortOrder: 0,
    isSubscribed: true,
    isVisible: true,
    isDefault: true,
    includeInAvailability: "all",
    timeZone: "UTC",
    myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true },
    shareWith: {},
  }) as unknown as Calendar;

/** `properties` is answered the way the server answers it: named keys only. */
const pick = (o: Record<string, unknown>, props: string[]) =>
  Object.fromEntries(props.filter((p) => p in o).map((p) => [p, o[p]]));

function stubServer(events: CalendarEvent[], opts: { alwaysDropType?: boolean } = {}) {
  /** What the read asked for, which is what the server may return. */
  const asked: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses: unknown[] = [];
      for (const [name, args, id] of body.methodCalls) {
        if (name === "CalendarEvent/query")
          methodResponses.push([
            name,
            { accountId: args.accountId, ids: events.map((e) => e.id) },
            id,
          ]);
        else if (name === "CalendarEvent/get") {
          const props = (args.properties as string[] | undefined) ?? [];
          asked.push(props);
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              list: events.map((e) => {
                const raw = e as unknown as Record<string, unknown>;
                return opts.alwaysDropType
                  ? pick(
                      raw,
                      props.filter((p) => p !== "@type"),
                    )
                  : pick(raw, props);
              }),
              notFound: [],
            },
            id,
          ]);
        } else
          methodResponses.push([
            name,
            { accountId: args.accountId, list: [], notFound: [] },
            id,
          ]);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ methodResponses, sessionState: "1" }),
      } as Response;
    }),
  );
  return asked;
}

const FROM = new Date("2026-09-15T00:00:00Z");
const TO = new Date("2026-09-16T00:00:00Z");

describe("a task is not an event on the grid", () => {
  beforeEach(() => {
    client.session = {
      capabilities: { [CAP.core]: {}, [CAP.calendars]: {} },
      accounts: {},
      primaryAccounts: {},
      state: "s1",
    } as unknown as JmapSession;
    useCalendar.setState({
      accountId: "a1",
      calendars: {
        t1: calendar("t1", "Freight tasks", "tasklist"),
        c1: calendar("c1", "Personal", null),
      },
      events: {},
      ranges: {},
      sharedCalendars: [],
      sharedEvents: {},
      sharedRanges: {},
      hidden: {},
      identities: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const load = async () => {
    await useCalendar.getState().loadRange(FROM, TO, true);
    return useCalendar.getState().instancesIn(FROM, TO);
  };

  it("asks the server for the property it recognises one by", async () => {
    const asked = stubServer([TASK]);
    expect(await load()).toHaveLength(0);
    expect(asked[0]).toContain("@type");
  });

  it("leaves it out even from a server that never returns the type", async () => {
    stubServer([TASK], { alwaysDropType: true });
    expect(await load()).toHaveLength(0);
  });

  it("still draws an event in an ordinary calendar", async () => {
    // The guard must not become "nothing is drawn": the same window, the same
    // read, one ordinary event.
    stubServer([EVENT]);
    const drawn = await load();
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.event.title).toBe("Team sync");
  });
});
