import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Every test file that binds a mock takes a port the OS handed back.
 *
 * The runner executes files as parallel child processes and each binds its own
 * mock, so a port named in the source goes wrong two ways: two files naming the
 * same one race for it, and a port that is fine in CI collides with whatever
 * else runs on the machine — a service co-hosted on the developer's box, or a
 * sibling file. `freePort()` (in `testkit.ts`) asks the OS for a port it has
 * just handed back, so no file names one; a comment cannot fail, so this can.
 * It reads the test files and nothing else.
 */
const HERE = import.meta.dirname ?? new URL(".", import.meta.url).pathname;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** How a file hands its mock a port, or null when it binds none. */
/** Whether a file hands its mock a port through `MOCK_PORT`. */
function bindsMock(source: string): boolean {
  return /^process\.env\.MOCK_PORT = String\(PORT\);$/m.test(source);
}

/** Whether the file takes its port from `freePort()` rather than naming one. */
function usesFreePort(source: string): boolean {
  return /^const PORT = await freePort\(\);$/m.test(source);
}

/** A port the file names in the source, or null. */
function fixedPort(source: string): number | null {
  const fixed = /^const PORT = (\d+);$/m.exec(source);
  return fixed ? Number(fixed[1]) : null;
}

test("no test file names a fixed port, and a mock binds through freePort", () => {
  const files = testFiles(HERE).sort();
  assert.ok(files.length > 50, `expected the suite's files, read ${files.length}`);
  let declared = 0;
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const rel = file.slice(HERE.length + 1);
    if (bindsMock(source)) {
      declared += 1;
      if (!usesFreePort(source))
        offenders.push(`${rel} (binds a mock but not through freePort)`);
    }
    const named = fixedPort(source);
    if (named != null) offenders.push(`${rel} (names the fixed port ${named})`);
  }
  assert.ok(declared > 30, `expected most files to bind a mock, saw ${declared}`);
  assert.deepEqual(
    offenders,
    [],
    `test files must take a free port: ${offenders.join("; ")}`,
  );
});
