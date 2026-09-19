import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { useSession } from "@/store/session";
import { fakeJmapServer } from "@/test/jmapServer";

/**
 * Shared calendars follow the session's non-personal accounts.
 *
 * When the set of those accounts changes the store re-asks -- including when
 * it shrinks to nothing: a revoke, or the reader leaving the team, must take
 * the group's calendars and events off screen, not leave them cached until
 * the next sign-in. A sign-out clears the same state outright, so the next
 * reader on a shared machine never sees the previous one's shared content.
 */

const CAL = (id: string) =>
  ({
    id,
    name: id,
    description: null,
    isSubscribed: false,
    myRights: { mayWriteAll: true },
  }) as unknown as Calendar;

function sessionWith(accountIds: string[]) {
  const accounts: Record<string, unknown> = {};
  for (const id of accountIds)
    accounts[id] = {
      name: `${id}@example.org`,
      isPersonal: id === "a1",
      isReadOnly: false,
      accountCapabilities: { [CAP.calendars]: {} },
    };
  return {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.calendars]: {},
    },
    accounts,
    primaryAccounts: { [CAP.calendars]: "a1" },
    state: "s1",
  } as unknown as JmapSession;
}

/** A server that answers the envelope and nothing else; see `@/test/jmapServer`. */
function stubServer() {
  return fakeJmapServer();
}

const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
  client.session = null;
  // Anonymous first: the store's session subscriber resets everything.
  useSession.setState({
    status: "anonymous",
    session: null,
    accountId: null,
    error: null,
  });
  useCalendar.setState({
    accountId: null,
    available: true,
    calendars: {},
    sharedCalendars: [],
    sharedEvents: {},
    sharedRanges: {},
    events: {},
    ranges: {},
    identities: [],
    hidden: {},
  });
  await flush();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared calendars across session changes", () => {
  it("clears shared calendars and events when every shared account is gone", async () => {
    const srv = stubServer();
    useCalendar.setState({
      accountId: "a1",
      sharedCalendars: [{ accountId: "a2", accountName: "team", calendar: CAL("gc1") }],
      sharedEvents: { "a2/e1": { id: "e1" } as never },
      sharedRanges: { "0|1": ["a2/e1"] },
    });
    // Sign-in with own account plus the team account.
    useSession.setState({
      status: "authenticated",
      session: sessionWith(["a1", "a2"]),
      accountId: "a1",
      error: null,
    });
    await flush();
    // The session is refreshed with the team account gone (a revoke).
    useSession.setState({
      status: "authenticated",
      session: sessionWith(["a1"]),
      accountId: "a1",
      error: null,
    });
    await flush();
    expect(useCalendar.getState().sharedCalendars).toEqual([]);
    expect(useCalendar.getState().sharedEvents).toEqual({});
    expect(useCalendar.getState().sharedRanges).toEqual({});
    // The clearing went through a Calendar/get round, not a silent local drop.
    expect(srv.calls.some((c) => c.method === "Calendar/get")).toBe(false);
  });

  it("drops all shared state on sign-out", async () => {
    useCalendar.setState({
      accountId: "a1",
      sharedCalendars: [{ accountId: "a2", accountName: "team", calendar: CAL("gc1") }],
      sharedEvents: { "a2/e1": { id: "e1" } as never },
      sharedRanges: { "0|1": ["a2/e1"] },
    });
    useSession.setState({
      status: "authenticated",
      session: sessionWith(["a1", "a2"]),
      accountId: "a1",
      error: null,
    });
    await flush();
    useSession.setState({
      status: "anonymous",
      session: null,
      accountId: null,
      error: null,
    });
    await flush();
    expect(useCalendar.getState().sharedCalendars).toEqual([]);
    expect(useCalendar.getState().sharedEvents).toEqual({});
    expect(useCalendar.getState().sharedRanges).toEqual({});
  });
});
