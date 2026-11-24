import { beforeEach, describe, expect, it } from "vitest";
import type { CalendarEvent, JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { useSession } from "@/store/session";
import { fakeJmapServer } from "@/test/jmapServer";

/**
 * Searching events, as the store asks for them.
 *
 * The request shapes are pinned beside the module that builds them. What this
 * pins is the decision after the answer: a series comes back once, as its
 * master at its first date, and is placed at its next date (or its latest,
 * once it has ended) by a second query. A reader looking for a weekly meeting
 * must not be told it happened in January.
 */

const master = (): CalendarEvent =>
  ({
    id: "m1",
    uid: "u1",
    calendarIds: { c1: true },
    recurrenceRule: { frequency: "weekly" },
    utcStart: "2026-01-05T09:00:00Z",
    utcEnd: "2026-01-05T10:00:00Z",
  }) as unknown as CalendarEvent;

const occurrence = (): CalendarEvent =>
  ({
    id: "o1",
    uid: "u1",
    baseEventId: "m1",
    calendarIds: { c1: true },
    recurrenceId: "2026-11-30T09:00:00Z",
    utcStart: "2026-11-30T09:00:00Z",
    utcEnd: "2026-11-30T10:00:00Z",
  }) as unknown as CalendarEvent;

const calendar = {
  id: "c1",
  name: "Work",
  isSubscribed: true,
  isVisible: true,
  myRights: { mayReadItems: true, mayWriteAll: true },
} as never;

beforeEach(() => {
  useSession.setState({
    status: "authenticated",
    session: {
      accounts: {
        a1: {
          name: "me@example.org",
          isPersonal: true,
          accountCapabilities: { "urn:ietf:params:jmap:calendars": {} },
        },
      },
      primaryAccounts: { "urn:ietf:params:jmap:calendars": "a1" },
    } as unknown as JmapSession,
  });
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: { c1: calendar },
    sharedCalendars: [],
    events: {},
    ranges: {},
    subscriptionEvents: {},
  });
});

describe("an event search", () => {
  it("places a series at its next occurrence, not at its first date", async () => {
    const server = fakeJmapServer()
      .on("CalendarEvent/query", ({ args }) => {
        // The text query finds the master; the per-uid query finds the
        // occurrence that is due next.
        if (args.filter && "text" in (args.filter as Record<string, unknown>))
          return { accountId: "a1", ids: ["m1"], total: 1, position: 0 };
        return {
          accountId: "a1",
          ids: args.filter && (args.filter as { uid?: string }).uid ? ["o1"] : [],
          total: 1,
          position: 0,
        };
      })
      .on("CalendarEvent/get", ({ args }) => {
        const resolving = "#ids" in (args as Record<string, unknown>);
        return {
          accountId: "a1",
          state: "s1",
          list: [resolving ? master() : occurrence()],
          notFound: [],
        };
      });

    const hits = await useCalendar.getState().searchEvents("weekly");

    expect(hits).toHaveLength(1);
    expect(hits[0]!.inst.event.baseEventId).toBe("m1");
    // The occurrence's own dates, not the master's January ones.
    expect(hits[0]!.inst.start.toISOString()).toBe("2026-11-30T09:00:00.000Z");
    expect(hits[0]!.rule).toMatchObject({ frequency: "weekly" });
    // The text the reader typed reached the server as a `text` filter.
    expect(server.callsTo("CalendarEvent/query")[0]!.args).toMatchObject({
      filter: { text: "weekly" },
    });
  });

  it("shows a one-off where it is, without a second query", async () => {
    const server = fakeJmapServer()
      .on("CalendarEvent/query", () => ({ accountId: "a1", ids: ["e1"], total: 1, position: 0 }))
      .on("CalendarEvent/get", () => ({
        accountId: "a1",
        state: "s1",
        list: [
          {
            id: "e1",
            uid: "u2",
            calendarIds: { c1: true },
            utcStart: "2026-12-01T15:00:00Z",
            utcEnd: "2026-12-01T16:00:00Z",
          },
        ],
        notFound: [],
      }));

    const hits = await useCalendar.getState().searchEvents("dentist");

    expect(hits).toHaveLength(1);
    expect(hits[0]!.rule).toBeUndefined();
    expect(hits[0]!.inst.start.toISOString()).toBe("2026-12-01T15:00:00.000Z");
    // One text query and one read: a one-off needs no expansion.
    expect(server.callsTo("CalendarEvent/query")).toHaveLength(1);
  });
});
