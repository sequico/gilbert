import { pollWhileVisible } from "./visiblePoll";

/**
 * How often the worker's own script is asked for.
 *
 * The browser re-fetches `sw.js` on navigation and on a schedule of its own
 * that can be a day or more; asking on a timer is what makes a corrected or
 * version-bumped worker land in the same session rather than days later. The
 * request is tiny and the worker's bytes rarely change, so an hour is often
 * enough and cheap.
 */
export const SW_UPDATE_MS = 60 * 60 * 1000;

/**
 * Ask a registration for its script on a timer, while the page is visible.
 *
 * This lands a corrected or re-versioned worker in a tab that has not
 * navigated; the shell itself is refreshed on each navigation (`refreshShell`,
 * `web/public/sw.js`), and what notices an actual deploy is the version check
 * in `staleBuild.ts` -- the worker's bytes rarely change with a build, so the
 * two are complements, not the same mechanism. Returns a disposer.
 */
export function scheduleServiceWorkerUpdate(
  reg: ServiceWorkerRegistration,
  ms: number = SW_UPDATE_MS,
): () => void {
  return pollWhileVisible(() => {
    void reg.update().catch((err) => {
      /* Offline, or the server refused: the next tick tries again. Anything
         else is unexpected, and worth a word rather than silence. */
      console.warn("[gilbert] service worker update failed:", err);
    });
  }, ms);
}
