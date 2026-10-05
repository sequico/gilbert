import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, CalendarEvent, JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { EventEditor } from "../EventEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Moving an event to another calendar from the editor, which is the only place
 * a reader can say "this belongs in the group's calendar, not mine".
 *
 * The store's own test pins the wire -- re-file, same uid, original destroyed.
 * This one starts where the reader starts: the Calendar field, a change of
 * value in it, and Save. It is the path that has to keep working now that the
 * field sits under the title, and the one that fails silently if the field
 * ever goes back to being disabled or filtered.
 */

const rights = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: true,
  mayWriteOwn: true,
  mayUpdatePrivate: true,
  mayRSVP: true,
  mayShare: true,
  mayDelete: true,
};

const cal = (id: string, name: string, over: Partial<Calendar> = {}) =>
  ({
    id,
    name,
    color: "#0f766e",
    description: null,
    sortOrder: 0,
    isSubscribed: true,
    isVisible: true,
    isDefault: false,
    includeInAvailability: "all",
    timeZone: "UTC",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    shareWith: {},
    myRights: rights,
    ...over,
  }) as unknown as Calendar;

/** A one-off in the reader's own account, calendar `c1`. */
const EVENT = {
  id: "e1",
  "@type": "Event",
  uid: "u1",
  calendarIds: { c1: true },
  title: "Standup",
  start: "2026-09-14T09:00:00",
  duration: "PT30M",
} as unknown as CalendarEvent;

const KEY = (accountId: string, calendarId: string) =>
  JSON.stringify([accountId, calendarId]);

/*
 * A signed-in session, because the calendar store wipes itself on any session
 * state that is not "authenticated" -- a subscriber that exists so a sign-out
 * cannot leave the previous reader's calendars on screen. A test that pokes
 * `useSession` without one therefore empties the store it is about to assert
 * against, which is what this constant prevents.
 */
const SESSION = {
  capabilities: {
    [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
    [CAP.calendars]: {},
  },
  accounts: {
    own: {
      name: "me@example.org",
      isPersonal: true,
      accountCapabilities: { [CAP.calendars]: {} },
    },
    grp: {
      name: "freight@example.org",
      isPersonal: false,
      accountCapabilities: { [CAP.calendars]: {} },
    },
  },
  primaryAccounts: { [CAP.calendars]: "own" },
  state: "s1",
} as unknown as JmapSession;

describe("changing an event's calendar from the editor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Array<{ name: string; args: Record<string, unknown> }>;

  const render = async (event: CalendarEvent) => {
    await act(async () => {
      root.render(
        <EventEditor
          init={{
            event,
            accountId: "own",
            start: new Date("2026-09-14T09:00:00"),
            end: new Date("2026-09-14T09:30:00"),
            allDay: false,
          }}
          onClose={() => undefined}
        />,
      );
    });
  };

  const select = () =>
    [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
      [...s.options].some((o) => o.value === KEY("own", "c1")),
    );

  const choose = async (value: string) => {
    const sel = select();
    await act(async () => {
      sel!.value = value;
      sel!.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  const save = async () => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Save",
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  beforeEach(async () => {
    calls = [];
    client.session = SESSION;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          methodCalls: [string, Record<string, unknown>, string][];
        };
        const methodResponses: unknown[] = [];
        for (const [name, args, id] of body.methodCalls) {
          calls.push({ name, args });
          const created: Record<string, unknown> = {};
          for (const k of Object.keys((args.create as Record<string, unknown>) ?? {}))
            created[k] = { id: "e2" };
          const updated: Record<string, unknown> = {};
          for (const k of Object.keys((args.update as Record<string, unknown>) ?? {}))
            updated[k] = null;
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              list: [EVENT],
              notFound: [],
              created,
              updated,
              destroyed: args.destroy ?? [],
              notCreated: {},
              notUpdated: {},
              notDestroyed: {},
            },
            id,
          ]);
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ methodResponses, sessionState: "1" }),
        } as Response;
      }),
    );
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    useSession.setState({ status: "authenticated", session: SESSION } as never);
    /* Let anything the session store kicked off settle before the calendars are
       set, so a load that answers empty cannot overwrite them. */
    await act(async () => {});
    useCalendar.setState({
      accountId: "own",
      calendars: { c1: cal("c1", "Personal", { isDefault: true }) },
      sharedCalendars: [
        {
          accountId: "grp",
          accountName: "freight@example.org",
          calendar: cal("gc1", "Team calendar"),
        },
      ],
      sharedEvents: {},
      sharedRanges: {},
      events: {},
      ranges: {},
      hidden: {},
      identities: [],
    });
    useSettings.setState((s) => ({ settings: { ...s.settings, addedShares: [] } }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers the group's calendar while editing, beside the reader's own", async () => {
    await render(EVENT);
    expect([...select()!.options].map((o) => o.textContent)).toEqual([
      "Personal",
      "Team calendar · freight@example.org",
    ]);
  });

  it("re-files the event under the group's account when Save is pressed", async () => {
    await render(EVENT);
    await choose(KEY("grp", "gc1"));
    await save();

    const sets = calls.filter(
      (c) => c.name === "CalendarEvent/set" && (c.args.create || c.args.destroy),
    );
    const created = sets.find((c) => c.args.create);
    const destroyed = sets.find((c) => c.args.destroy);
    expect(created?.args.accountId).toBe("grp");
    expect(destroyed?.args.accountId).toBe("own");
    // The copy carries the new calendar and the same uid, so an attendee's
    // copy of the event updates rather than duplicating.
    const copy = (created!.args.create as { e: Record<string, unknown> }).e;
    expect(copy.calendarIds).toEqual({ gc1: true });
    expect(copy.uid).toBe("u1");
  });

  it("adds a group calendar to the view first when it was not there", async () => {
    useCalendar.setState({
      sharedCalendars: [
        {
          accountId: "grp",
          accountName: "freight@example.org",
          calendar: cal("gc1", "Team calendar", { isSubscribed: false }),
        },
      ],
    });
    await render(EVENT);
    await choose(KEY("grp", "gc1"));
    await save();

    const subscribe = calls.find(
      (c) =>
        c.name === "Calendar/set" &&
        (c.args.update as Record<string, { isSubscribed?: boolean }> | undefined)?.gc1
          ?.isSubscribed === true,
    );
    expect(subscribe?.args.accountId).toBe("grp");
  });
});
