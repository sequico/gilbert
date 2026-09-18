import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debouncedReload, RELOAD_DEBOUNCE_MS } from "@/lib/fileNodeReload";

describe("debouncedReload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads once after a burst, not once per event", () => {
    const reload = debouncedReload();
    const read = vi.fn();
    for (let i = 0; i < 5; i++) reload.schedule("a", read);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS - 1);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("waits for the last event rather than the first", () => {
    // A trailing debounce: the burst ends, then the read.
    const reload = debouncedReload();
    const read = vi.fn();
    reload.schedule("a", read);
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS - 10);
    reload.schedule("a", read);
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS - 1);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keys the wait, so one key's burst is not another's", () => {
    const reload = debouncedReload();
    const one = vi.fn();
    const two = vi.fn();
    reload.schedule("a", one);
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS);
    reload.schedule("b", two);
    // The second key was scheduled after the first read and not held up by it.
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS);
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it("runs the read that was scheduled last for a key", () => {
    // What a burst means: the newest answer is the one worth reading.
    const reload = debouncedReload();
    const first = vi.fn();
    const second = vi.fn();
    reload.schedule("a", first);
    reload.schedule("a", second);
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("holds its timers in the closure, so two debounces do not share them", () => {
    const one = debouncedReload();
    const two = debouncedReload();
    const read = vi.fn();
    one.schedule("a", read);
    two.schedule("a", read);
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
