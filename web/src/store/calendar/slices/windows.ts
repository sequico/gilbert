import { errorMessage } from "@gilbert/shared/errors";
import { ref } from "@gilbert/shared/jmapQuery";
import { client } from "@/jmap/client";
import type { CalendarEvent, GetResponse, QueryResponse } from "@/jmap/types";
import { browserTimeZone, dateToZonedLocal } from "@/lib/dates";
import { settings } from "../../settings";
import { EVENT_PROPS } from "../shared";
import type { CalendarGet, CalendarSet, CalendarState } from "../types";
import { keepRecent } from "./events";

/** `map` restricted to the windows still held. */
function onlyKeys<T>(
  map: Record<string, T>,
  held: Record<string, unknown>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(map).filter(([k]) => k in held));
}

/**
 * The windows on the grid: what is loaded, what is being loaded, and the one
 * silent refresh a burst of writes or pushes asks for.
 *
 * A slice of the calendar store: the state is assembled in `../index`, and
 * this function only says what this job does with `set` and `get`.
 */
export function windowsSlice(
  set: CalendarSet,
  get: CalendarGet,
): Pick<CalendarState, "loadRange" | "refreshWindows"> {
  /*
   * How many windows are being read at once. `loading` is derived from it rather
   * than cleared by each call: windows loaded together are separate runs, and the
   * one that finishes first must not take the spinner down while another is
   * still on its way.
   */
  let rangeLoads = 0;
  /* Coalesces `refreshWindows` (see there): one silent refresh per burst of
     writes/pushes instead of one per event, and per kind of window -- the
     reader's own, and the shared ones drawn beside them. */
  const calendarWindowsQueued = { own: false, shared: false };

  return {
    async loadRange(start, end, force = false) {
      const accountId = get().accountId;
      if (!accountId) return;
      const key = `${start.getTime()}|${end.getTime()}`;
      const held = get().ranges[key];
      if (!force && held) {
        // Shown again, so the most recent: a window the reader comes back to is
        // not the one dropped next.
        set((s) => ({ ranges: keepRecent(s.ranges, key, held) }));
        return;
      }
      // Loading stands in only for a window with no data yet: a background
      // refresh (after a write or a push) must not flash "loading" over
      // content that is already on screen.
      const shows = !get().ranges[key];
      if (shows) {
        rangeLoads += 1;
        set({ loading: true });
      }
      const tz = settings().timeZone ?? browserTimeZone;
      try {
        const res = await client.chain([
          [
            "CalendarEvent/query",
            {
              accountId,
              // Stalwart treats after/before as wall-clock times in `timeZone`,
              // so the window's instants are written as that zone's clock rather
              // than the browser's (see loadSharedRange).
              filter: {
                after: dateToZonedLocal(start, tz),
                before: dateToZonedLocal(end, tz),
              },
              timeZone: tz,
              sort: [{ property: "start", isAscending: true }],
              expandRecurrences: true,
              limit: 2000,
            },
            "q",
          ],
          [
            "CalendarEvent/get",
            {
              accountId,
              "#ids": ref("q", "CalendarEvent/query", "/ids"),
              properties: EVENT_PROPS,
              timeZone: tz,
            },
            "g",
          ],
        ]);
        const q = res.get("q")?.[0] as unknown as QueryResponse;
        const g = res.get("g")?.[0] as unknown as GetResponse<CalendarEvent>;
        if (shows) rangeLoads -= 1;
        set((s) => {
          const events = { ...s.events };
          for (const e of g.list) events[e.id] = e;
          const ranges = keepRecent(s.ranges, key, q.ids);
          return {
            events,
            ranges,
            sharedRanges: onlyKeys(s.sharedRanges, ranges),
            loading: rangeLoads > 0,
            error: null,
          };
        });
        void get().loadSharedRange(start, end);
      } catch (err) {
        if (shows) rangeLoads -= 1;
        set({ loading: rangeLoads > 0, error: errorMessage(err) });
      }
    },

    refreshWindows(shared = false) {
      // Re-fetch every window that is loaded, silently: nothing is dropped
      // first, so what is on screen stays until the fresh answer lands
      // (stale-while-revalidate). A write or a push must never flash an empty
      // grid over content that is already there.
      //
      // Coalesced per kind: a burst of pushes -- or the reader's own write
      // followed by its push echo -- refreshes the windows once, not once per
      // event. A shared account's windows are their own kind, because a change
      // to a colleague's calendar is not a change to the reader's.
      const kind = shared ? "shared" : "own";
      if (calendarWindowsQueued[kind]) return;
      calendarWindowsQueued[kind] = true;
      queueMicrotask(() => {
        calendarWindowsQueued[kind] = false;
        for (const key of Object.keys(get().ranges)) {
          const [s, e] = key.split("|").map(Number) as [number, number];
          if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
          if (shared) void get().loadSharedRange(new Date(s), new Date(e));
          else void get().loadRange(new Date(s), new Date(e), true);
        }
      });
    },
  };
}
