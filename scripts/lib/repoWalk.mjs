import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Walking this repository, once.
 *
 * The two ADR checks walk the whole tree looking for Markdown and for citations
 * of it, and each carried the same twenty lines: a `readdirSync` with
 * `withFileTypes`, a recursion that joins names, and a set of directories to
 * step over. They had drifted — one skipped `build`, `.vite` and `.turbo`, the
 * other did not — which is what a second copy does.
 *
 * The set is the perimeter: everything in it is generated or third-party, and a
 * check that read those trees would report on files nobody wrote — a citation
 * inside `web/dist`, a record inside `node_modules`.
 */

/** Repository directories a walk never enters. */
export const SKIP_DIRS = new Set([
  // Installed dependencies, in the root and in every workspace.
  "node_modules",
  // Build output: the bundle, the built server, the dev server's cache.
  "dist",
  "dev-dist",
  "build",
  // Tool caches and reports.
  "coverage",
  ".vite",
  ".turbo",
  // A worktree is a checkout, not content (`/.worktree/` is ignored): a second
  // checkout of this repository inside it is not this tree's Markdown, and its
  // harness state quotes whatever a session said.
  ".worktree",
  // Git's own storage.
  ".git",
]);

/**
 * Every file under `dir`, as paths relative to it, deepest last.
 *
 * A directory that cannot be read is skipped rather than thrown over: a walk of
 * a repository answers about what is there, and a check has nothing to say
 * about a directory it may not open.
 *
 * `skipPaths` is for a caller that has to step over a *path* rather than a
 * name: `dead-config-check.mjs` skips `.codewhale/state`, because the agent
 * runtime's own records quote whatever a session said, and
 * `package-lock.json`, which is npm's generated file and not text that check
 * reads.
 */
export function walk(dir, { skipPaths = new Set() } = {}) {
  const step = (d, rel) => {
    const here = [];
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return here;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || skipPaths.has(child)) continue;
        for (const inside of step(join(d, entry.name), child)) here.push(inside);
      } else if (entry.isFile()) {
        if (skipPaths.has(child)) continue;
        here.push(child);
      }
    }
    return here;
  };
  return step(dir, "");
}
