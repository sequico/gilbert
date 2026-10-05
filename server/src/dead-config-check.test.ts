import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
 * `server/src` may reach the process's environment only for the handshake that
 * reaches Stalwart and for the resolver that says what a process with no boot
 * runs on. Everything else is a document in the Master account.
 *
 * The second rule is about the module, not about a property, so these tests
 * refuse a destructuring and a stored reference as firmly as a named read: a
 * rule that only knew `process.env.NAME` samples the tree while reading as
 * though it had proved it. And the first rule's perimeter is the repository by
 * exclusion, so these tests plant a retired name in a file nothing but a walk of
 * the whole tree would reach — a root file, a workflow, a hook — and prove it is
 * read.
 */

const file = (path: string, text: string) => ({ path, text });

/** Plant a file in a staged tree, creating the directories it needs. */
function plant(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

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
  const dotted = judgeFile(
    file("server/src/whatever.ts", "const port = process.env.PORT;"),
  );
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
  const computed = judgeFile(
    file("server/src/whatever.ts", "const v = process.env[name];"),
  );
  assert.equal(computed.env.length, 1, "a read through a variable is still a read");
});

test("the rule is about the module reaching for the environment, not a property", () => {
  // The two shapes a pattern that only knows `process.env.NAME` cannot see.
  const destructured = judgeFile(
    file("server/src/whatever.ts", "const { APP_SECRET } = process.env;"),
  );
  assert.equal(
    destructured.env.length,
    1,
    "destructuring the environment is reaching for it",
  );
  const stored = judgeFile(
    file(
      "server/src/whatever.ts",
      "const env = process.env;\nconst key = env.APP_SECRET;",
    ),
  );
  assert.equal(stored.env.length, 1, "keeping it in a variable is reaching for it");
  // And the report says which of the two it found, so a reader is not left
  // guessing at a key the file never named.
  const report = formatReport(
    checkDeadConfiguration({
      files: [file("server/src/whatever.ts", "const env = process.env;")],
    }),
  ).join("\n");
  assert.match(report, /server\/src\/whatever\.ts:1 takes the whole environment/);
});

test("the two modules whose job is the environment may read it", () => {
  for (const path of ["server/src/bootstrap.ts", "server/src/configuration.ts"]) {
    const judged = judgeFile(file(path, "const url = process.env.STALWART_URL;"));
    assert.deepEqual(judged.env, [], path);
  }
  // The fixture is not a module of this product: it stands in for a server and
  // is configured by the test that starts it, knobs and all.
  assert.deepEqual(
    judgeFile(file("server/src/mock/index.ts", "const port = process.env.MOCK_PORT;"))
      .env,
    [],
  );
});

test("a test reads the environment freely: it is what sets one up", () => {
  const judged = judgeFile(
    file("server/src/app.test.ts", "process.env.APP_SECRET = 'x';"),
  );
  assert.deepEqual(judged.env, []);
});

test("a bracket read is seen as clearly as a dotted one", () => {
  assert.deepEqual(
    envReadsIn('process.env["SESSION_FILE"]').map((one) => one.name),
    ["SESSION_FILE"],
  );
  // A mention that names no key is one read, not none and not two.
  const stored = envReadsIn("const env = process.env;\nconst key = process.env.PORT;");
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.map((one) => one.line),
    [1, 2],
  );
});

test("the report says which file and which name", () => {
  const result = checkDeadConfiguration({
    files: [file("server/src/x.ts", "process.env.SETTINGS_DEFAULTS")],
  });
  assert.equal(result.ok, false);
  assert.match(formatReport(result).join("\n"), /server\/src\/x\.ts:1/);
});

test("the walk reaches files no list of trees would name: root, workflow, hook", () => {
  const paths = new Set(collectRepoInput().files.map((one) => one.path));
  for (const path of [
    "Dockerfile",
    "ROADMAP.md",
    "LICENSE",
    "package.json",
    "settings-policy.example.json",
    ".github/workflows/ci.yml",
    ".githooks/pre-push",
    "server/src/app.ts",
  ])
    assert.ok(paths.has(path), `${path} was read`);
  // …and that the exclusions are exactly the exclusions: installed
  // dependencies and build output are not this tree's text.
  for (const path of paths) {
    assert.ok(!path.startsWith("node_modules/"), `${path} is not this tree's text`);
    assert.ok(
      !/(?:^|\/)(?:dist|dev-dist|coverage|\.vite)\/.*/.test(path),
      `${path} is build output`,
    );
  }
});

test("a retired name the walk reaches is refused, wherever it is planted", () => {
  const root = mkdtempSync(join(tmpdir(), "dead-config-perimeter-"));
  try {
    // The kinds of file a list of trees does not cover: an extensionless root
    // file, a workflow under .github, a hook, a lockfile.
    plant(root, "Makefile", "run:\n\tnode server/dist/index.js # SESSION_FILE=/data\n");
    plant(root, ".github/workflows/ci.yml", "env:\n  SETTINGS_DEFAULTS: '{}'\n");
    plant(root, ".githooks/pre-push", "#!/bin/sh\nexport SETTINGS_CHANGES=1\n");
    plant(root, "ROADMAP.md", "# no retired name here\n");
    // …and the trees the exclusions step over.
    plant(root, "node_modules/a-dep/index.mjs", "// SETTINGS_POLICY_FILE\n");
    plant(root, "web/dist/app.js", "// STALWART_SERVERS_FILE\n");
    plant(root, "package-lock.json", '{ "name": "SETTINGS_POLICY_FILE" }\n');

    const { files } = collectRepoInput(root);
    const result = checkDeadConfiguration({ files });
    assert.deepEqual(
      result.retired.map((one) => `${one.path}:${one.line}`),
      [".githooks/pre-push:2", ".github/workflows/ci.yml:2", "Makefile:2"],
    );
    const paths = files.map((one) => one.path);
    assert.ok(paths.includes("ROADMAP.md"), "a file with nothing in it is still read");
    for (const path of paths)
      assert.ok(
        !path.startsWith("node_modules/") &&
          !path.startsWith("web/dist/") &&
          path !== "package-lock.json",
        `${path} is excluded`,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this repository passes, and it was actually read", () => {
  const { files } = collectRepoInput();
  const result = checkDeadConfiguration({ files });
  assert.ok(files.length > 100, "the tree was read");
  assert.ok(result.ok, `dead configuration:\n${formatReport(result).join("\n")}`);
});
