/**
 * The surfaces of a group's own account, and what a rule may do on each
 * (ADR 0035).
 *
 * One definition for both tiers: the rule's parser and guard read it, the run
 * document carries it, and the Administration editor draws it. A mode is not an
 * authority class (ADR 0032): it says **where** a run may act, never that a
 * destructive act needs no person's word.
 *
 * - `off`: no wake, no write. Reading stays free — a reading is proof, not an
 *   act.
 * - `watch`: the surface wakes the rule, and the rule may write it inside the
 *   run that wake opened.
 * - `ondemand`: the surface never wakes the rule; an open run may write it.
 *
 * Chat is always `watch`: the conversation is where the group calls the agent
 * and where its report is written.
 */

export type SurfaceMode = "off" | "watch" | "ondemand";

/** Every surface a rule's matrix names, in the order the editor draws them. */
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
