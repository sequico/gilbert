import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleServiceWorkerUpdate } from "@/lib/serviceWorkerUpdate";

/**
 * The worker's script is asked for on a timer, not on the browser's own slow
 * schedule, and only while the page is visible -- a hidden page is not being
 * read, and its timers are throttled. Each case fails if the cadence, the
 * visibility gate or the disposer is removed.
 */

let visibility: DocumentVisibilityState = "visible";

const fakeReg = () =>
  ({ update: vi.fn(async () => {}) }) as unknown as ServiceWorkerRegistration;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  visibility = "visible";
});

describe("asking the service worker for its script", () => {
  it("asks once per interval while the page is visible", () => {
    const reg = fakeReg();
    scheduleServiceWorkerUpdate(reg, 1000);
    vi.advanceTimersByTime(3000);
    expect(reg.update).toHaveBeenCalledTimes(3);
  });

  it("says nothing while the page is hidden, and asks once when it returns", () => {
    const reg = fakeReg();
    scheduleServiceWorkerUpdate(reg, 1000);
    visibility = "hidden";
    vi.advanceTimersByTime(3000);
    expect(reg.update).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it("stops when the disposer runs", () => {
    const reg = fakeReg();
    const stop = scheduleServiceWorkerUpdate(reg, 1000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(reg.update).not.toHaveBeenCalled();
  });
});
