import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, client } from "@/jmap/client";

/**
 * A browser request that gets no answer is bounded in time.
 *
 * A connection that opens and then goes silent -- a proxy holding the socket,
 * half-open TCP after a suspend -- left the promise pending for ever, and the
 * store awaiting it kept `loading: true` with no error to show and no retry.
 * Each leg carries its server leg's own deadline (`lib/deadline.ts`), so the
 * two tiers give up together; the caller's own signal is kept beside it, so a
 * cancelled pass still cancels the request.
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

describe("the request deadline", () => {
  it("gives a JSON-RPC call that goes silent the server leg's own deadline", async () => {
    vi.useFakeTimers();
    const seen: { signal?: AbortSignal } = {};
    vi.stubGlobal("fetch", silentFetch(seen));

    const p = apiFetch("/api/jmap", { method: "POST", body: "{}" });
    const settled = expect(p).rejects.toBeDefined();

    // Half a minute in, the socket is open and nothing has happened yet.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(seen.signal?.aborted).toBe(true);
  });

  it("gives a blob download the five minutes the blob route allows", async () => {
    vi.useFakeTimers();
    const seen: { signal?: AbortSignal } = {};
    vi.stubGlobal("fetch", silentFetch(seen));

    const p = client.fetchBlob("acc", "b1");
    const settled = expect(p).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(seen.signal?.aborted).toBe(true);
  });

  it("gives a text blob download the same blob deadline", async () => {
    vi.useFakeTimers();
    const seen: { signal?: AbortSignal } = {};
    vi.stubGlobal("fetch", silentFetch(seen));

    const p = client.fetchBlobText("acc", "b1");
    const settled = expect(p).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
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

  it("bounds the body, not only the headers", async () => {
    /*
     * The failure the deadline is for is the promise that never settles, and a
     * proxy that answers the request line and then goes silent leaves the *body*
     * pending: a bound that ends when the headers arrive is no bound at all. The
     * response resolves here and its body never does, so a client that reads it
     * outside the deadline hangs for ever and this test never settles.
     */
    vi.useFakeTimers();
    const seen: { signal?: AbortSignal } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        seen.signal = signal;
        const body = new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => body,
        } as unknown as Response);
      }),
    );

    const p = apiFetch("/api/jmap", { method: "POST", body: "{}" });
    const settled = expect(p).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(29_000);
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(seen.signal?.aborted).toBe(true);
  });
});
