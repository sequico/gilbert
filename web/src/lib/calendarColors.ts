/**
 * The fixed palette a new entry is coloured from — a label, a calendar, an
 * event category, a subscription.
 *
 * One list, walked in order: a surface that adds an entry takes the next swatch,
 * so a list that grows has distinguishable colours without anybody choosing one.
 * The step is one rule (`nextPaletteColor`), because a second copy of
 * `count % length` is a second answer to it.
 */

/** The swatch a new entry gets when nothing has been taken yet. */
export const DEFAULT_CALENDAR_COLOR = "#0f766e";

export const CALENDAR_COLORS = [
  DEFAULT_CALENDAR_COLOR,
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#4b5563",
  "#9333ea",
  "#be123c",
];

/** The next swatch of the palette, by how many entries there already are. */
export function nextPaletteColor(taken: number): string {
  return CALENDAR_COLORS[taken % CALENDAR_COLORS.length]!;
}
