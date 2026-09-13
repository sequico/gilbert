import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkDeadConfiguration,
  collectRepoInput,
  envReadsIn,
  formatReport,
  judgeFile,
  retiredNamesIn,
} from "../../scripts/dead-config-check.mjs";

/**
 * The installation's configuration lives in Stalwart (ADR 0001).
 *
 * Two things follow, and this is the check that holds them: no name the
 * installation no longer honours may appear anywhere in the tree, and
 * `server/src` may read the process's environment only for the handshake that
 * reaches Stalwart and for the resolver that says what a process with no boot
 * runs on. Everything else is a document in the Master account.
 */

const file = (path: string, text: string) => ({ path, text });

test("a retired name is reported wherever it appears", () => {
  const found = retiredNamesIn("# SETTINGS_POLICY_FILE=/etc/gilbert/policy.json");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.name, "SETTINGS_POLICY_FILE");
  assert.equal(found[0]!.line, 1);
});

test("a retired name in the check's own files is not reported", () => {
  const judged = judgeFile(
    file("scripts/dead-config-check.mjs", "const RETIRED = ['SETTINGS_DEFAULTS'];"),
  );
  assert.deepEqual(judged.retired, []);
});

test("an environment read in server code is reported, however it is written", () => {
  const dotted = judgeFile(file("server/src/whatever.ts", "const port = process.env.PORT;"));
  assert.deepEqual(
    dotted.env.map((one) => one.name),
    ["PORT"],
  );
  const bracketed = judgeFile(
    file("server/src/whatever.ts", 'const file = process.env["SESSION_FILE"];'),
  );
  assert.deepEqual(
    bracketed.env.map((one) => one.name),
    ["SESSION_FILE"],
  );
  const computed = judgeFile(file("server/src/whatever.ts", "const v = process.env[name];"));
  assert.equal(computed.env.length, 1, "a read through a variable is still a read");
});

test("the two modules whose job is the environment may read it", () => {
  for (const path of ["server/src/bootstrap.ts", "server/src/configuration.ts"]) {
    const judged = judgeFile(file(path, "const url = process.env.STALWART_URL;"));
    assert.deepEqual(judged.env, [], path);
  }
});

test("a test reads the environment freely: it is what sets one up", () => {
  const judged = judgeFile(file("server/src/app.test.ts", "process.env.APP_SECRET = 'x';"));
  assert.deepEqual(judged.env, []);
});

test("a bracket read is seen as clearly as a dotted one", () => {
  assert.deepEqual(
    envReadsIn('process.env["SESSION_FILE"]').map((one) => one.name),
    ["SESSION_FILE"],
  );
});

test("the report says which file and which name", () => {
  const result = checkDeadConfiguration({
    files: [file("server/src/x.ts", "process.env.SETTINGS_DEFAULTS")],
  });
  assert.equal(result.ok, false);
  assert.match(formatReport(result).join("\n"), /server\/src\/x\.ts:1/);
});

test("this repository passes, and it was actually read", () => {
  const { files } = collectRepoInput();
  const result = checkDeadConfiguration({ files });
  assert.ok(files.length > 100, "the tree was read");
  assert.ok(result.ok, `dead configuration:\n${formatReport(result).join("\n")}`);
});
