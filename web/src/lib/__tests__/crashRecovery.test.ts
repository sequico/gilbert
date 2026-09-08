import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCrashRecord,
  recordCrash,
  recoverFromCrash,
  shouldAutoReload,
} from "@/lib/crashRecovery";

/*
 * The recovery is the last line between an uncaught error and a blank page
 * nobody reloads: record the crash where the reload cannot erase it, then
 * reload once — never while the page is young (a boot crash would loop) and
 * never twice within the cooldown (a crash that survives one reload will
 * survive the next).
 */

let reload: ReturnType<typeof vi.fn>;
let now: number;

const t0 = performance.timeOrigin;

beforeEach(() => {
  now = t0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  window.localStorage.clear();
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordCrash", () => {
  it("writes the crash where a reload cannot erase it", () => {
    const error = new TypeError("boom");
    error.stack = "TypeError: boom\n    at Bomb";
    recordCrash(error, "at Bomb (web/src/App.tsx:1)");
    const record = readCrashRecord();
    expect(record?.name).toBe("TypeError");
    expect(record?.message).toBe("boom");
    expect(record?.stack).toContain("at Bomb");
    expect(record?.componentStack).toBe("at Bomb (web/src/App.tsx:1)");
    expect(record?.url).toBe(window.location.href);
    expect(record?.at).toBeTruthy();
  });

  it("turns a thrown non-Error into a recordable one", () => {
    recordCrash("just a string");
    expect(readCrashRecord()?.message).toBe("just a string");
  });
});

describe("shouldAutoReload", () => {
  it("refuses while the page is less than a minute old", () => {
    now = t0 + 10_000;
    expect(shouldAutoReload()).toBe(false);
  });

  it("allows once the page is old enough and nothing reloaded recently", () => {
    now = t0 + 120_000;
    expect(shouldAutoReload()).toBe(true);
  });

  it("refuses again within the two-minute cooldown", () => {
    now = t0 + 120_000;
    recoverFromCrash(new Error("first"));
    expect(reload).toHaveBeenCalledTimes(1);
    now = t0 + 180_000; // 60s later: still inside the cooldown
    expect(shouldAutoReload()).toBe(false);
  });

  it("allows again once the cooldown has passed", () => {
    now = t0 + 120_000;
    recoverFromCrash(new Error("first"));
    now = t0 + 120_000 + 121_000;
    expect(shouldAutoReload()).toBe(true);
  });
});

describe("recoverFromCrash", () => {
  it("records but does not reload a crash in the first minute", () => {
    now = t0 + 30_000;
    recoverFromCrash(new Error("early crash"));
    expect(reload).not.toHaveBeenCalled();
    expect(readCrashRecord()?.message).toBe("early crash");
  });

  it("records and reloads a crash on a page that was up", () => {
    now = t0 + 3 * 60_000;
    recoverFromCrash(new Error("dead chunk"));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readCrashRecord()?.message).toBe("dead chunk");
  });

  it("reloads at most once per crash, however many errors follow", () => {
    now = t0 + 3 * 60_000;
    recoverFromCrash(new Error("first"));
    recoverFromCrash(new Error("second"));
    recoverFromCrash(new Error("third"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
