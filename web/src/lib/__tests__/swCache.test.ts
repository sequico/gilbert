import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SW_CACHE_NAME } from "../swCache";

/*
 * The name the worker and the app have to agree on.
 *
 * `web/public/sw.js` is copied to `dist` verbatim rather than built, so nothing
 * in the pipeline makes its `VERSION` and `SW_CACHE_NAME` agree — and the pair
 * is what carries a push verification or a share from the worker to a tab. A
 * name that has drifted does not fail: it finds nothing, and the verification
 * never completes or the share opens an empty composer.
 */
describe("the cache the worker and the app share", () => {
  it("is named the same on both sides", () => {
    const worker = readFileSync(
      new URL("../../../public/sw.js", import.meta.url),
      "utf8",
    );
    const version = /const VERSION = "([^"]+)"/.exec(worker)?.[1];
    expect(version).toBe(SW_CACHE_NAME);
  });
});
