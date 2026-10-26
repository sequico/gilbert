/**
 * The surfaces of a group's own account, and what a run may do on each
 * (ADR 0038).
 *
 * One definition for both tiers: the instruction's parser and the guard read it,
 * the run document carries it, and the Administration editor draws it. A mode is not an
 * authority class (ADR 0028): it says **where** a run may act, never that a
 * destructive act needs no person's word.
 *
 * - `off`: no wake, no write. Reading stays free — a reading is proof, not an
 *   act.
 * - `watch`: the surface wakes a run, and the run may write it inside the
 *   turn that wake opened.
 * - `ondemand`: the surface never wakes a run; an open run may write it.
 *
 * Chat is always `watch`: the conversation is where the group calls the agent
 * and where its report is written.
 */

export type SurfaceMode = "off" | "watch" | "ondemand";

/** Every surface the matrix names, in the order the editor draws them. */
export type SurfaceName =
  | "chat"
  | "mail"
  | "files"
  | "knowledge"
  | "workorder"
  | "calendar";

/** The surfaces in the editor's order. */
export const SURFACES: readonly SurfaceName[] = [
  "chat",
  "mail",
  "files",
  "knowledge",
  "workorder",
  "calendar",
];

/**
 * The matrix of a group that declares nothing to work on: the conversation, and
 * nothing else. A group that writes an instruction and ticks no area has told the
 * agent about the chat and about nothing more, and the matrix says exactly that
 * rather than handing it every surface the account has.
 */
export const CHAT_ONLY: SurfaceMatrix = {
  chat: "watch",
  mail: "off",
  files: "off",
  knowledge: "off",
  workorder: "off",
  calendar: "off",
};

/** One rule's matrix: what wakes it and what it may touch. */
export interface SurfaceMatrix {
  chat: "watch";
  mail: SurfaceMode;
  files: SurfaceMode;
  knowledge: SurfaceMode;
  workorder: SurfaceMode;
  calendar: SurfaceMode;
}

/** Whether a value is a mode a surface can have. */
export function isSurfaceMode(x: unknown): x is SurfaceMode {
  return x === "off" || x === "watch" || x === "ondemand";
}

/** Whether a value is a complete matrix this build writes. */
export function isSurfaceMatrix(x: unknown): x is SurfaceMatrix {
  if (!x || typeof x !== "object") return false;
  for (const surface of SURFACES) {
    if (!isSurfaceMode((x as Record<string, unknown>)[surface])) return false;
  }
  return (x as { chat?: unknown }).chat === "watch";
}
