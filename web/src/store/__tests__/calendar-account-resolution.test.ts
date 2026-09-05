import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Calendar, Id } from "@/jmap/types";
import { accountOfCalendarId, useCalendar } from "@/store/calendar";

/**
 * A calendar id is unique only within its account, so a bare id is only
 * resolvable when it names exactly one reachable calendar. When the reader's
 * own account and a group's both hold a same-id calendar (or two shared
 * accounts do), or nobody reachable holds the id at all, the answer must be
 * "no account" rather than a guess -- the callers that know the account pass
 * it explicitly, and a guess here would aim an edit at the wrong account's
 * same-id calendar.
 */

const CAL = (id: Id) =>
  ({
    id,
    name: id,
    description: null,
    isSubscribed: true,
    myRights: { mayWriteAll: true },
  }) as unknown as Calendar;

interface SharedSeed {
  accountId: string;
  accountName: string;
  calendar: Calendar;
}

function seed(own: Record<Id, Calendar>, shared: SharedSeed[] = []) {
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: own,
    sharedCalendars: shared,
    events: {},
    ranges: {},
    hidden: {},
    sharedEvents: {},
    sharedRanges: {},
    identities: [],
  });
}

beforeEach(() => seed({}));

afterEach(() => {
  useCalendar.setState({ accountId: null, calendars: {}, sharedCalendars: [] });
});

describe("bare calendar id resolution", () => {
  it("resolves an id held only by the reader's own account to the own account", () => {
    seed({ t1: CAL("t1") });
    expect(accountOfCalendarId("t1")).toBe("a1");
  });

  it("resolves an id held by exactly one shared account to that account", () => {
    seed({}, [{ accountId: "a2", accountName: "Team", calendar: CAL("g1") }]);
    expect(accountOfCalendarId("g1")).toBe("a2");
  });

  it("refuses an id held by the own account and a shared one at once", () => {
    seed({ t1: CAL("t1") }, [
      { accountId: "a2", accountName: "Team", calendar: CAL("t1") },
    ]);
    // Previously resolved to the own account, silently aiming group edits at
    // the reader's own same-id calendar.
    expect(accountOfCalendarId("t1")).toBeNull();
  });

  it("refuses an id held by two shared accounts", () => {
    seed({}, [
      { accountId: "a2", accountName: "Team", calendar: CAL("g1") },
      { accountId: "a3", accountName: "Other team", calendar: CAL("g1") },
    ]);
    expect(accountOfCalendarId("g1")).toBeNull();
  });

  it("falls back to the own account for an id nobody reachable holds", () => {
    // The shared list may simply not have loaded yet; the own account is the
    // historical answer for that state. Refusal is reserved for ids that name
    // more than one reachable calendar.
    expect(accountOfCalendarId("ghost")).toBe("a1");
  });

  it("defaults a missing id to the own account, for a brand-new event", () => {
    seed({ c1: CAL("c1") });
    expect(accountOfCalendarId(undefined)).toBe("a1");
    expect(accountOfCalendarId(null)).toBe("a1");
  });
});
