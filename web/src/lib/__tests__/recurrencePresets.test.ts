import { describe, expect, it } from "vitest";
import { ruleFromPreset, WEEKDAY_KEYS } from "../recurrence";

/*
 * Recurrence presets built their weekly byDay and monthly byMonthDay from the
 * *browser's* date of the start instant. The server expands RRULE in the
 * event's own timezone, so an event whose zone differs from the browser frame
 * repeated on a different weekday/day-of-month than the preset offered. The
 * rule has to be derived from the start instant as the event's zone sees it.
 *
 * 2026-01-16T22:00:00Z is Friday the 16th in New York and already Saturday the
 * 17th in Tokyo, so both derivations are distinguishable whatever zone the
 * test runner sits in.
 */

const start = new Date("2026-01-16T22:00:00Z");

describe("ruleFromPreset derives the rule from the event's own zone", () => {
  it("reads the weekly byDay off the zone given for the event", () => {
    expect(ruleFromPreset("weekly", start, "America/New_York")).toMatchObject({
      byDay: [{ day: "fr" }],
    });
    expect(ruleFromPreset("weekly", start, "Asia/Tokyo")).toMatchObject({
      byDay: [{ day: "sa" }],
    });
  });

  it("reads the monthly day-of-month off the zone given for the event", () => {
    expect(ruleFromPreset("monthly", start, "America/New_York")).toMatchObject({
      byMonthDay: [16],
    });
    expect(ruleFromPreset("monthly", start, "Asia/Tokyo")).toMatchObject({
      byMonthDay: [17],
    });
  });

  it("keeps the browser date when no zone is given (an all-day event)", () => {
    expect(ruleFromPreset("monthly", start)).toMatchObject({
      byMonthDay: [start.getDate()],
    });
    expect(ruleFromPreset("weekly", start)).toMatchObject({
      byDay: [{ day: WEEKDAY_KEYS[(start.getDay() + 6) % 7] }],
    });
  });
});
