// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountKey,
  clearAllData,
  clearSignedInData,
  hasCachedJson,
  isDeviceTrusted,
  loadJson,
  loadRaw,
  removeKey,
  saveJson,
  setDeviceTrusted,
} from "@/lib/storage";

/**
 * The gate is a privacy boundary rather than a convenience, so it is tested
 * from both sides: that a trusted device still works exactly as it did, and
 * that an untrusted one leaves nothing to find.
 */
describe("device-trusted storage", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        key: (i: number) => [...store.keys()][i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    setDeviceTrusted(false);
  });

  afterEach(() => {
    setDeviceTrusted(false);
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("writes nothing at all when the device is not trusted", () => {
    saveJson("settings", { theme: "dark" });
    saveJson(accountKey("acct1", "recent"), [{ email: "someone@example.com" }]);
    expect([...store.keys()].filter((k) => k !== "gilbert:deviceTrusted")).toEqual([]);
  });

  it("does not read residue left by an earlier trusted session", () => {
    setDeviceTrusted(true);
    saveJson(accountKey("acct1", "recent"), [{ email: "someone@example.com" }]);
    setDeviceTrusted(false);
    // The bytes are still on disk until a purge; the gate must not serve them.
    expect(loadRaw(accountKey("acct1", "recent"), [])).toEqual([]);
  });

  it("round-trips normally on a trusted device", () => {
    setDeviceTrusted(true);
    saveJson("settings", { theme: "dark" });
    expect(loadJson("settings", { theme: "light", accent: "blue" })).toEqual({
      theme: "dark",
      accent: "blue",
    });
    expect(isDeviceTrusted()).toBe(true);
  });

  it("remembers trust across a reload, so a trusted device still paints from cache", () => {
    setDeviceTrusted(true);
    expect(store.get("gilbert:deviceTrusted")).toBe("1");
    setDeviceTrusted(false);
    expect(store.has("gilbert:deviceTrusted")).toBe(false);
  });

  it("clears the account's data on sign-out but keeps the deliberate exceptions", () => {
    setDeviceTrusted(true);
    saveJson("settings", { theme: "dark" });
    saveJson("mbx-expanded", { a: true });
    saveJson(accountKey("acct1", "recent"), [{ email: "someone@example.com" }]);
    store.set("gilbert:lastUser", "me@example.com");
    store.set("gilbert:pushDeviceId", "gilbert-abc");
    store.set("gilbert:pushEnabled", "1");

    clearSignedInData();

    expect(store.has("gilbert:settings")).toBe(false);
    expect(store.has("gilbert:mbx-expanded")).toBe(false);
    expect(store.has("gilbert:acct1:recent")).toBe(false);
    // Kept on purpose: prefills sign-in, and only a trusted device wrote it.
    expect(store.get("gilbert:lastUser")).toBe("me@example.com");
    expect(store.get("gilbert:pushDeviceId")).toBe("gilbert-abc");
    /*
     * Kept for the ending that is not a sign-out. A deploy expires every
     * session, and that path clears local data without unsubscribing -- there
     * is no session left to unsubscribe with. Losing the flag there would
     * strand a live subscription with nothing renewing it, and the switch in
     * Settings would still say background notifications were on.
     */
    expect(store.get("gilbert:pushEnabled")).toBe("1");
  });

  it("clears everything, lastUser included, for an untrusted sign-in", () => {
    setDeviceTrusted(true);
    saveJson("settings", { theme: "dark" });
    store.set("gilbert:lastUser", "me@example.com");

    clearAllData();

    expect([...store.keys()]).toEqual([]);
  });

  it("leaves keys belonging to anything else alone", () => {
    setDeviceTrusted(true);
    store.set("someone-elses-key", "keep me");
    clearAllData();
    expect(store.get("someone-elses-key")).toBe("keep me");
  });
});

/**
 * The same module where `localStorage` itself throws.
 *
 * That is not an exotic case: it is every private window in the browsers this
 * app runs in, and `localStorage` throws on **access** there rather than being
 * absent. The module reads it at import (`trusted`), on every read, on every
 * write and on the sign-out sweep, so a `catch` missing from any one of those is
 * a blank page at boot or a sign-out that throws halfway — with the trusted
 * device's residue still in the browser it was told to clear. Each answer the
 * module gives there is "nothing", which is the honest one for storage nobody
 * can reach, and this pins all of them.
 */
describe("storage where localStorage throws", () => {
  const boom = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length(): number {
          return boom();
        },
        key: boom,
        getItem: boom,
        setItem: boom,
        removeItem: boom,
      },
    });
    setDeviceTrusted(true);
  });

  afterEach(() => {
    setDeviceTrusted(false);
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("answers the fallback rather than throwing on a read", () => {
    expect(loadJson("settings", { theme: "dark" })).toEqual({ theme: "dark" });
    expect(loadRaw("recent", ["nothing"])).toEqual(["nothing"]);
  });

  it("does not throw on a write, and reports nothing cached", () => {
    expect(() => saveJson("settings", { theme: "dark" })).not.toThrow();
    expect(() => removeKey("settings")).not.toThrow();
    expect(hasCachedJson("settings")).toBe(false);
  });

  it("still completes a sign-out, because the sweep is what clears the device", () => {
    expect(() => clearSignedInData()).not.toThrow();
    expect(() => clearAllData()).not.toThrow();
  });

  it("boots with the device untrusted, so the module load itself survives it", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/storage");
    expect(fresh.isDeviceTrusted()).toBe(false);
  });
});
