/**
 * The server's shutdown, with a ceiling on every wait.
 *
 * A deploy is a shutdown, and a shutdown that does not finish is worse than a
 * slow one: systemd waits `TimeoutStopSec` (90 s on the deployment) and then
 * sends SIGKILL, so the process dies without releasing its push subscriptions,
 * without parking the run it was working, and — the case that made this a bug —
 * with the agent's loop still starting runs after the signal.
 *
 * The ordering is the point, and it is not the obvious one:
 *
 * 1. **The agent stops first**, before anything is awaited. Its loop opens runs
 *    on a timer, so a stop that waits behind a drain is a loop that keeps
 *    working during it. Nothing may start after the signal, whatever else takes
 *    its time.
 * 2. **The HTTP server drains**, letting a response in flight finish, bounded by
 *    `DRAIN_MS`; an event stream that never closes must not hold the process.
 * 3. **Subscriptions are released before the sessions go** — releasing one needs
 *    a live credential, and a subscription left behind holds one of the account's
 *    slots for as long as it lives.
 * 4. **The whole thing has a deadline** (`SHUTDOWN_DEADLINE_MS`), after which the
 *    process exits anyway. It sits below systemd's own timeout on purpose: the
 *    exit is ours, in order, and not a SIGKILL in the middle of the steps above.
 */

/** How long the drain waits for connections in flight before letting them go. */
export const DRAIN_MS = 5_000;
/** The whole shutdown's ceiling, below systemd's `TimeoutStopSec` of 90 s. */
export const SHUTDOWN_DEADLINE_MS = 10_000;

/** The HTTP server's own close helpers, as far as this module needs them. */
export interface DrainableServer {
  close(callback?: () => void): void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

/** What the shutdown does, in order, each step a function this module bounds. */
export interface ShutdownParts {
  server: DrainableServer;
  /** Stop the agent's loop: after this, no run starts. */
  stopAgent: () => Promise<void>;
  releaseSubscriptions: () => Promise<void>;
  closeSessions: () => Promise<void>;
  /** `process.exit`, so a test can watch for it. */
  exit: (code: number) => void;
  log?: (line: string) => void;
  /** The drain's ceiling, so a test does not wait the deployment's five seconds. */
  drainMs?: number;
}

/**
 * Wait for `work`, or stop waiting after `ms`.
 *
 * A step that hangs is not the shutdown's to fix: it is bounded, said, and left
 * — the process is going away, and every step after it still runs.
 */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run the shutdown: bounded, in order, and always exiting. */
export async function shutDown(signal: string, parts: ShutdownParts): Promise<void> {
  const log = parts.log ?? (() => undefined);
  const drainMs = parts.drainMs ?? DRAIN_MS;
  log(`[gilbert] ${signal} received, shutting down`);

  /*
   * Started, not awaited: the drain can take as long as a client keeps a
   * connection, and the loop must not keep opening runs while it does.
   */
  const agentStopped = parts.stopAgent().catch((err) => {
    log(`[gilbert] the agent did not stop cleanly: ${String(err)}`);
  });

  const closed = new Promise<void>((resolve) => parts.server.close(() => resolve()));
  parts.server.closeIdleConnections?.();
  const force = setTimeout(() => parts.server.closeAllConnections?.(), drainMs);
  force.unref();
  const drained = await within(closed, drainMs);
  clearTimeout(force);
  if (!drained) log("[gilbert] a connection did not close, going on without it");

  await within(agentStopped, SHUTDOWN_DEADLINE_MS);
  await within(parts.releaseSubscriptions(), drainMs);
  await within(parts.closeSessions(), drainMs);
  parts.exit(0);
}

/**
 * The ceiling on the whole shutdown, armed at the signal.
 *
 * `shutDown` bounds each step, but a step may not be the one that hangs (a
 * `close` callback that never fires, a promise chain that never settles). This
 * arms the one exit that is guaranteed, so the process is gone before systemd's
 * SIGKILL and the log says which way it went.
 */
export function armDeadline(
  ms: number,
  exit: (code: number) => void,
  log: (line: string) => void = () => undefined,
): void {
  const timer = setTimeout(() => {
    log(`[gilbert] the shutdown passed ${ms} ms, exiting anyway`);
    exit(0);
  }, ms);
  timer.unref();
}
