import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, CalendarEvent, JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";

/**
 * A write (or a push) must never flash an empty grid over content that is
 * already on screen: the loaded windows stay until the fresh answer lands,
 * and the global loading flag does not turn on for a window that already
 * has data (stale-while-revalidate).
 */

const EVENT: CalendarEvent = {
  id: "e1",
  "@type": "Event",
  uid: "u1",
  calendarIds: { c1: true },
  title: "Standup",
  start: "2026-09-04T09:00:00",
  utcStart: "2026-09-04T07:00:00Z",
  utcEnd: "2026-09-04T07:30:00Z",
  duration: "PT30M",
} as unknown as CalendarEvent;

const CALENDAR = {
  id: "c1",
  name: "Work",
  myRights: { mayWriteAll: true },
  isSubscribed: true,
  isDefault: false,
} as unknown as Calendar;

const WINDOW_START = new Date("2026-09-01T00:00:00").getTime();
const WINDOW_END = new Date("2026-10-01T00:00:00").getTime();
const KEY = `${WINDOW_START}|${WINDOW_END}`;

/** A server whose refresh query waits until the test releases it. */
function stubServer() {
  let releaseRefresh: (() => void) | null = null;
  let refreshCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses: unknown[] = [];
      for (const [name, args, id] of body.methodCalls) {
        if (name === "CalendarEvent/query") {
          methodResponses.push([
            name,
            { accountId: args.accountId, state: "2", ids: ["e1"], notFound: [] },
            id,
          ]);
        } else if (name === "CalendarEvent/get") {
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "2",
              list: [{ ...EVENT, start: "2026-09-05T09:00:00" }],
              notFound: [],
            },
            id,
          ]);
        } else if (name === "CalendarEvent/set") {
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "2",
              created: {},
              updated: Object.fromEntries(
                Object.keys((args.update as Record<string, unknown>) ?? {}).map((k) => [
                  k,
                  null,
                ]),
              ),
              destroyed: args.destroy ?? [],
              notCreated: {},
              notUpdated: {},
              notDestroyed: {},
            },
            id,
          ]);
        }
      }
      // The refresh (query) is held until the test has checked the state in
      // between; everything else resolves at once.
      const respond = () =>
        ({ ok: true, status: 200, json: async () => ({ methodResponses }) }) as Response;
      if (body.methodCalls.some(([n]) => n === "CalendarEvent/query")) {
        refreshCount++;
        return await new Promise<Response>((resolve) => {
          releaseRefresh = () => resolve(respond());
        });
      }
      return respond();
    }),
  );
  return {
    holdRefresh: async () => {
      await vi.waitFor(() => expect(refreshCount).toBeGreaterThan(0));
      return () => releaseRefresh?.();
    },
  };
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
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: { c1: CALENDAR },
    sharedCalendars: [],
    events: { e1: EVENT },
    ranges: { [KEY]: ["e1"] },
    loading: false,
    error: null,
    sharedEvents: {},
    sharedRanges: {},
    identities: [],
    hidden: {},
    subscriptionEvents: {},
    subscriptionErrors: {},
    subscriptionsLoading: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("calendar writes do not clear what is on screen", () => {
  it("keeps the loaded window and the spinner off while a write refreshes it", async () => {
    const server = stubServer();

    const saving = useCalendar
      .getState()
      .updateEvent(EVENT, { start: "2026-09-05T09:00:00" }, false, "series");
    const release = await server.holdRefresh();

    // The write answered; the background refresh of the loaded window is
    // still in flight. The window must still be there and loading must not
    // have flashed on: content that is on screen stays on screen.
    const state = useCalendar.getState();
    expect(state.ranges[KEY]).toEqual(["e1"]);
    expect(state.loading).toBe(false);

    release();
    await saving;
  });

  it("repopulates the window from the fresh answer once it lands", async () => {
    const server = stubServer();

    const saving = useCalendar
      .getState()
      .updateEvent(EVENT, { start: "2026-09-05T09:00:00" }, false, "series");
    const release = await server.holdRefresh();
    release();
    await saving;

    // The refresh is fire-and-forget: wait for the fresh answer to land.
    await vi.waitFor(() =>
      expect(useCalendar.getState().events.e1?.start).toBe("2026-09-05T09:00:00"),
    );
    const state = useCalendar.getState();
    expect(state.ranges[KEY]).toEqual(["e1"]);
    expect(state.loading).toBe(false);
  });
});

