/**
 * The agent's areas, as both tiers name them (ADR 0038).
 *
 * An area is a module of tools with one concern: mail, files, calendar,
 * contacts, knowledge, workorders, chat, memory. A run is handed the areas its
 * instruction declares and its surface matrix names, plus the two every run
 * needs — chat (the interface) and memory (what the installation knows).
 *
 * **Knowledge is declared, never assumed**: reading the base is free, so a run
 * without the area still opens its pages; proposing one is a write, and only a group
 * that ticked the area may. The same holds for mail, files, calendar, contacts and
 * workorders.
 *
 * The **vocabulary** lives here because both tiers use it: the server selects a
 * run's catalogue from it, and a member's client draws the areas an instruction
 * may declare. Which tool belongs to which area, and how a catalogue is selected,
 * is the server's (`agent/areas.ts`) — a client has no catalogue to select.
 */

import { CHAT_ONLY, SURFACES, type SurfaceMatrix, type SurfaceName } from "./surfaces.js";

/** The areas the agent works in. */
export const AREA_NAMES = [
  "mail",
  "files",
  "calendar",
  "contacts",
  "knowledge",
  "workorders",
  "chat",
  "memory",
] as const;

export type AreaName = (typeof AREA_NAMES)[number];

/**
 * The areas every run gets, whatever its change and instruction say.
 *
 * They are always on: the conversation is the interface and memory is what the
 * installation knows. **Knowledge is not one of them**: reading the base is free —
 * `open` is never narrowed — and proposing a page is a write, so it is an area a
 * group declares like mail or files, and a group that does not declare it reads the
 * base and cannot change it.
 */
export const TRANSVERSAL_AREAS: readonly AreaName[] = ["chat", "memory"];

/**
 * The matrix a run may write through, derived from the areas it works.
 *
 * The areas are the whole of what a run may change (ADR 0038); the instruction's
 * own `surfaces` is what **wakes** it. A run therefore carries the areas as a
 * matrix, with the conversation always writable, so an area ticked for writing
 * is not refused because its surface was left out of the wake row. The surface an
 * area writes to is `areaOfSource`, the one mapping both lists read; contacts and
 * memory have no surface, and their writes are gated by the catalogue and the
 * authority guard instead.
 */
export function writeSurfacesOf(areas: readonly AreaName[]): SurfaceMatrix {
  const matrix: SurfaceMatrix = { ...CHAT_ONLY };
  for (const surface of SURFACES) {
    const area = areaOfSource(surface);
    if (area && areas.includes(area)) matrix[surface] = "watch";
  }
  return matrix;
}

/** Whether a name is one of the areas. */
export function isAreaName(name: string): name is AreaName {
  return (AREA_NAMES as readonly string[]).includes(name);
}

/**
 * The area a change on a surface falls in, or null when the surface is not one
 * of the group's (`activity`, the installation's own bookkeeping).
 */
export function areaOfSource(source: string): AreaName | null {
  if (source === "workorder") return "workorders";
  return isAreaName(source) ? source : null;
}

/**
 * The surface a change on this area is reported as, or null when the area has
 * none.
 *
 * The inverse of `areaOfSource`, written once because the wake row draws each
 * area's surface beside the area itself: **contacts and memory have no surface**,
 * so no change on them can wake a run (ADR 0038). A client with one list and two
 * spellings would draw a wake row that does not match the areas it sits under.
 */
export function surfaceOfArea(area: AreaName): SurfaceName | null {
  for (const surface of SURFACES) if (areaOfSource(surface) === area) return surface;
  return null;
}

/**
 * What a group declares, or the sentence that refuses it.
 *
 * The declared areas are what an instruction states its group works; a change
 * that lands in an area nobody declared is still worked if its own area is the
 * change's (the change is the trigger, ADR 0038) — this is the statement, not
 * the routing. Every area may be declared: the ceiling on the catalogue is the
 * selection of the run, not a limit on what a group says it works.
 */
export function declaredAreas(areas: readonly string[]): {
  areas: readonly AreaName[];
  problem: string | null;
} {
  const known = [...new Set(areas.filter((one): one is AreaName => isAreaName(one)))];
  const unknown = areas.filter((one) => !isAreaName(one));
  if (unknown.length)
    return {
      areas: known,
      problem: `There is no area called ${unknown.map((one) => `"${one}"`).join(", ")}. The areas are: ${AREA_NAMES.join(", ")}.`,
    };
  return { areas: known, problem: null };
}
