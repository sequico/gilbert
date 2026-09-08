import { afterEach, describe, expect, it, vi } from "vitest";
import { VIEW_LOAD_TIMEOUT_MS, withViewTimeout } from "@/lib/lazyView";

/*
 * A view chunk that hangs is the same failure as one that 404s — a dead
 * connection does not answer, and without the timeout the spinner would sit
 * there until a human reloads. The timeout turns the hang into a rejection,
 * which is what the crash boundary knows how to answer.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("withViewTimeout", () => {
  it("resolves with the loader's value when the loader wins", async () => {
    await expect(withViewTimeout(Promise.resolve("ok"), 1_000)).resolves.toBe("ok");
  });

  it("keeps the loader's own rejection", async () => {
    const loader = Promise.reject(new Error("chunk 404"));
    await expect(withViewTimeout(loader, 1_000)).rejects.toThrow("chunk 404");
  });

  it("rejects when the loader never settles, once the timeout passes", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const pending = withViewTimeout(never, 500);
    const assertion = expect(pending).rejects.toThrow(/did not load/);
    vi.advanceTimersByTime(500);
    await assertion;
  });

  it("clears its timer when the loader wins", async () => {
    vi.useFakeTimers();
    const pending = withViewTimeout(Promise.resolve("ok"), 500);
    await expect(pending).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to the view timeout", () => {
    expect(VIEW_LOAD_TIMEOUT_MS).toBe(20_000);
  });
});
