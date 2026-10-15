/**
 * The two that can make a label — the catalogue and the picker on a message —
 * ask one rule, so a keyword cannot be right in one surface and loose in the
 * other: the keyword is derived from the name and refused when it is taken, and
 * the swatch is the next of the fixed palette.
 */
import { describe, expect, it } from "vitest";
import { CALENDAR_COLORS } from "@/lib/calendarColors";
import { labelKeywordFromName, newLabel } from "@/lib/labelKeyword";
import type { Label } from "@/store/settings";

const label = (keyword: string): Label => ({ keyword, name: keyword, color: "#000" });

describe("labelKeywordFromName", () => {
  it("derives the stable keyword from the display name", () => {
    expect(labelKeywordFromName("Invoices")).toBe("invoices");
    expect(labelKeywordFromName("Trip 2026!")).toBe("trip_2026");
    expect(labelKeywordFromName("  Work  ")).toBe("work");
  });

  it("still mints a keyword when nothing survives the slug", () => {
    // A name of punctuation trims to something, but the slug is empty, and an
    // empty keyword is a label the server would refuse.
    expect(labelKeywordFromName("!!!")).toMatch(/^label\d+$/);
  });
});

describe("newLabel", () => {
  it("makes a label from the name, the derived keyword and the next swatch", () => {
    expect(newLabel("Invoices", [])).toEqual({
      keyword: "invoices",
      name: "Invoices",
      color: CALENDAR_COLORS[0],
    });
    expect(newLabel("  Trip 2026!  ", [label("invoices")])).toEqual({
      keyword: "trip_2026",
      name: "Trip 2026!",
      color: CALENDAR_COLORS[1],
    });
  });

  it("refuses a keyword that is already taken", () => {
    expect(newLabel("Invoices", [label("invoices")])).toBeNull();
    // Taken by the derived keyword, not by the name: renaming is display only.
    expect(newLabel("INVOICES", [label("invoices")])).toBeNull();
  });

  it("refuses an empty name rather than minting a keyword for nothing", () => {
    expect(newLabel("   ", [])).toBeNull();
    expect(newLabel("", [])).toBeNull();
  });
});
