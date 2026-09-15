import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { type TaskList, useTasks } from "@/store/tasks";

/**
 * Group task lists are created lazily and destroyed with their calendar: a
 * list *is* a tasklist-marked calendar in the group account, so the group's
 * first list and its tasklist calendar are the same object. Pressing "+" on a
 * group that has no list writes one calendar into that account; deleting the
 * last list destroys it, leaving nothing behind in Stalwart.
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
        if (name === "Calendar/set") {
          const createdKeys = Object.keys(
            (args.create as Record<string, unknown> | undefined) ?? {},
          );
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              created: Object.fromEntries(createdKeys.map((k) => [k, { id: "nc" }])),
              updated: {},
              destroyed: (args.destroy as string[] | undefined) ?? [],
              notCreated: {},
              notUpdated: {},
              notDestroyed: {},
            },
            id,
          ]);
        } else if (name === "Principal/query") {
          // A directory that would happily name the group's principal: what
          // must not happen is the share, not the lookup failing.
          methodResponses.push([
            name,
            { accountId: args.accountId, state: "1", ids: ["p1"], notFound: [] },
            id,
          ]);
        } else if (name === "Principal/get") {
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              list: [{ id: "p1", name: "team@example.org", email: "team@example.org" }],
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

describe("task lists in a group account", () => {
  it("creates the group's first list as a tasklist calendar in the group account", async () => {
    const calls = stubServer();
    const id = await useTasks.getState().createList("a2", "Team chores");
    expect(id).toBe("nc");
    const set = calls.find((c) => c.name === "Calendar/set");
    expect(set?.args.accountId).toBe("a2");
    expect(set?.args.create).toEqual({
      c: { name: "Team chores", description: "tasklist", isSubscribed: true },
    });
  });

  it("deletes a group list by destroying its calendar in the group account", async () => {
    const calls = stubServer();
    const list: TaskList = {
      accountId: "a2",
      accountName: "team@example.org",
      calendarId: "gt1",
      name: "Team chores",
    };
    await useTasks.getState().destroyList(list);
    const set = calls.find((c) => c.name === "Calendar/set");
    expect(set?.args.accountId).toBe("a2");
    expect(set?.args.destroy).toEqual(["gt1"]);
    expect(set?.args.onDestroyRemoveEvents).toBe(true);
  });

  it("writes no shareWith back to the group's principal: the account is the grant", async () => {
    const calls = stubServer();
    await useTasks.getState().createList("a2", "Team chores");
    // A list created in the group account is the group's -- reached by every
    // member through their session on it. Naming the owning principal and
    // granting it write rights is the per-object ACL the group law forbids,
    // and a directory that answers the query is exactly how it would happen.
    expect(calls.some((c) => c.name === "Principal/query")).toBe(false);
    expect(calls.some((c) => c.name === "Principal/get")).toBe(false);
    const sets = calls.filter((c) => c.name === "Calendar/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args.accountId).toBe("a2");
    expect(sets[0]?.args).not.toHaveProperty("update");
  });
});
