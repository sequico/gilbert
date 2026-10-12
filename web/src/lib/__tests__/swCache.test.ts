import { describe, expect, it } from "vitest";
import { SW_CACHE_NAME } from "../swCache";
import { readSource, workerSource } from "./readSource";

/*
 * The names the worker and the app have to agree on.
 *
 * `web/public/sw.js` is copied to `dist` verbatim rather than built, so nothing
 * in the pipeline makes its handoff cache name, or its share and facts keys,
 * agree with the app's copies. They have to: that cache carries a share and the
 * briefing from the worker to a tab, and a name that has drifted does not fail —
 * it finds nothing, and the share opens an empty composer or the notification
 * loses the folder it opens. (The worker's mail watermark is its own entry, so
 * nothing on the app side has to agree on that one; `swPushRules.test.ts` pins
 * that it stays the worker's.)
 */
describe("the cache the worker and the app share", () => {
  it("names the handoff cache the same on both sides", () => {
    const handoff = /const HANDOFF = "([^"]+)"/.exec(workerSource())?.[1];
    expect(handoff).toBe(SW_CACHE_NAME);
  });

  /*
   * The two keys the worker writes and a tab reads: a pair that drifts is
   * silent in the same way, so a test is what holds the two copies together.
   */
  it("names the share and facts keys the app reads", () => {
    const worker = workerSource();
    const app = ["src/lib/shareTarget.ts", "src/lib/swFacts.ts"].map(readSource);
    for (const key of ["/gilbert-share", "/gilbert-worker-facts"]) {
      expect(worker).toContain(key);
      expect(app.some((src) => src.includes(`"${key}"`))).toBe(true);
    }
  });
});
