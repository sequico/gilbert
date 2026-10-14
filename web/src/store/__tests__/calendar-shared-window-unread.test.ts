import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, CalendarEvent, JmapSession } from "@/jmap/types";
import { setDeviceTrusted } from "@/lib/storage";
import { useCalendar } from "@/store/calendar";
import { useSession } from "@/store/session";

/**
 * A shared account whose window cannot be read keeps the events it had.
 *
 * The sibling mechanism is `loadSharedCalendars` (`calendar-shared-unread`),
 * which keeps a calendar list whose account failed; this is the same promise
 * about the events *inside* those calendars, and it was not kept. A failed read
 * was swallowed, the window was closed over the accounts that did answer, and
 * an event the unreadable account still holds was dropped from every view of it
 * -- the reading being "the meeting was cancelled", with nothing on screen to
 * say otherwise. A window is also re-asked on every activation, so the deletion
 * survived every reload rather than clearing itself.
 */

const cal = (id: string, name: string) => ({ id, name }) as unknown as Calendar;
const shared = (accountId: string) => ({
  accountId,
  accountName: accountId,
  calendar: cal(`${accountId}-cal`, accountId),
});

const WINDOW_FROM = new Date("2026-10-14T00:00:00Z");
const WINDOW_TO = new Date("2026-10-15T00:00:00Z");
const windowKey = `${WINDOW_FROM.getTime()}|${WINDOW_TO.getTime()}`;

/** A `chain` answering a `CalendarEvent/query` + `/get` with these events. */
function answering(events: CalendarEvent[]) {
  return async () => ({
    get: (ref: string) =>
      ref === "q" ? [{ ids: events.map((e) => e.id) }] : [{ list: events, notFound: [] }],
  });
}

beforeEach(() => {
  setDeviceTrusted(true);
  localStorage.clear();
  useSession.setState({
    session: {
      primaryAccounts: { [CAP.calendars]: "acc-own" },
      accounts: {
        "acc-own": { name: "Me", isPersonal: true },
        "acc-group": { name: "Team", isPersonal: false },
        "acc-partner": { name: "Partner", isPersonal: false },
      },
    } as unknown as JmapSession,
  });
  useCalendar.setState({
    sharedCalendars: [shared("acc-group"), shared("acc-partner")],
    sharedEvents: {},
    sharedRanges: {},
    ranges: {},
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useCalendar.setState({
    sharedCalendars: [],
    sharedEvents: {},
    sharedRanges: {},
    ranges: {},
    error: null,
  });
});

describe("reading a window of shared events", () => {
  it("keeps what an account that could not be read already had in the window", async () => {
    const held = { id: "g1", title: "Sprint review" } as unknown as CalendarEvent;
    const fresh = { id: "p1", title: "Partner sync" } as unknown as CalendarEvent;
    useCalendar.setState({
      sharedEvents: { "acc-group:g1": held },
      sharedRanges: { [windowKey]: ["acc-group:g1"] },
    });

    vi.spyOn(client, "chain").mockImplementation((async (calls: unknown) => {
      const query = (calls as Array<[{ accountId: string }, string]>)[0]![0]!.accountId;
      if (query === "acc-group") throw new Error("upstream 502");
      return answering([fresh])();
    }) as never);

    await useCalendar.getState().loadSharedRange(WINDOW_FROM, WINDOW_TO);

    const keys = useCalendar.getState().sharedRanges[windowKey] ?? [];
    // The unreadable account's event is still in the window...
    expect(keys).toContain("acc-group:g1");
    // ...and the readable account's is taken fresh beside it.
    expect(keys).toContain("acc-partner:p1");
    // The failure is on screen rather than swallowed into an empty window.
    expect(useCalendar.getState().error).toContain("502");
  });

  it("still drops an event the account answered for and no longer holds", async () => {
    // The other half of the promise: keeping what could not be read must not turn
    // into keeping everything, or a cancelled meeting never leaves the window.
    useCalendar.setState({
      sharedEvents: {
        "acc-group:g1": { id: "g1" } as unknown as CalendarEvent,
        "acc-partner:p1": { id: "p1" } as unknown as CalendarEvent,
      },
      sharedRanges: { [windowKey]: ["acc-group:g1", "acc-partner:p1"] },
    });

    vi.spyOn(client, "chain").mockImplementation((async (calls: unknown) => {
      const query = (calls as Array<[{ accountId: string }, string]>)[0]![0]!.accountId;
      if (query === "acc-group") throw new Error("upstream 502");
      return answering([])(); // the partner cancelled its meeting
    }) as never);

    await useCalendar.getState().loadSharedRange(WINDOW_FROM, WINDOW_TO);

    const keys = useCalendar.getState().sharedRanges[windowKey] ?? [];
    expect(keys).toContain("acc-group:g1");
    expect(keys).not.toContain("acc-partner:p1");
  });

  it("does not keep the same key twice when an account recovers", async () => {
    useCalendar.setState({
      sharedEvents: { "acc-group:g1": { id: "g1" } as unknown as CalendarEvent },
      sharedRanges: { [windowKey]: ["acc-group:g1"] },
    });
    const event = { id: "g1", title: "Sprint review" } as unknown as CalendarEvent;

    vi.spyOn(client, "chain").mockImplementation(answering([event]) as never);

    await useCalendar.getState().loadSharedRange(WINDOW_FROM, WINDOW_TO);

    const keys = useCalendar.getState().sharedRanges[windowKey] ?? [];
    expect(keys).toEqual(["acc-group:g1"]);
    expect(useCalendar.getState().error).toBeNull();
  });
});
