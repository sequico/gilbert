import { describe, expect, it } from "vitest";
import {
  dateToZonedLocal,
  formatDuration,
  monthGrid,
  parseDuration,
  zonedDay,
  zonedToDate,
} from "../dates";

describe("dates", () => {
  it("parses and formats ISO durations", () => {
    expect(parseDuration("PT1H30M")).toBe(5400);
    expect(parseDuration("P1DT2H")).toBe(93600);
    expect(parseDuration("-PT15M")).toBe(-900);
    expect(formatDuration(5400)).toBe("PT1H30M");
    expect(formatDuration(-600)).toBe("-PT10M");
    expect(formatDuration(86400)).toBe("P1D");
    // The shapes the wire expects, including the two a clamp would erase.
    expect(formatDuration(3600)).toBe("PT1H");
    expect(formatDuration(900)).toBe("PT15M");
    expect(formatDuration(90000)).toBe("P1DT1H");
    expect(formatDuration(45)).toBe("PT45S");
    expect(formatDuration(0)).toBe("PT0S");
  });
  it("converts zoned local times to instants", () => {
    const d = zonedToDate("2024-07-01T12:00:00", "America/New_York");
    expect(d.toISOString()).toBe("2024-07-01T16:00:00.000Z");
    expect(dateToZonedLocal(d, "Europe/Berlin")).toBe("2024-07-01T18:00:00");
  });
  it("formats an instant as the asked zone's wall clock, not the browser frame's", () => {
    // 22:00 UTC: evening in New York, already tomorrow in Tokyo. Whatever
    // zone this test runs in, the text has to be the asked zone's clock -- a
    // calendar window boundary written in the browser frame but labelled with
    // the settings zone makes the server compare the wrong instants.
    const inst = new Date("2026-01-16T22:00:00Z");
    expect(dateToZonedLocal(inst, "America/New_York")).toBe("2026-01-16T17:00:00");
    expect(dateToZonedLocal(inst, "Asia/Tokyo")).toBe("2026-01-17T07:00:00");
  });
  it("reads the calendar day of an instant as a chosen zone sees it", () => {
    const inst = new Date("2026-01-16T22:00:00Z");
    // Friday the 16th in New York, already Saturday the 17th in Tokyo.
    expect(zonedDay(inst, "America/New_York")).toEqual({ day: 16, dow: 5 });
    expect(zonedDay(inst, "Asia/Tokyo")).toEqual({ day: 17, dow: 6 });
    // Null means the browser frame, i.e. exactly what the Date getters answer.
    expect(zonedDay(inst, null)).toEqual({ day: inst.getDate(), dow: inst.getDay() });
  });
  it("builds a 42-day month grid starting on week start", () => {
    const g = monthGrid(new Date(2024, 1, 15), 1);
    expect(g).toHaveLength(42);
    expect(g[0]!.getDay()).toBe(1);
  });
});
