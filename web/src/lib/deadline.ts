/**
 * Run a request under a deadline, keeping the caller's own cancellation beside
 * it: the request is aborted when `ms` elapse or when `caller` aborts, whichever
 * comes first, and the timer is dropped the moment the request settles.
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
  const timer = window.setTimeout(() => controller.abort(), ms);
  const forward = () => controller.abort();
  if (caller?.aborted) forward();
  else caller?.addEventListener("abort", forward, { once: true });
  return request(controller.signal).finally(() => {
    window.clearTimeout(timer);
    caller?.removeEventListener("abort", forward);
  });
}
