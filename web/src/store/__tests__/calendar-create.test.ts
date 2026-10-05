import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { fakeJmapServer } from "@/test/jmapServer";

/**
 * A calendar the reader creates must be created subscribed. Stalwart leaves a
 * new calendar unsubscribed unless the create says otherwise, so a client that
 * omits the flag ends up with its own fresh calendar invisible to every client
 * that honours `isSubscribed`. This pin keeps the flag in the create payload.
 */

function stubServer() {
  return fakeJmapServer().on("Calendar/set", ({ args }) => {
    const created: Record<string, unknown> = {};
    for (const k of Object.keys((args.create as Record<string, unknown>) ?? {}))
      created[k] = { id: `n${k}` };
    return {
      accountId: args.accountId,
      state: "1",
      created,
      updated: {},
      destroyed: [],
      notCreated: {},
      notUpdated: {},
      notDestroyed: {},
    };
  });
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("creating a plain calendar", () => {
  it("creates the calendar subscribed, so the reader keeps it", async () => {
    const calls = stubServer().calls;
    const id = await useCalendar.getState().createCalendar({ name: "Holidays" });
    expect(id).toBe("nc");
    const set = calls.find((c) => c.method === "Calendar/set");
    expect(set?.args.accountId).toBe("a1");
    expect(set?.args.create).toEqual({
      c: { name: "Holidays", isSubscribed: true },
    });
  });
});
