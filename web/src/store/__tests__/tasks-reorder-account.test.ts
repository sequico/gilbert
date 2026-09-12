import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession, TaskItem } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { type TaskList, useTasks } from "@/store/tasks";

/**
 * Manual order is written as `order-N` keywords in one CalendarEvent/set
 * aimed at one task list. Both the list and the tasks are addressed by ids
 * that are unique only within their account: the reader's own calendar and a
 * group's can carry the same calendar id, and their tasks the same task id.
 * Matching on the bare ids picked whichever object came first in the store,
 * so a drag in a group list could renumber the reader's own tasks (or name a
 * task of another account in the group's set).
 *
 * The store holds tasks under an account-qualified key for exactly this
 * reason; these pin that the reorder uses it.
 */

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
        methodResponses.push([
          name,
          {
            accountId: args.accountId,
            state: "1",
            list: [],
            created: {},
            updated: {},
            destroyed: {},
            notCreated: {},
            notUpdated: {},
            notDestroyed: {},
          },
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
  return calls;
}

const task = (over: Partial<TaskItem> & { id: string }): TaskItem =>
  ({
    "@type": "Task",
    title: "t",
    progress: "needs-action",
    calendarIds: {},
    ...over,
  }) as TaskItem;

/** A group task list whose calendar id and task ids are also the reader's. */
const GROUP: TaskList = {
  accountId: "a2",
  accountName: "team@example.org",
  calendarId: "c1",
  name: "Team chores",
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
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: {},
    sharedCalendars: [],
    events: {},
    ranges: {},
    hidden: {},
    sharedEvents: {},
    sharedRanges: {},
    identities: [],
  });
  useTasks.setState({
    accountId: "a1",
    lists: [],
    tasks: {},
    loaded: true,
    selectedListId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("renumbering a group's task list", () => {
  it("takes the keywords off the group's task, not the reader's task of the same id", async () => {
    const calls = stubServer();
    useTasks.setState({
      // Both accounts hold a task with the id "t1" in a calendar with the id
      // "c1", and the reader's own one comes last: a bare-id map keeps the
      // last writer, so the group list was renumbered from the wrong object.
      tasks: {
        "a2/t1": task({
          id: "t1",
          calendarIds: { c1: true },
          keywords: { "order-9": true, keep: true },
        }),
        "a1/t1": task({
          id: "t1",
          calendarIds: { c1: true },
          keywords: { "order-9": true },
        }),
      },
    });
    await useTasks.getState().reorder(GROUP, ["t1"]);
    const set = calls.find((c) => c.name === "CalendarEvent/set");
    expect(set?.args.accountId).toBe("a2");
    expect(set?.args.update).toEqual({
      t1: { keywords: { "order-9": false, keep: true, "order-0": true } },
    });
  });

  it("names no other account's task in the set aimed at the group's account", async () => {
    const calls = stubServer();
    useTasks.setState({
      tasks: {
        "a1/own1": task({
          id: "own1",
          calendarIds: { c1: true },
          keywords: { "order-4": true },
        }),
        "a2/t1": task({ id: "t1", calendarIds: { c1: true } }),
      },
    });
    // "own1" is the reader's own task, in their own calendar that happens to
    // share the group list's calendar id: there is nothing here to renumber.
    await useTasks.getState().reorder(GROUP, ["own1"]);
    expect(calls.filter((c) => c.name === "CalendarEvent/set")).toEqual([]);
  });
});
