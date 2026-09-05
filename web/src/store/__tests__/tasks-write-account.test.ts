import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, JmapSession, TaskItem } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { type TaskList, useTasks } from "@/store/tasks";

/**
 * A write to a task is aimed by the list the reader is acting on. A task id,
 * like a calendar id, is only unique within its account, so the same id can
 * name a task in the reader's own list and one in a group's; a lookup that
 * scans across accounts for the bare id would pick whichever entry came
 * first -- usually the reader's own -- and complete or delete the wrong task.
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

const TASK = (id: string, calendarId: string) =>
  ({
    id,
    "@type": "Task",
    title: `task ${id}`,
    progress: "needs-action",
    calendarIds: { [calendarId]: true },
  }) as unknown as TaskItem;

const OWN_LIST: TaskList = { accountId: "a1", calendarId: "t1", name: "Tasks" };
const GROUP_LIST: TaskList = {
  accountId: "a2",
  accountName: "Team",
  calendarId: "t1",
  name: "Team tasks",
};

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
        if (name === "CalendarEvent/set") {
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              created: {},
              updated: {},
              destroyed: [],
              notCreated: {},
              notUpdated: {},
              notDestroyed: {},
            },
            id,
          ]);
        } else {
          // Query and get answer empty, so the post-write reload settles.
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
  /* The reader's own list and the group's share the calendar id "t1", and
     both hold a task that is also id "X" -- the per-account numbering a real
     server uses. */
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
    accountId: "a1",
    lists: [OWN_LIST, GROUP_LIST],
    tasks: {
      "a1/X": TASK("X", "t1"),
      "a2/X": TASK("X", "t1"),
    },
    loaded: true,
    selectedListId: "a2/t1",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("task writes route by the list's account", () => {
  it("completes the group task on the group account when ids collide", async () => {
    const calls = stubServer();
    const groupTask = useTasks.getState().tasks["a2/X"]!;
    await useTasks.getState().setDone(GROUP_LIST, groupTask, true);
    const set = calls.find((c) => c.name === "CalendarEvent/set");
    expect(set?.args.accountId).toBe("a2");
    expect(set?.args.update).toEqual({
      X: { progress: "completed", percentComplete: 100 },
    });
  });

  it("deletes the group task on the group account when ids collide", async () => {
    const calls = stubServer();
    const groupTask = useTasks.getState().tasks["a2/X"]!;
    await useTasks.getState().destroy(GROUP_LIST, groupTask);
    const set = calls.find((c) => c.name === "CalendarEvent/set");
    expect(set?.args.accountId).toBe("a2");
    expect(set?.args.destroy).toEqual(["X"]);
  });

  it("renames the own task on the own account", async () => {
    const calls = stubServer();
    const ownTask = useTasks.getState().tasks["a1/X"]!;
    await useTasks.getState().update(OWN_LIST, ownTask, { title: "renamed" });
    const set = calls.find((c) => c.name === "CalendarEvent/set");
    expect(set?.args.accountId).toBe("a1");
    expect(set?.args.update).toEqual({ X: { title: "renamed" } });
  });
});
