import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, CalendarEvent, JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/*
 * A group's calendar is subscribed by membership, not by `isSubscribed`.
 *
 * A member could once "remove" one from their view, which wrote
 * `isSubscribed: false` and stranded it: the events stopped being drawn and
 * there was no "+" to bring it back, because a group's calendars never appear
 * under "Available to add". These pin the repair -- the calendar is drawn by
 * membership whether or not the flag survived, and one found unsubscribed is
 * put back on the group's own object so every reader gets it again.
 */

const CAL = (id: string, isSubscribed: boolean) =>
  ({
    id,
    name: id,
    description: null,
    color: "#0f766e",
    sortOrder: 0,
    isSubscribed,
    isVisible: true,
    isDefault: false,
    includeInAvailability: "all",
    timeZone: "UTC",
    shareWith: {},
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: true,
      mayWriteOwn: true,
      mayUpdatePrivate: true,
      mayRSVP: true,
      mayShare: true,
      mayDelete: true,
    },
  }) as unknown as Calendar;

const event = (id: string, calendarId: string) =>
  ({
    id,
    "@type": "Event",
    uid: `u-${id}`,
    calendarIds: { [calendarId]: true },
    title: "Standup",
    start: "2026-09-14T09:00:00",
    duration: "PT30M",
  }) as unknown as CalendarEvent;

const WINDOW_START = new Date("2026-09-13T00:00:00");
const WINDOW_END = new Date("2026-09-15T00:00:00");

describe("a group's calendar is drawn by membership", () => {
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
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, addedShares: [] } });
    useMail.setState({
      mailAccounts: [{ accountId: "grp", name: "team@example.org", kind: "group" }],
    });
    useCalendar.setState({
      accountId: "own",
      available: true,
      calendars: {},
      events: {},
      ranges: {},
      hidden: {},
      identities: [],
      sharedCalendars: [],
      sharedEvents: {},
      sharedRanges: {},
    });
  });

  afterEach(() => {
    useMail.setState({ mailAccounts: [] });
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
    useSession.setState({ session: null });
    vi.restoreAllMocks();
  });

  it("draws a group calendar's events even when the flag says unsubscribed", () => {
    useCalendar.setState({
      sharedCalendars: [
        {
          accountId: "grp",
          accountName: "team@example.org",
          calendar: CAL("gc1", false),
        },
      ],
      sharedEvents: { "grp:e1": event("e1", "gc1") },
      sharedRanges: { w: ["grp:e1"] },
    });
    const out = useCalendar.getState().instancesIn(WINDOW_START, WINDOW_END);
    expect(out.some((i) => i.event.id === "e1")).toBe(true);
  });

  it("still hides a stranger's calendar that was never added", () => {
    useCalendar.setState({
      sharedCalendars: [
        { accountId: "stranger", accountName: "someone", calendar: CAL("sc1", false) },
      ],
      sharedEvents: { "stranger:e9": event("e9", "sc1") },
      sharedRanges: { w: ["stranger:e9"] },
    });
    const out = useCalendar.getState().instancesIn(WINDOW_START, WINDOW_END);
    expect(out.some((i) => i.event.id === "e9")).toBe(false);
  });

  it("puts a group calendar left unsubscribed back on the group's own object", async () => {
    useSession.setState({
      session: {
        primaryAccounts: { [CAP.calendars]: "own" },
        accounts: {
          own: { name: "Me", isPersonal: true },
          grp: { name: "Team", isPersonal: false },
        },
      } as unknown as JmapSession,
    });
    const call = vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Calendar/get") return { list: [CAL("gc1", false)], notFound: [] };
      if (method === "Calendar/set") return { updated: { gc1: null }, notUpdated: {} };
      return { list: [], notFound: [] };
    }) as never);

    await useCalendar.getState().loadSharedCalendars();

    const setCall = call.mock.calls.find((c) => c[0] === "Calendar/set");
    expect(setCall?.[1]).toMatchObject({
      accountId: "grp",
      update: { gc1: { isSubscribed: true } },
    });
  });
});
