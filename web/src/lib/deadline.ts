/**
 * Why a request under a deadline was cut off.
 *
 * `abort()` without a reason rejects with the browser's own `AbortError`, which
 * is the same object a caller's cancellation produces — so a request that
 * stalled for the full deadline was reported as one the person stopped, with
 * nothing to tell them apart. The controller is aborted with this marker
 * instead, and the rejection carries it, so "it never answered" and "I stopped
 * it" are two answers the caller can act on differently: the first is worth
 * retrying, the second is not.
 */
const DEADLINE_ELAPSED = Symbol("gilbert:deadline");

/** The rejection a deadline produces, in place of the browser's `AbortError`. */
export class DeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`no answer in ${ms}ms`);
    this.name = "DeadlineError";
  }
}

/**
 * Run a request under a deadline, keeping the caller's own cancellation beside
 * it: the request is aborted when `ms` elapse or when `caller` aborts, whichever
 * comes first, and the timer is dropped the moment the request settles — or
 * throws before it returns a promise at all, which is why the call is awaited
 * inside a `try` rather than chained after it.
 *
 * What the deadline bounds is the whole of `request`, so a caller that reads a
 * body must read it *inside* `request`: a deadline that ends when the response's
 * headers arrive is not a bound on the promise the reader is waiting for.
 *
 * `AbortSignal.timeout` and `AbortSignal.any` express this in two calls, but
 * `any` needs Safari 17.4 and this app runs on the iOS 16.4 floor its PWA
 * support targets; nothing here polyfills a runtime API. The composition is
 * hand-rolled the way `staleBuild.ts` does it -- a controller, a `window`
 * timer, and the caller's signal forwarded into it -- so every request in the
 * client shares one definition of "this dies at this moment".
 */
export function withDeadline<T>(
  ms: number,
  caller: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(DEADLINE_ELAPSED), ms);
  const forward = () => controller.abort();
  if (caller?.aborted) forward();
  else caller?.addEventListener("abort", forward, { once: true });
  return (async () => {
    try {
      return await request(controller.signal);
    } catch (err) {
      if (controller.signal.reason === DEADLINE_ELAPSED) throw new DeadlineError(ms);
      throw err;
    } finally {
      window.clearTimeout(timer);
      caller?.removeEventListener("abort", forward);
    }
  })();
}
