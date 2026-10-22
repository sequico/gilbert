/**
 * The agent's areas — ADR 0038.
 *
 * Each area is a module of tools with one concern: posta, files, calendario,
 * contatti, conoscenza, workorder, chat, memoria. A run is handed **the areas its
 * instruction declares and its surface matrix names**, plus the three that every
 * run needs — chat (the interface), conoscenza (the shared library) and memoria
 * (what the installation knows).
 *
 * This file is the one place that says which area a tool belongs to: a new tool
 * names its area here, and nothing else in the tree repeats the mapping. The
 * catalogue a turn sees is computed from it, so the model never again reads
 * forty-five names to use four.
 */

import {
  AREA_NAMES,
  type AreaName,
  areaOfSource,
  TRANSVERSAL_AREAS,
} from "../shared/areas.js";
import type { SurfaceMatrix } from "../shared/surfaces.js";

/**
 * Prefixes that name no area: the agent's own record (`run.read`), which every
 * run may consult, is a tool of the harness rather than of a product surface.
 */
export const CONTEXT_TOOL_PREFIXES: readonly string[] = ["run"];

function prefixOf(toolName: string): string | null {
  const dot = toolName.indexOf(".");
  return dot > 0 ? toolName.slice(0, dot) : null;
}

/** A tool's prefix is the area's own name, and `areaOfSource` is the one mapping
 * (`workorder` is the workorders area) — there is no second table to keep. */
function areaOrNull(toolName: string): AreaName | null {
  const prefix = prefixOf(toolName);
  return prefix === null ? null : areaOfSource(prefix);
}

/** Whether a tool belongs to an area rather than to the harness. */
export function isAreaTool(toolName: string): boolean {
  return areaOrNull(toolName) !== null;
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
  const found = areaOrNull(toolName);
  if (found === null)
    throw new Error(
      `The tool "${toolName}" names no area: its name must be area.action, with area one of ${AREA_NAMES.join(", ")}.`,
    );
  return found;
}

/**
 * The areas one run may use: what its group's instruction declares and what the
 * run's own surface matrix named, plus the transversal three.
 *
 * Two declarations while the matrix is still in the tree: the instruction names
 * the areas, and the matrix says where it may act. A run with neither has nothing
 * to select from and is handed the whole catalogue, which is what every run got
 * before the areas existed.
 */
export function selectedAreas(
  declared: readonly AreaName[],
  surfaces: SurfaceMatrix | undefined,
): readonly AreaName[] | null {
  if (!declared.length && !surfaces) return null;
  const held = new Set<AreaName>([...TRANSVERSAL_AREAS, ...declared]);
  if (surfaces) for (const area of areasOfSurfaces(surfaces)) held.add(area);
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
    // `off` neither wakes nor writes; `watch` and `ondemand` both belong to a
    // catalogue that may act on them.
    if (mode === "off") continue;
    const area = areaOfSource(surface);
    if (area) held.add(area);
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
