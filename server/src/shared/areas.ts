/**
 * The agent's areas, as both tiers name them (ADR 0038).
 *
 * An area is a module of tools with one concern: posta, files, calendario,
 * contatti, conoscenza, workorder, chat, memoria. A run is handed the areas its
 * change and its instruction declare, plus the three every run needs — chat (the
 * interface), conoscenza (the shared library) and memoria (what the installation
 * knows).
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
 * How many areas one group's instruction may declare.
 *
 * Three is the ceiling that keeps a turn's catalogue small: an instruction that
 * names five is thirty tools in one answer, which is the failure ADR 0038 exists
 * to undo. A group that needs more writes two instructions' worth of work as two
 * groups, or narrows the one it has.
 */
export const MAX_DECLARED_AREAS = 3;

/** The areas every run gets, whatever its change and instruction say. */
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
 * change's (the change is the trigger, ADR 0038) — this is the ceiling, not the
 * routing.
 */
export function declaredAreas(areas: readonly string[]): {
  areas: readonly AreaName[];
  problem: string | null;
} {
  const known = areas.filter((one): one is AreaName => isAreaName(one));
  const unknown = areas.filter((one) => !isAreaName(one));
  if (unknown.length)
    return {
      areas: known,
      problem: `There is no area called ${unknown.map((one) => `"${one}"`).join(", ")}. The areas are: ${AREA_NAMES.join(", ")}.`,
    };
  if (known.length > MAX_DECLARED_AREAS)
    return {
      areas: known,
      problem: `An instruction may declare at most ${MAX_DECLARED_AREAS} areas, and this one declares ${known.length}: ${known.join(", ")}. Split the work into two groups, or narrow what this one does.`,
    };
  return { areas: known, problem: null };
}
