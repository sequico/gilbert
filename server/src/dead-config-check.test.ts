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
 * The tree holds no retired configuration name and reads no configuration from
 * the environment (ADR 0001, the installation's own document).
 *
 * The installation decides its settings, its secret and its routing in one
 * document in the Master account's own Stalwart storage, so a value read from
 * the environment is a value a redeploy can lose, and a name the code no longer
 * honours is a lie a reader can still find. This is the check that keeps both
 * out — including the ones a later change might reintroduce by accident.
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

test("an environment read in server code is reported", () => {
  const judged = judgeFile(
    file("server/src/config.ts", "const port = process.env.PORT;"),
  );
  assert.deepEqual(
    judged.env.map((one) => one.name),
    ["PORT"],
  );
});

test("the handshake module may read the environment", () => {
  const judged = judgeFile(
    file(
      "server/src/bootstrap.ts",
      "const url = process.env.STALWART_URL; const user = process.env['GILBERT_AGENT_ADDRESS'];",
    ),
  );
  assert.deepEqual(judged.env, []);
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
});

test("the report says which file and which name", () => {
  const result = checkDeadConfiguration({
    files: [file("server/src/x.ts", "process.env.SETTINGS_DEFAULTS")],
  });
  assert.equal(result.ok, false);
  const lines = formatReport(result);
  assert.match(lines.join("\n"), /server\/src\/x\.ts:1/);
});

test("this repository passes, and it was actually read", () => {
  const { files } = collectRepoInput();
  const result = checkDeadConfiguration({ files });
  assert.ok(files.length > 100, "the tree was read");
  assert.ok(result.ok, `dead configuration:\n${formatReport(result).join("\n")}`);
});
