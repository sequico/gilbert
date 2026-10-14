import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Calendar, JmapSession } from "@/jmap/types";
import { parseDuration } from "@/lib/dates";
import { useCalendar } from "@/store/calendar";
import { useSession } from "@/store/session";
import { EventEditor } from "../EventEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * An all-day event on the day a clock falls back.
 *
 * The all-day "Ends" field hands the form a date and the form stores the
 * midnight after it. On 2026-11-01 in New York that local day is 25 hours long,
 * so adding 86 400 000 ms to its midnight lands at 23:00 the same date: a
 * one-day event written to the server 23 hours long, whose own end date reads
 * back as its start.
 *
 * The zone is set for this file alone. The runner is UTC, where every local day
 * is exactly 86 400 000 ms and the arithmetic under test cannot be wrong, so
 * the fall-back has to be stood in the zone that has one.
 */
const ZONE = "America/New_York";
const PREVIOUS_TZ = process.env.TZ;

/** The fall-back day: 2026-11-01 is 25 hours long in New York. */
const fallBack = () => new Date(2026, 10, 1);

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

const CALENDAR = {
  id: "c1",
  name: "Personal",
  color: "#0f766e",
  description: null,
  sortOrder: 0,
  isSubscribed: true,
  isVisible: true,
  isDefault: true,
  includeInAvailability: "all",
  timeZone: ZONE,
  defaultAlertsWithTime: null,
  defaultAlertsWithoutTime: null,
  shareWith: {},
  myRights: rights,
} as unknown as Calendar;

/*
 * A signed-in session, because the calendar store wipes itself on any session
 * state that is not "authenticated" -- a subscriber that exists so a sign-out
 * cannot leave the previous reader's calendars on screen.
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
  },
  primaryAccounts: { [CAP.calendars]: "own" },
  state: "s1",
} as unknown as JmapSession;

describe("an all-day event saved on the fall-back day", () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Array<{ name: string; args: Record<string, unknown> }>;

  const render = async () => {
    await act(async () => {
      root.render(
        <EventEditor
          init={{
            start: fallBack(),
            end: new Date(2026, 10, 2),
            allDay: true,
          }}
          onClose={() => undefined}
        />,
      );
    });
  };

  /** Pick a date in the all-day "Ends" field, the way the calendar grid does. */
  const pickEnds = async (date: Date) => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Ends"]')!;
    await act(async () => {
      input.parentElement?.querySelector<HTMLButtonElement>("button.dp-open")?.click();
    });
    const day = [...document.querySelectorAll<HTMLButtonElement>(".dp-day")].find(
      (b) => b.getAttribute("aria-label") === date.toDateString(),
    );
    expect(day, `the grid offers ${date.toDateString()}`).toBeTruthy();
    await act(async () => {
      day!.click();
    });
  };

  const save = async () => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Create",
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  const created = () => {
    const set = calls.find((c) => c.name === "CalendarEvent/set" && c.args.create);
    const create = set?.args.create as { e?: Record<string, unknown> } | undefined;
    return create?.e;
  };

  beforeAll(() => {
    process.env.TZ = ZONE;
  });

  afterAll(() => {
    if (PREVIOUS_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = PREVIOUS_TZ;
  });

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
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              list: [],
              notFound: [],
              created,
              updated: {},
              destroyed: [],
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
    // Let anything the session store kicked off settle before the calendars are
    // set, so a load that answers empty cannot overwrite them.
    await act(async () => {});
    useCalendar.setState({
      accountId: "own",
      calendars: { c1: CALENDAR },
      sharedCalendars: [],
      sharedEvents: {},
      sharedRanges: {},
      events: {},
      ranges: {},
      hidden: {},
      identities: [],
    });
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

  it("stores one calendar day, not the 23 hours a millisecond day gives", async () => {
    await render();
    await pickEnds(fallBack());
    await save();

    const event = created();
    expect(event?.showWithoutTime).toBe(true);
    expect(event?.start).toBe("2026-11-01T00:00:00");
    /*
     * One calendar day: from one midnight to the next, which is what the reader
     * picked. A day taken as 86 400 000 ms lands at 23:00 the same date
     * instead -- an event a day long stored, and read back, as 23 hours.
     */
    const from = new Date(event!.start as string);
    const to = new Date(from.getTime() + parseDuration(event!.duration as string) * 1000);
    expect(to).toEqual(new Date(2026, 10, 2));
  });
});
