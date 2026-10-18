import { CAP, client } from "@/jmap/client";
import type { BusyPeriod } from "@/jmap/types";
import { toUTCDate } from "@/lib/dates";
import { useSession } from "../../session";
import type { CalendarGet, CalendarSet, CalendarState } from "../types";

/**
 * Availability: what the principal's calendars say they are busy with.
 *
 * A slice of the calendar store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function availabilitySlice(
  _set: CalendarSet,
  _get: CalendarGet,
): Pick<CalendarState, "availability"> {
  return {
    async availability(principalId, start, end) {
      const accountId = useSession.getState().accountFor(CAP.principals);
      if (!accountId || !client.hasCapability(CAP.availability)) return [];
      const res = await client.call<{ list: BusyPeriod[] }>(
        "Principal/getAvailability",
        {
          accountId,
          id: principalId,
          utcStart: toUTCDate(start),
          utcEnd: toUTCDate(end),
          showDetails: false,
        },
        [CAP.principals, CAP.availability],
      );
      return res.list ?? [];
    },
  };
}