describe("calendar writes apply the optimistic copy synchronously", () => {
  let resolveSet: (() => void) | null = null;

  /** A server whose CalendarEvent/set is held until the test releases it. */
  const holdSet = () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          methodCalls: [string, Record<string, unknown>, string][];
        };
        const methodResponses: unknown[] = [];
        for (const [name, args, id] of body.methodCalls) {
          if (name === "CalendarEvent/set") {
            methodResponses.push([
              name,
              {
                accountId: args.accountId,
                state: "2",
                created: {},
                updated: Object.fromEntries(
                  Object.keys((args.update as Record<string, unknown>) ?? {}).map((k) => [
                    k,
                    null,
                  ]),
                ),
                notUpdated: {},
                notDestroyed: {},
              },
              id,
            ]);
          } else if (name === "CalendarEvent/query") {
            methodResponses.push([name, { accountId: args.accountId, ids: ["e1"] }, id]);
          } else {
            methodResponses.push([
              name,
              { accountId: args.accountId, list: [EVENT] },
              id,
            ]);
          }
        }
        if (body.methodCalls.some(([n]) => n === "CalendarEvent/set"))
          return await new Promise<Response>((resolve) => {
            resolveSet = () =>
              resolve({
                ok: true,
                status: 200,
                json: async () => ({ methodResponses }),
              } as Response);
          });
        return {
          ok: true,
          status: 200,
          json: async () => ({ methodResponses }),
        } as Response;
      }),
    );
  };

  beforeEach(() => {
    useCalendar.setState({
      accountId: "a1",
      available: true,
      calendars: { c1: CALENDAR },
      sharedCalendars: [],
      events: { e1: { ...EVENT, start: "2026-09-04T09:00:00" } },
      ranges: { [KEY]: ["e1"] },
      loading: false,
      error: null,
      sharedEvents: {},
      sharedRanges: {},
      identities: [],
      hidden: {},
      subscriptionEvents: {},
      subscriptionErrors: {},
      subscriptionsLoading: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resolveSet = null;
  });

  it("shows the new position before the server answers", async () => {
    holdSet();
    const saving = useCalendar
      .getState()
      .updateEvent(EVENT, { start: "2026-09-05T09:00:00" }, false, "series");
    // Synchronous: no await separates the drop from the optimistic copy, so
    // the chip never snaps back to its old slot.
    expect(useCalendar.getState().events.e1?.start).toBe("2026-09-05T09:00:00");
    // The set request starts on the next microtask; release it once in flight.
    await vi.waitFor(() => expect(resolveSet).not.toBeNull());
    resolveSet?.();
    await saving;
  });

  it("restores the old copy when the server refuses the write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          methodCalls: [string, Record<string, unknown>, string][];
        };
        const methodResponses: unknown[] = [];
        for (const [name, args, id] of body.methodCalls) {
          if (name === "CalendarEvent/set")
            methodResponses.push([
              name,
              {
                accountId: args.accountId,
                notUpdated: { e1: { type: "invalidProperties" } },
              },
              id,
            ]);
          else if (name === "CalendarEvent/query")
            methodResponses.push([name, { accountId: args.accountId, ids: ["e1"] }, id]);
          else
            methodResponses.push([
              name,
              { accountId: args.accountId, list: [EVENT] },
              id,
            ]);
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ methodResponses }),
        } as Response;
      }),
    );
    await expect(
      useCalendar
        .getState()
        .updateEvent(EVENT, { start: "2026-09-05T09:00:00" }, false, "series"),
    ).rejects.toThrow();
    expect(useCalendar.getState().events.e1?.start).toBe("2026-09-04T09:00:00");
  });
});
