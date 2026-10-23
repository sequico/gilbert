/**
 * The agent's areas, as both tiers name them (ADR 0038).
 *
 * An area is a module of tools with one concern: mail, files, calendar,
 * contacts, knowledge, workorders, chat, memory. A run is handed the areas its
 * instruction declares and its surface matrix names, plus the three every run
 * needs — chat (the interface), knowledge (the shared library) and memory (what
 * the installation knows).
 *
 * The **vocabulary** lives here because both tiers use it: the server selects a
 * run's catalogue from it, and a member's client draws the areas an instruction
 * may declare. Which tool belongs to which area, and how a catalogue is selected,
 * is the server's (`agent/areas.ts`) — a client has no catalogue to select.
 */

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
 * They are always on: the conversation is the interface, memory is what the
 * installation knows, knowledge is the shared library. They add no tools a run
 * would otherwise miss, so an instruction naming them spends nothing.
 */
export const TRANSVERSAL_AREAS: readonly AreaName[] = ["chat", "knowledge", "memory"];

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
