/**
 * When a catch-up pass may start while the live stream is down.
 *
 * The stream's own retry keeps its one second (`PUSH_RETRY_MS`), so it comes
 * back the instant the server does; the reachability probe behind each failed
 * attempt rides that same second and every pass re-reads the whole account —
 * mail, the open conversation with bodies, contacts, calendar, files. Without a
 * floor a blocked stream runs those passes back to back for as long as the tab
 * is open, per tab.
 *
 * The floor measures **completed** passes: `lastPassAt` is stamped when a pass
 * ends, not when it starts, so a pass that outlives the floor does not hand the
 * next probe a free start. A reconnect and a line coming back do not wait it
 * out — they are followed at once — which is why both are decided by their own
 * triggers and not through this.
 */

/** The floor between two probe-driven passes, in milliseconds. */
export const CATCH_UP_FLOOR_MS = 30_000;

export function shouldCatchUp(input: {
  /** Whether the probe found the server reachable. */
  reachable: boolean;
  /** Whether the live stream is up (it is the catch-up trigger when it is). */
  connected: boolean;
  /** When the last pass *ended*, or 0 when none has run. */
  lastPassAt: number;
  now: number;
  floorMs?: number;
}): boolean {
  if (!input.reachable || input.connected) return false;
  return input.now - input.lastPassAt >= (input.floorMs ?? CATCH_UP_FLOOR_MS);
}
