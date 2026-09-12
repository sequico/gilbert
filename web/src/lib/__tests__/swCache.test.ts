import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SW_CACHE_NAME } from "../swCache";

/*
 * The names the worker and the app have to agree on.
 *
 * `web/public/sw.js` is copied to `dist` verbatim rather than built, so nothing
 * in the pipeline makes its `VERSION`, or its share and facts keys, agree with
 * the app's copies. They have to: the cache carries a push verification or a
 * share from the worker to a tab, and a name that has drifted does not fail —
 * it finds nothing, and the verification never completes or the share opens an
 * empty composer.
 *
 * `process.cwd()` rather than `import.meta.url`: vitest serves modules over
 * http, so the latter is not a file URL.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("the cache the worker and the app share", () => {
  it("is named the same on both sides", () => {
    const version = /const VERSION = "([^"]+)"/.exec(read("public/sw.js"))?.[1];
    expect(version).toBe(SW_CACHE_NAME);
  });

  /*
   * The two keys the worker writes and a tab reads: a pair that drifts is
   * silent in the same way, so a test is what holds the two copies together.
   */
  it("names the share and facts keys the app reads", () => {
    const worker = read("public/sw.js");
    const app = ["src/lib/shareTarget.ts", "src/lib/swFacts.ts"].map(read);
    for (const key of ["/gilbert-share", "/gilbert-worker-facts"]) {
      expect(worker).toContain(key);
      expect(app.some((src) => src.includes(`"${key}"`))).toBe(true);
    }
  });
});
