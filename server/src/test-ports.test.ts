import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * One mock port per test file.
 *
 * The runner executes files as parallel child processes and each binds its own
 * mock, so two files naming the same port race for it: whichever loses either
 * fails to start or, worse, talks to the other file's mock and its in-memory
 * state. Every file that declares one says so in a comment ("Mock port: must not
 * collide with any other test file"), which is a rule nothing enforced -- and it
 * had already been broken twice over, by `agent/chat.test.ts` and
 * `mock/destroy-non-empty-folder.test.ts` both taking 18846.
 *
 * A comment cannot fail, so this can. It is cheap enough to run with everything
 * else: it reads the test files and nothing else.
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

/** The port a file binds its mock on, or null when it binds none. */
function mockPort(source: string): number | null {
  // Only files that hand the port to the mock: `MODEL_PORT`, or a port used for
  // something else entirely, is not one to keep unique.
  if (!source.includes("process.env.MOCK_PORT = String(PORT)")) return null;
  const declared = /^const PORT = (\d+);$/m.exec(source);
  return declared ? Number(declared[1]) : null;
}

test("no two test files bind the same mock port", () => {
  const seen = new Map<number, string[]>();
  const files = testFiles(HERE).sort();
  assert.ok(files.length > 50, `expected the suite's files, read ${files.length}`);
  let declared = 0;
  for (const file of files) {
    const port = mockPort(readFileSync(file, "utf8"));
    if (port == null) continue;
    declared += 1;
    const rel = file.slice(HERE.length + 1);
    seen.set(port, [...(seen.get(port) ?? []), rel]);
  }
  assert.ok(declared > 30, `expected most files to bind a mock, saw ${declared}`);
  const clashes = [...seen.entries()].filter(([, owners]) => owners.length > 1);
  assert.deepEqual(
    clashes,
    [],
    `two files on one mock port race for it: ${clashes.map(([p, o]) => `${p} (${o.join(", ")})`).join("; ")}`,
  );
});
