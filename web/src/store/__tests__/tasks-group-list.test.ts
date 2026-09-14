import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, JmapSession } from "@/jmap/types";
import { loadPlace, rememberPlace } from "@/lib/lastPlace";
import { setDeviceTrusted } from "@/lib/storage";
import { useCalendar } from "@/store/calendar";
import { useSession } from "@/store/session";
import { taskListKey, useTasks } from "@/store/tasks";

/**
 * The task lists a reader has are the calendars marked as lists -- their own
 * and those in accounts shared with them, a group mailbox included.
 *
 * A group's list is a calendar in the group's account, recognised by the
 * marker and nothing else. The failure this pins is the quiet one: a list that
 * never reaches `lists` is not drawn by any part of the Tasks sidebar, so
 * nothing on screen says a list is missing. And the list a session opens on is
 * the one this device was last on, when it is still there.
 */

const cal = (id: string, name: string, description?: string) =>
  ({ id, name, description }) as unknown as Calendar;

/** The reader's own account, so the record has an owner to belong to. */
function signedIn() {
  useSession.setState({
    session: {
      primaryAccounts: { [CAP.mail]: "acc-own" },
      accounts: {
        "acc-own": { name: "Me", isPersonal: true },
        "acc-group": { name: "Team", isPersonal: false },
      },
    } as unknown as JmapSession,
  });
}

beforeEach(() => {
  setDeviceTrusted(true);
  localStorage.clear();
  signedIn();
  vi.spyOn(client, "call").mockResolvedValue({
    ids: [],
    list: [],
    notFound: [],
  } as never);
  vi.spyOn(client, "chain").mockResolvedValue(new Map() as never);
  useCalendar.setState({
    accountId: "acc-own",
    calendars: {
      own1: cal("own1", "My tasks", "tasklist"),
      own2: cal("own2", "Trips"),
    },
    sharedCalendars: [
      {
        accountId: "acc-group",
        accountName: "Team",
        calendar: cal("g1", "Team tasks", "tasklist"),
      },
      {
        accountId: "acc-group",
        accountName: "Team",
        calendar: cal("g2", "Team holidays"),
      },
    ],
  });
  useTasks.setState({
    lists: [],
    tasks: {},
    selectedListId: null,
    chosenByReader: false,
    loaded: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the task lists a reader has", () => {
  it("lists a group's task list beside the reader's own, and nothing unmarked", async () => {
    await useTasks.getState().load();

    const lists = useTasks.getState().lists;
    expect(lists.map((l) => taskListKey(l.accountId, l.calendarId))).toEqual([
      "acc-own/own1",
      "acc-group/g1",
    ]);
    expect(lists[1]!.accountName).toBe("Team");
  });

  it("opens on the list this device was last on, when it is still there", async () => {
    rememberPlace("acc-own", { taskList: "acc-group/g1" });

    await useTasks.getState().load();

    expect(useTasks.getState().selectedListId).toBe("acc-group/g1");
  });

  it("falls back to the first list when the remembered one is gone", async () => {
    rememberPlace("acc-own", { taskList: "acc-group/deleted" });

    await useTasks.getState().load();

    expect(useTasks.getState().selectedListId).toBe("acc-own/own1");
  });

  it("keeps the list the reader picked over the one the record names", async () => {
    rememberPlace("acc-own", { taskList: "acc-group/g1" });
    useTasks.getState().select("acc-own/own1");

    await useTasks.getState().load();

    expect(useTasks.getState().selectedListId).toBe("acc-own/own1");
    /* Picking one is itself a place: the next session opens here. */
    expect(loadPlace("acc-own").taskList).toBe("acc-own/own1");
  });
});
