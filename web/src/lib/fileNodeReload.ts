/**
 * A debounced re-read, keyed by whatever the caller groups its events by.
 *
 * Two stores follow a FileNode they do not own — a group's agent documents
 * (`store/agents.ts`) and a group's label catalog (`store/groupLabels.ts`) —
 * and both hear about a change the same way: a push `StateChange` names an
 * account and a type and nothing else, so a burst of events cannot be told
 * apart from one, and every event for the same key costs the same read. Each
 * carried the same twelve lines: a timer per key, cleared and reset on every
 * event, so a burst settles into one read `RELOAD_DEBOUNCE_MS` after the last
 * of it. The two agreed on the delay, on the comment and on the arithmetic,
 * which is one place away from agreeing on nothing.
 *
 * **Not the same mechanism as the `StateChange` dispatch in `web/src/App.tsx`,
 * and the difference is not cosmetic.** That one collects *every* account and
 * type of a burst into a single pass, because the stores it feeds each route
 * the accounts they hold, and it fires from the first event of the burst. This
 * one is per key and fires from the last, because each of its two readers
 * re-reads exactly one thing: the group that is open, the account whose
 * catalog it is holding. They share the window (`RELOAD_DEBOUNCE_MS`), not
 * the shape.
 */

/** How long a burst of events for one key is coalesced before the read. */
export const RELOAD_DEBOUNCE_MS = 400;

export interface DebouncedReload {
  /** Re-read this key once, `RELOAD_DEBOUNCE_MS` after the last event for it. */
  schedule(key: string, read: () => void): void;
}

/**
 * One debounce per key, with its timers in the closure: a caller declares
 * nothing and holds no map. A second read scheduled for a key that already has
 * one waits for that key alone — the point of keying, since a burst on one
 * account must not hold up the other's.
 */
export function debouncedReload(delayMs: number = RELOAD_DEBOUNCE_MS): DebouncedReload {
  const timers: Record<string, number> = {};
  return {
    schedule(key, read) {
      if (timers[key]) clearTimeout(timers[key]);
      timers[key] = window.setTimeout(() => {
        delete timers[key];
        read();
      }, delayMs);
    },
  };
}
