import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/jmap/client";

/**
 * A browser request that gets no answer is bounded in time.
 *
 * A connection that opens and then goes silent -- a proxy holding the socket,
 * half-open TCP after a suspend -- left the promise pending for ever, and the
 * store awaiting it kept `loading: true` with no error to show and no retry.
 * The deadline is the server leg's own (`config.upstreamTimeout`, thirty
 * seconds), so the two tiers give up together; the caller's own signal is kept
 * beside it, so a cancelled pass still cancels the request.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fetch that never answers, rejecting only when its own signal aborts. */
const silentFetch = (seen: { signal?: AbortSignal }) =>
  vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    seen.signal = signal;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });

describe("apiFetch's deadline", () => {
  it("gives a request that goes silent the server leg's own deadline", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const seen: { signal?: AbortSignal } = {};
    vi.stubGlobal("fetch", silentFetch(seen));

    const p = apiFetch("/api/jmap", { method: "POST", body: "{}" });
    const settled = expect(p).rejects.toBeDefined();
    expect(timeout).toHaveBeenCalledWith(30_000);

    // Half a minute in, the socket is open and nothing has happened yet.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(seen.signal?.aborted).toBe(true);
  });

  it("keeps the caller's signal, so a cancelled pass still cancels the request", async () => {
    const seen: { signal?: AbortSignal } = {};
    vi.stubGlobal("fetch", silentFetch(seen));

    const controller = new AbortController();
    const p = apiFetch("/api/jmap", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });
    const settled = expect(p).rejects.toBeDefined();
    expect(seen.signal?.aborted).toBe(false);

    controller.abort();
    await settled;
    expect(seen.signal?.aborted).toBe(true);
  });
});
