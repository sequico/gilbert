import { describe, expect, it } from "vitest";
import { readSource, workerSource } from "./readSource";

/*
 * The two halves of "fetch the rest of the build in the background", held
 * together.
 *
 * `vite.config.ts` writes the build's own script list into the app page, and
 * `public/sw.js` reads it back and fetches what is missing -- so the first time
 * after a deploy that a reader opens the composer, settings or a viewer, the
 * code is already there instead of being waited for. The build's lazy views are
 * hundreds of kilobytes each, which is what makes it worth doing.
 *
 * The list has no runtime test: it is produced by a build, and a build is not
 * something the suite runs. What can be checked -- and is what the two sides
 * have to agree on -- is the id they name and the shape each expects.
 */
const CONFIG = readSource("vite.config.ts");
const WORKER = workerSource();

describe("the build's own asset list", () => {
  it("is named the same on both sides, and carried as JSON in the page", () => {
    expect(CONFIG).toContain('const ASSET_LIST_ID = "gilbert-assets"');
    expect(WORKER).toContain('id="gilbert-assets"');
    expect(WORKER).toMatch(/<script type="application\\\/json" id="gilbert-assets">/);
  });

  it("is written into a page the worker can read it from, and prefixed", () => {
    // The plugin has to run after the bundle exists, or there is no list.
    expect(CONFIG).toMatch(/order:\s*"post"/);
    // `<head>` is where it lands, and the prefix is what makes it fetchable.
    expect(CONFIG).toContain("</head>");
    expect(CONFIG).toMatch(/precache: files\.map\(\(f\) => `\$\{base\}\$\{f\}`\)/);
  });

  /*
   * Language catalogs are one per language at 80-125 KB, and a reader uses one
   * of them; every other script in the build is fetched ahead. The codes come
   * from the catalogue directory, because a pattern for "a name and a hash"
   * matches every chunk vite emits -- which is what an earlier version of this
   * did, and what the readdir is there to prevent.
   */
  it("leaves the language catalogs out, by reading the catalogues rather than by guessing", () => {
    expect(CONFIG).toContain('new URL("./src/locales", import.meta.url)');
    expect(CONFIG).toContain("!isLocaleChunk(name)");
  });
});

describe("what the worker does with the list", () => {
  it("prefetches only the build's own assets, a few at a time", () => {
    expect(WORKER).toMatch(/p\.startsWith\(`\$\{BASE\}\/assets\/`\)/);
    expect(WORKER).toContain("PRECACHE_PARALLEL = 3");
    expect(WORKER).toContain("if (res.ok) await cache.put(path, res)");
  });

  it("does nothing ahead when the reader asked the browser to save data", () => {
    expect(WORKER).toContain("self.navigator.connection?.saveData) return;");
  });

  it("refreshes that copy from every navigation, and falls back to it", () => {
    expect(WORKER).toContain("event.waitUntil(refreshShell(res.clone()))");
    expect(WORKER).toContain("caches.match(SHELL_KEY)");
  });
});

/*
 * The decision upstream's release takes that this tree does not.
 *
 * Upstream primes the kept shell copy before reloading, because its worker
 * answers a navigation from the cache and a reload for a new build could
 * otherwise get the old page back. Our navigations are network-first -- the
 * cache is the offline fallback and never the answer when the network is there
 * -- so a reload always gets the new page, and priming first would be a request
 * with nothing to fix.
 */
describe("no shell priming, because a navigation here is network-first", () => {
  it("fetches the page first and only falls back to the kept copy", () => {
    expect(WORKER).toMatch(
      /if \(req\.mode === "navigate"\) \{\s*event\.respondWith\(\s*fetch\(req\)/,
    );
  });
});
