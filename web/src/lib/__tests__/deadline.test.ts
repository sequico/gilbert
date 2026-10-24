/**
 * One request, two ways it can be cut off — and they are not the same answer.
 *
 * A deadline that elapsed and a caller that cancelled both abort the request, so
 * without the marker the client reported a stalled request as one the person
 * stopped, and a caller branching on the answer fell through its own case. The
 * timer is the other half: a request that settles must not leave one behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineError, withDeadline } from "@/lib/deadline";

/** A request that never settles on its own, and rejects when its signal aborts. */
const pending = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const stop = () => reject(new DOMException("aborted", "AbortError"));
    // `fetch` refuses an already-aborted signal before the listener could ever
    // fire, and the helper has to answer the same way: a caller who cancelled
    // before the request began is still a cancellation.
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop);
  });

describe("withDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers DeadlineError when the request outlives its deadline", async () => {
    vi.useFakeTimers();
    const request = withDeadline(1_000, undefined, pending);
    const verdict = expect(request).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(1_000);
    await verdict;
  });

  it("keeps the caller's own cancellation its own answer", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const request = withDeadline(1_000, caller.signal, pending);
    const verdict = expect(request).rejects.toBeInstanceOf(DOMException);
    caller.abort();
    await verdict;
    // and the deadline it was given never fires afterwards
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it("forwards a caller that was already aborted", async () => {
    const caller = new AbortController();
    caller.abort();
    await expect(withDeadline(1_000, caller.signal, pending)).rejects.toBeInstanceOf(
      DOMException,
    );
  });

  it("drops the timer when the request settles", async () => {
    vi.useFakeTimers();
    const cleared = vi.spyOn(window, "clearTimeout");
    await expect(withDeadline(1_000, undefined, async () => "ok")).resolves.toBe("ok");
    expect(cleared).toHaveBeenCalledTimes(1);
  });
});
