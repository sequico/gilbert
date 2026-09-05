import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { taskListKey, useTasks } from "@/store/tasks";

/**
 * A task list is a calendar marked `tasklist`, and its key is the account and
 * the calendar together — a calendar id is only unique within its account, so
 * the reader's own list and a group's can both be "t1". Selection must stay
 * with the list the reader picked, not snap to whichever same-id list comes
 * first; these tests pin that.
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
        if (name === "CalendarEvent/query") {
          methodResponses.push([
            name,
            { accountId: args.accountId, queryState: "1", ids: [] },
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
  /* The reader's own list and the group's share the id "t1", the way a real
     server numbers calendars per account. */
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: { t1: TASKLIST("t1") },
    sharedCalendars: [
      {
        accountId: "a2",
        accountName: "Team",
        calendar: { ...TASKLIST("t1"), name: "Team tasks" },
      },
    ],
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

describe("task lists whose calendar id collides across accounts", () => {
  it("lists the own and the group list as two distinct entries", async () => {
    stubServer();
    await useTasks.getState().load();
    const lists = useTasks.getState().lists;
    expect(lists).toHaveLength(2);
    expect(lists.map((l) => taskListKey(l.accountId, l.calendarId))).toEqual([
      "a1/t1",
      "a2/t1",
    ]);
    // The default selection is the first list, keyed with its account.
    expect(useTasks.getState().selectedListId).toBe("a1/t1");
  });

  it("keeps the group list selected across a reload instead of snapping to the own one", async () => {
    stubServer();
    await useTasks.getState().load();
    useTasks.getState().select("a2/t1");
    await useTasks.getState().load();
    expect(useTasks.getState().selectedListId).toBe("a2/t1");
  });
});
