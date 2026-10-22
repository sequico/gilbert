/**
 * A group's instruction, written through the administration's door (ADR 0038).
 *
 * A group's instruction is decided by an installation administrator (owner
 * decision 2026-10-18), so this tier does not write the group's account itself:
 * it calls the routes under `/api/admin/groups/<name>` and the server writes as
 * the Master, behind the same door as the rest of the administration. That is
 * what makes the decision a boundary rather than a hidden button.
 *
 * The shapes are the server's own (`@gilbert/shared/instruction` and
 * `@gilbert/shared/areas`), the document is validated by the server's parser,
 * and the write is a compare-and-set: the state a read answered is sent back,
 * and a write whose account moved under it is refused with 409.
 */

import type { AreaName } from "@gilbert/shared/areas";
import { apiFetch } from "@/jmap/client";

/** One group's instruction, as the route answers it. */
export interface GroupInstruction {
  instruction: string;
  /** The areas the group works: the whole of what a run may change. */
  areas: AreaName[];
  /** The account's FileNode state the read saw: what a write is conditioned on. */
  state: string;
  /**
   * The document this build could not read, in its own words. The instruction
   * and areas above are empty, and writing a new one replaces it.
   */
  unreadable?: string;
}

function prosePath(group: string, rest = ""): string {
  return `/api/admin/groups/${encodeURIComponent(group)}/prose${rest}`;
}

/** Read a group's instruction and the areas it works. */
export async function readGroupInstruction(group: string): Promise<GroupInstruction> {
  return await apiFetch<GroupInstruction>(prosePath(group));
}

/** Save the instruction and its areas; an emptied field leaves no document behind. */
export async function saveInstruction(
  group: string,
  text: string,
  areas: readonly AreaName[],
  state?: string,
): Promise<void> {
  await apiFetch(prosePath(group, "/instruction"), {
    method: "PUT",
    body: JSON.stringify({
      instruction: text,
      areas,
      ...(state ? { ifInState: state } : {}),
    }),
  });
}
