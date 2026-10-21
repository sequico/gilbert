/**
 * The agent's areas — ADR 0038.
 *
 * Each area is a module of tools with one concern: posta, files, calendario,
 * contatti, conoscenza, workorder, chat, memoria. A run is handed **the areas its
 * change and its instruction declare**, plus the three that every run needs —
 * chat (the interface), conoscenza (the shared library) and memoria (what the
 * installation knows).
 *
 * This file is the one place that says which area a tool belongs to: a new tool
 * names its area here, and nothing else in the tree repeats the mapping. The
 * catalogue a turn sees is computed from it, so the model never again reads
 * forty-five names to use four.
 */

import type { SurfaceMatrix } from "../shared/surfaces.js";

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

/** A tool's prefix where the area's own name differs from it. */
const AREA_ALIASES: Readonly<Record<string, AreaName>> = { workorder: "workorders" };

/**
 * Prefixes that name no area: the agent's own record (`run.read`), which every
 * run may consult, is a tool of the harness rather than of a product surface.
 */
export const CONTEXT_TOOL_PREFIXES: readonly string[] = ["run"];

function prefixOf(toolName: string): string | null {
  const dot = toolName.indexOf(".");
  return dot > 0 ? toolName.slice(0, dot) : null;
}

/** Whether a tool belongs to an area rather than to the harness. */
export function isAreaTool(toolName: string): boolean {
  const prefix = prefixOf(toolName);
  if (prefix === null) return false;
  return (
    AREA_ALIASES[prefix] !== undefined ||
    (AREA_NAMES as readonly string[]).includes(prefix)
  );
}

/**
 * The area a tool belongs to, from its name's own prefix.
 *
 * A tool's name is `area.action` by construction (the catalogue's naming rule),
 * so the mapping is read and not maintained twice. A name that matches no area is
 * a defect in the tool, and it is refused here rather than silently handed to
 * every run.
 */
export function areaOf(toolName: string): AreaName {
  const prefix = prefixOf(toolName);
  if (prefix === null)
    throw new Error(
      `The tool "${toolName}" names no area: its name must be area.action, with area one of ${AREA_NAMES.join(", ")}.`,
    );
  const alias = AREA_ALIASES[prefix];
  if (alias !== undefined) return alias;
  const found = AREA_NAMES.find((area) => area === prefix);
  if (!found)
    throw new Error(
      `The tool "${toolName}" names no area: its name must start with one of ${AREA_NAMES.join(", ")}.`,
    );
  return found;
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
  const known = areas.filter((one): one is AreaName =>
    (AREA_NAMES as readonly string[]).includes(one),
  );
  const unknown = areas.filter((one) => !(AREA_NAMES as readonly string[]).includes(one));
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

/**
 * The areas one run may use: its change's, its instruction's, and the transversal
 * three. Ordered, deduplicated, and never empty.
 */
export function selectAreas(
  change: AreaName,
  declared: readonly AreaName[],
): readonly AreaName[] {
  const held = new Set<AreaName>([change, ...declared, ...TRANSVERSAL_AREAS]);
  return AREA_NAMES.filter((area) => held.has(area));
}

/**
 * The areas a group's surface matrix names, leaving out the ones it turned off.
 *
 * The matrix says where a group works (`chat`, `mail`, `files`, `knowledge`,
 * `workorder`, `calendar`); this says which tools that amounts to. Chat is always
 * there: the conversation is the interface whatever the matrix says.
 */
export function areasOfSurfaces(
  surfaces: SurfaceMatrix | undefined,
): readonly AreaName[] {
  const held = new Set<AreaName>(TRANSVERSAL_AREAS);
  for (const [surface, mode] of Object.entries(surfaces ?? {})) {
    if (mode === "off") continue;
    if (surface === "workorder") held.add("workorders");
    else if ((AREA_NAMES as readonly string[]).includes(surface))
      held.add(surface as AreaName);
  }
  return AREA_NAMES.filter((area) => held.has(area));
}

/**
 * The catalogue one turn reads: the selected areas' writing tools, every area's
 * reading tools, and the harness's own (`run.read`), which is never a group's
 * business but is always available.
 *
 * Reading is free (`surfaces.ts`: a reading is proof, not an act), so the selection
 * narrows **what a run may change**, never what it may look at. A run whose group
 * declares no surface matrix has nothing to select from and is handed the whole
 * catalogue — the arrangement every run had before the areas existed.
 */
export function catalogueFor<T extends { name: string; writes?: boolean }>(
  catalogue: readonly T[],
  areas: readonly AreaName[] | null,
): readonly T[] {
  if (areas === null) return catalogue;
  return catalogue.filter(
    (tool) => !tool.writes || !isAreaTool(tool.name) || areas.includes(areaOf(tool.name)),
  );
}
