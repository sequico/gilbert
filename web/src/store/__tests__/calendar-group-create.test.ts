import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";

/**
 * A calendar made while acting for a group must be created in the group's
 * own account: that is what makes the group the owner. Creating it on the
 * reader's account and sharing it would leave the group depending on a share
 * that has to be maintained, and a member added later would have to be
 * patched in by hand -- the calendar would not just belong to the group.
 * These pins keep the create on the group account, subscribed so members see
 * it, with no shareWith in the payload.
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("creating a calendar", () => {
  it("creates a group calendar in the group's own account, subscribed and unshared", async () => {
    const calls = stubServer();
    const id = await useCalendar
      .getState()
      .createCalendar({ name: "Ops", color: "#0f766e" }, "a2");
    expect(id).toBe("nc");
    const sets = calls.filter((c) => c.name === "Calendar/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args.accountId).toBe("a2");
    expect(sets[0]?.args.create).toEqual({
      c: { name: "Ops", color: "#0f766e", isSubscribed: true },
    });
  });

  it("creates the reader's own calendar in their own account", async () => {
    const calls = stubServer();
    await useCalendar.getState().createCalendar({ name: "Home" });
    const sets = calls.filter((c) => c.name === "Calendar/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args.accountId).toBe("a1");
    expect(sets[0]?.args.create).toEqual({
      c: { name: "Home", isSubscribed: true },
    });
  });
});
