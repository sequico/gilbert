import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, JmapSession } from "@/jmap/types";
import { setDeviceTrusted } from "@/lib/storage";
import { useCalendar } from "@/store/calendar";
import { useSession } from "@/store/session";

/**
 * A shared account whose calendars cannot be read keeps the calendars it had.
 *
 * Dropping them empties a colleague's grid over one failed request, and the
 * calendars a group owns are found in exactly that list -- so a failing read
 * takes a group's calendars with it, for the rest of the session, with nothing
 * on screen to say why. The account is named on the console, because a shared
 * account that cannot be read is otherwise indistinguishable from one that
 * holds nothing.
 */

const cal = (id: string, name: string) => ({ id, name }) as unknown as Calendar;

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
});

afterEach(() => {
  vi.restoreAllMocks();
  useCalendar.setState({ sharedCalendars: [] });
});

describe("reading the shared calendars", () => {
  it("keeps what an account that could not be read already had", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = {
      accountId: "acc-group",
      accountName: "Team",
      calendar: cal("g1", "Team"),
    };
    useCalendar.setState({ sharedCalendars: [kept] });
    vi.spyOn(client, "call").mockImplementation((async (
      _method: string,
      args: { accountId: string },
    ) => {
      if (args.accountId === "acc-group") throw new Error("upstream 502");
      return { list: [cal("p1", "Partner calendar")], notFound: [] };
    }) as never);

    await useCalendar.getState().loadSharedCalendars();

    const ids = useCalendar.getState().sharedCalendars.map((x) => x.calendar.id);
    expect(ids).toContain("g1"); // the unreadable account kept its own
    expect(ids).toContain("p1"); // the readable one is taken fresh
    expect(ids.filter((id) => id === "g1")).toHaveLength(1); // and not twice
    expect(warn.mock.calls.some(([m]) => String(m).includes("acc-group"))).toBe(true);
  });

  it("leaves the list alone when nothing could be read at all", async () => {
    const kept = {
      accountId: "acc-group",
      accountName: "Team",
      calendar: cal("g1", "Team"),
    };
    useCalendar.setState({ sharedCalendars: [kept] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(client, "call").mockRejectedValue(new Error("upstream 502") as never);

    await useCalendar.getState().loadSharedCalendars();

    /* A transient failure must not read as "every share was taken away". */
    expect(useCalendar.getState().sharedCalendars).toEqual([kept]);
  });
});
