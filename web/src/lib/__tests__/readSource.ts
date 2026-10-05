import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A file of this package, by path.
 *
 * For the tests that assert on something no module can import: `public/sw.js`
 * is copied to `dist` verbatim and registers its listeners on `self` at load,
 * and a stylesheet is not a module at all. Those tests read the file instead,
 * and this is the one place that knows how to find one.
 *
 * `process.cwd()` rather than `import.meta.url`, because vitest serves modules
 * over http and the latter is then not a file URL. cwd is the package root --
 * `web/` -- when the suite runs.
 */
export function sourcePath(rel: string): string {
  return join(process.cwd(), rel);
}

/** Such a file, read as text. */
export function readSource(rel: string): string {
  return readFileSync(sourcePath(rel), "utf8");
}

/** The service worker's own source, which several tests assert on. */
export function workerSource(): string {
  return readSource("public/sw.js");
}
