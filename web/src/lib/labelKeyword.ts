import type { Label } from "@/store/settings";
import { CALENDAR_COLORS } from "@/ui/misc";

/**
 * The keyword a new label gets from its display name. The keyword is the
 * stable identity that rides on the message; the name is display only, so
 * renaming a label later never touches this.
 */
export function labelKeywordFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || `label${Date.now()}`;
}

/**
 * The next swatch of the fixed palette, by how many entries there already are,
 * so a list that grows has distinguishable colours without anybody choosing
 * one. Labels and calendar entries both grow this way; the step is one rule,
 * and a second copy of `count % length` is a second answer to it.
 */
export function nextPaletteColor(taken: number): string {
  return CALENDAR_COLORS[taken % CALENDAR_COLORS.length]!;
}

/**
 * The label a new one is, given the catalogue it joins: keyword from the name,
 * the next swatch of the fixed palette, and null when the keyword is taken.
 *
 * The two that can make a label are the catalogue and the picker on a message,
 * and they asked the same question: a list that grows has distinguishable
 * colours without anybody choosing one, and the keyword is the stable identity,
 * so two labels cannot share it. `newLabel` answers it once, so a keyword rule
 * cannot be right in one surface and loose in the other.
 */
export function newLabel(name: string, existing: readonly Label[]): Label | null {
  const label = name.trim();
  if (!label) return null;
  const keyword = labelKeywordFromName(label);
  if (existing.some((l) => l.keyword === keyword)) return null;
  return { keyword, name: label, color: nextPaletteColor(existing.length) };
}
