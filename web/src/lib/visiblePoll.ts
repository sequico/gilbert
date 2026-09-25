/**
 * Run something on a timer while the page is visible, and once when it becomes
 * visible again.
 *
 * A hidden page is not being read, and browsers throttle or freeze its timers,
 * so a poll that fired regardless would spend requests nobody sees and drift
 * from the cadence it claims. This is the one definition of that policy: the
 * build watch (`staleBuild.ts`), the admin fleet's status read
 * (`views/admin/AdminAgents.tsx`) and the service worker's update ask
 * (`serviceWorkerUpdate.ts`) all run through it.
 *
 * Returns a disposer that stops the timer and drops the listener.
 */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
  const tick = () => {
    if (document.visibilityState === "visible") fn();
  };
  const id = window.setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", tick);
  };
}
