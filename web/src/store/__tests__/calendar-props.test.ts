import { describe, expect, it } from "vitest";
import { EVENT_PROPS, SERIES_PROPS } from "@/store/calendar/shared";

/*
 * A `CalendarEvent/get` may not name `recurrenceOverrides` beside `utcStart` or
 * `utcEnd`: Stalwart refuses the whole call with `invalidArguments`
 * (`calendar_event/get.rs`, v1.0.0), which takes every calendar window with it.
 * Both lists the client asks through are held to that, so re-adding the property
 * to the occurrence list (or the utc pair to the export) fails here.
 */
describe("calendar property lists", () => {
  for (const [name, props] of [
    ["EVENT_PROPS", EVENT_PROPS],
    ["SERIES_PROPS", SERIES_PROPS],
  ] as const) {
    it(`${name} does not ask for recurrenceOverrides beside the utc pair`, () => {
      const utc = props.includes("utcStart") || props.includes("utcEnd");
      expect(utc && props.includes("recurrenceOverrides")).toBe(false);
    });
  }

  it("the export reads the series' overrides and the grid its utc pair", () => {
    expect(SERIES_PROPS).toContain("recurrenceOverrides");
    expect(EVENT_PROPS).toContain("utcStart");
  });
});
