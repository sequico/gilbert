/**
 * Waiting, once, for the server tier.
 *
 * Three callers wait on it: the agent store's write-back retry, the boot's
 * sign-in retry (behind an injectable default, so a test can skip the wait) and
 * the agent's own session-retry backoff. A sleep is the whole of what they need
 * and the whole of what this is: no cancellation, no clock, nothing that has to
 * agree with anything.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
