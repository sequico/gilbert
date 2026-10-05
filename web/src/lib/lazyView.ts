import { type ComponentType, lazy } from "react";

/**
 * How long a lazy view may take to load before the attempt is given up.
 *
 * A view chunk is a few hundred kilobytes at most; on any connection that
 * works at all it arrives in seconds. A request that has not settled in
 * twenty is not slow, it is stuck — most often on a connection that died
 * while the tab sat idle and whose death the browser has not noticed yet.
 * Left alone it would hang for minutes (until the OS notices the dead
 * socket), which looks exactly like the blank page this timeout exists to
 * turn into a recovery.
 */
export const VIEW_LOAD_TIMEOUT_MS = 20_000;

/**
 * Race a loader against a timeout.
 *
 * The losing side needs no cancellation: when the timeout wins the page is
 * about to reload, and when the loader wins the timer is cleared below. A
 * late rejection of the timed-out promise is harmless — `Promise.race` has
 * already attached a handler to it, so it is not an unhandled rejection.
 */
export function withViewTimeout<T>(
  loader: Promise<T>,
  ms = VIEW_LOAD_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The view did not load within ${Math.round(ms / 1000)}s.`)),
      ms,
    );
  });
  return Promise.race([loader, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `lazy()` for a chunk that hangs is a failure like any other, so it reaches
 * the crash boundary instead of leaving a spinner forever. Used for a route
 * view, and for the pieces a reader opens on an action (`views/lazyPieces.ts`).
 */
// biome-ignore lint/suspicious/noExplicitAny: React's own lazy() constrains T the same way; a narrower bound rejects class components.
export function lazyView<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  ms = VIEW_LOAD_TIMEOUT_MS,
) {
  return lazy<T>(() => withViewTimeout(loader(), ms));
}
