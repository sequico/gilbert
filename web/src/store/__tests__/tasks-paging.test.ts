import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, JmapSession, TaskItem } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { useTasks } from "@/store/tasks";

/*
 * A list's tasks were fetched with a single CalendarEvent/query capped at 1000
 * ids, so a list bigger than that silently lost its tail: open tasks past the
 * first thousand were invisible and `reorder()`'s keyword writes could not
 * describe them. The query is now paged on `position` the way the calendar and
 * contacts scans are; this test pins that every page is asked for and filed.
 */

const TASKLIST = (id: string) =>
  ({
    id,
    name: id,
    description: "tasklist",
    myRights: { mayWriteAll: true },
    isSubscribed: true,
    isDefault: false,
  }) as unknown as Calendar;

/** A server holding `n` tasks in the own list, paging query answers honestly. */
function stubServer(n: number) {
  const queries: Array<Record<string, unknown>> = [];
  const ids = Array.from({ length: n }, (_, i) => `t${i}`);
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
          const position = (args.position as number) ?? 0;
          const limit = (args.limit as number) ?? 1000;
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              queryState: "q",
              ids: ids.slice(position, position + limit),
              position,
              total: ids.length,
              canCalculateChanges: false,
            },
            id,
          ]);
        } else if (name === "CalendarEvent/get") {
          const got = (args.ids as string[]) ?? [];
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              list: got.map(
                (x) =>
                  ({
                    id: x,
                    "@type": "Task",
                    title: `task ${x}`,
                    progress: "needs-action",
                    calendarIds: { t1: true },
                  }) as unknown as TaskItem,
              ),
              notFound: [],
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
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: { t1: TASKLIST("t1") },
    sharedCalendars: [],
    events: {},
    ranges: {},
    hidden: {},
    sharedEvents: {},
    sharedRanges: {},
    identities: [],
  });
  useTasks.setState({
    accountId: null,
    lists: [],
    tasks: {},
    loaded: false,
    selectedListId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loading a task list with more tasks than one query page holds", () => {
  it("pages through the whole list instead of stopping at the first 1000", async () => {
    const queries = stubServer(2500);
    await useTasks.getState().load();
    expect(Object.keys(useTasks.getState().tasks)).toHaveLength(2500);
    // The tail is there, not just the first thousand.
    expect(useTasks.getState().tasks["a1/t0"]?.id).toBe("t0");
    expect(useTasks.getState().tasks["a1/t2499"]?.id).toBe("t2499");
    // Asked page by page: 0, 1000, 2000 -- and stopped at the total.
    const positions = queries
      .filter((q) => (q.filter as { inCalendar?: string }).inCalendar === "t1")
      .map((q) => q.position);
    expect(positions).toEqual([0, 1000, 2000]);
  });

  it("makes no extra round trips for a list that fits one page", async () => {
    const queries = stubServer(3);
    await useTasks.getState().load();
    expect(Object.keys(useTasks.getState().tasks)).toHaveLength(3);
    const positions = queries
      .filter((q) => (q.filter as { inCalendar?: string }).inCalendar === "t1")
      .map((q) => q.position);
    expect(positions).toEqual([0]);
  });
});
