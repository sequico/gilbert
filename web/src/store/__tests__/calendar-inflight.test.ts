import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";

const EVENT = {
  id: "e1",
  "@type": "Event",
  uid: "u1",
  calendarIds: { c1: true, c2: true },
  title: "Standup",
  utcStart: "2026-09-04T07:00:00Z",
  utcEnd: "2026-09-04T07:30:00Z",
  duration: "PT30M",
} as unknown as CalendarEvent;

const calendar = (id: string) =>
  ({ id, name: id, isSubscribed: true }) as unknown as Calendar;

beforeEach(() => {
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: { c1: calendar("c1"), c2: calendar("c2") },
    events: {},
    ranges: {},
    sharedCalendars: [],
    sharedEvents: {},
    sharedRanges: {},
    hidden: {},
    loading: false,
    error: null,
    subscriptionEvents: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an event that sits in more than one calendar", () => {
  it("is hidden only when every calendar it names is hidden", () => {
    useCalendar.setState({ events: { e1: EVENT }, ranges: { r: ["e1"] }, hidden: {} });

    const visible = useCalendar
      .getState()
      .instancesIn(new Date("2026-09-01"), new Date("2026-10-01"));
    expect(visible.map((i) => i.key)).toContain("e1");

    // Hiding the first of the two must not take the event down while the
    // second stays visible.
    useCalendar.setState({ hidden: { c1: true } });
    const halfHidden = useCalendar
      .getState()
      .instancesIn(new Date("2026-09-01"), new Date("2026-10-01"));
    expect(halfHidden.map((i) => i.key)).toContain("e1");

    useCalendar.setState({ hidden: { c1: true, c2: true } });
    const allHidden = useCalendar
      .getState()
      .instancesIn(new Date("2026-09-01"), new Date("2026-10-01"));
    expect(allHidden.map((i) => i.key)).not.toContain("e1");
  });
});

describe("a shared window re-read", () => {
  it("drops an event the account no longer returns", async () => {
    useCalendar.setState({
      sharedCalendars: [
        { accountId: "g1", accountName: "Team", calendar: calendar("sc1") },
      ],
      sharedEvents: {},
      sharedRanges: {},
    });

    let events: CalendarEvent[] = [EVENT];
    vi.spyOn(client, "chain").mockImplementation(
      (async () =>
        new Map([
          ["q", [{ ids: events.map((e) => e.id) }]],
          ["g", [{ list: events, state: "1" }]],
        ])) as never,
    );

    const start = new Date("2026-09-01");
    const end = new Date("2026-10-01");
    await useCalendar.getState().loadSharedRange(start, end);
    expect(Object.keys(useCalendar.getState().sharedEvents)).toContain("g1:e1");

    // The re-read returns nothing: the stale event must not survive beside it.
    events = [];
    await useCalendar.getState().loadSharedRange(start, end);
    expect(useCalendar.getState().sharedEvents["g1:e1"]).toBeUndefined();
  });
});

describe("two calendar windows loaded at once", () => {
  it("keeps loading until the last of them lands", async () => {
    const releases: Array<() => void> = [];
    vi.spyOn(client, "chain").mockImplementation(
      (async () =>
        await new Promise<Map<string, unknown>>((resolve) => {
          releases.push(() =>
            resolve(
              new Map([
                ["q", [{ ids: [] }]],
                ["g", [{ list: [], state: "1" }]],
              ]),
            ),
          );
        })) as never,
    );

    const first = useCalendar
      .getState()
      .loadRange(new Date("2026-09-01"), new Date("2026-09-08"));
    const second = useCalendar
      .getState()
      .loadRange(new Date("2026-09-08"), new Date("2026-09-15"));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(useCalendar.getState().loading).toBe(true);

    releases[0]!();
    await first;
    expect(useCalendar.getState().loading).toBe(true);

    releases[1]!();
    await second;
    expect(useCalendar.getState().loading).toBe(false);
  });
});
