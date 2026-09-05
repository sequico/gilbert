import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { useTasks } from "@/store/tasks";

/**
 * A calendar the reader creates — a task list or a plain calendar — must be
 * created subscribed. Stalwart leaves a new calendar unsubscribed unless the
 * create says otherwise, so a client that omits the flag ends up with its own
 * fresh calendar invisible to every client that honours `isSubscribed`. These
 * pins keep the flag in both create payloads.
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
          const created: Record<string, unknown> = {};
          for (const k of Object.keys((args.create as Record<string, unknown>) ?? {}))
            created[k] = { id: `n${k}` };
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              created,
              updated: {},
              destroyed: [],
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

describe("creating a task list", () => {
  it("creates the tasklist calendar subscribed, so the reader keeps it", async () => {
    const calls = stubServer();
    const id = await useTasks.getState().createList("Grocery");
    expect(id).toBe("nc");
    const set = calls.find((c) => c.name === "Calendar/set");
    expect(set?.args.accountId).toBe("a1");
    expect(set?.args.create).toEqual({
      c: { name: "Grocery", description: "tasklist", isSubscribed: true },
    });
  });
});

describe("creating a plain calendar", () => {
  it("creates the calendar subscribed, the same way a task list is", async () => {
    const calls = stubServer();
    const id = await useCalendar.getState().createCalendar({ name: "Holidays" });
    expect(id).toBe("nc");
    const set = calls.find((c) => c.name === "Calendar/set");
    expect(set?.args.accountId).toBe("a1");
    expect(set?.args.create).toEqual({
      c: { name: "Holidays", isSubscribed: true },
    });
  });
});
