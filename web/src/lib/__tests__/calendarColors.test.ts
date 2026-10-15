/**
 * The fixed palette a new entry is coloured from, and the step that walks it: a
 * list that grows takes the next swatch rather than running out or repeating.
 */
import { describe, expect, it } from "vitest";
import { CALENDAR_COLORS, nextPaletteColor } from "@/lib/calendarColors";

describe("nextPaletteColor", () => {
  it("cycles the fixed palette by how many are already taken", () => {
    expect(nextPaletteColor(0)).toBe(CALENDAR_COLORS[0]);
    expect(nextPaletteColor(1)).toBe(CALENDAR_COLORS[1]);
    // Past the end it starts over rather than running out.
    expect(nextPaletteColor(CALENDAR_COLORS.length)).toBe(CALENDAR_COLORS[0]);
    expect(nextPaletteColor(CALENDAR_COLORS.length + 3)).toBe(CALENDAR_COLORS[3]);
  });
});
