import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./repoWalk.mjs";

/**
 * The ADR vocabulary, named once for every reader of `docs/adr`.
 *
 * Three readers ask about these records: the check that marks a debt on both
 * sides, the check that refuses a citation of a record that does not exist, and
 * the gate, which asks each check what it read so a diff of nothing but binaries
 * can skip the run. They must agree on what an ADR is called and on the shape a
 * record is handed over in, or one of them silently loses a document -- so the
 * rule and the reader live here, and the two checks differ only in what they do
 * with what they read.
 */

/** The ADR a file name owns: `0003-agent-fleet.md` -> `0003`, or null. */
export const ADR_FILE = /^(\d{4})-[^/]*\.md$/;

/**
 * Every ADR, read whole, each named the way every reader names a file:
 * `{ path, text }`, path relative to the repository.
 */
export function adrRecords(root = ROOT) {
  const dir = join(root, "docs", "adr");
  return readdirSync(dir)
    .filter((name) => ADR_FILE.test(name))
    .sort()
    .map((name) => ({
      path: `docs/adr/${name}`,
      text: readFileSync(join(dir, name), "utf8"),
    }));
}
