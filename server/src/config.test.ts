import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertImmutable } from "./config.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "gilbert-immutable-"));
}

test("IMMUTABLE refuses a configured SESSION_FILE", () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => assertImmutable("/data/sessions.json", root),
      /SESSION_FILE is \/data\/sessions\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IMMUTABLE refuses a writable root, and leaves no probe behind", () => {
  const root = tempRoot();
  try {
    assert.throws(() => assertImmutable("", root), /is writable/);
    assert.equal(existsSync(join(root, ".immutable-probe")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IMMUTABLE accepts a root it cannot write to", () => {
  const root = tempRoot();
  try {
    chmodSync(root, 0o555);
    assert.doesNotThrow(() => assertImmutable("", root));
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The settings policy at boot (ADR 0004 §1)                           */
/* ------------------------------------------------------------------ */

/**
 * The installation's policy, as the boot reader makes of it.
 *
 * Reading is a side effect of importing `config.ts`, so each case imports it
 * again under a `?`-suffixed specifier and gets a module instance that reads
 * the environment as it is right now. What is asserted is mostly the refusal:
 * a policy that only half applies has to stop the process, because the failure
 * it guards against is silent -- the installation looks healthy and the
 * settings an administrator wrote are simply not in force.
 */
type ConfigModule = typeof import("./config.js");

const POLICY_VARS = [
  "SETTINGS_POLICY_FILE",
  "SETTINGS_DEFAULTS",
  "SETTINGS_ENFORCED",
  "SETTINGS_CHANGES",
] as const;

/** Import `config.ts` afresh, so the policy is read from the environment again. */
async function boot(tag: string): Promise<ConfigModule> {
  return (await import(`./config.js?policy=${tag}`)) as ConfigModule;
}

/** Run `read` with exactly these policy variables set, and put the rest back. */
async function withPolicyEnv<T>(
  env: Partial<Record<(typeof POLICY_VARS)[number], string>>,
  read: () => Promise<T>,
): Promise<T> {
  const before = POLICY_VARS.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of POLICY_VARS) delete process.env[name];
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    return await read();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The error a boot refused with, or null when it came up. */
async function bootFailure(
  tag: string,
  env: Partial<Record<(typeof POLICY_VARS)[number], string>>,
): Promise<Error | null> {
  return withPolicyEnv(env, () =>
    boot(tag).then(
      () => null,
      (err: unknown) => err as Error,
    ),
  );
}

/** How a boot refused, for reading against what the refusal has to say. */
const refusal = (failed: Error | null): string => failed?.message ?? "";

function policyFile(contents: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "gilbert-policy-"));
  const file = join(dir, "policy.json");
  writeFileSync(file, contents);
  return { dir, file };
}

/** A section that is not an object, and the JSON that says so. */
const NOT_OBJECTS: Array<[string, string]> = [
  ["defaults", '"nope"'],
  ["enforced", "[1, 2]"],
];

for (const [section, value] of NOT_OBJECTS) {
  test(`a ${section} that is not an object stops the boot`, async () => {
    // The editor refuses a scalar where an object belongs (ADR 0004 §1), and so
    // does the boot: cast into an object it would load as settings that are not
    // there, and nothing downstream could tell.
    const { dir, file } = policyFile(`{ "${section}": ${value} }`);
    try {
      const failed = await bootFailure(`not-an-object-${section}`, {
        SETTINGS_POLICY_FILE: file,
      });
      assert.match(
        refusal(failed),
        /Invalid SETTINGS_POLICY_FILE/,
        `a ${section} of ${value} must not come up`,
      );
      assert.match(refusal(failed), new RegExp(`"${section}" must be an object`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a policy file that says nothing is read as an empty policy", async () => {
  // A JSON null is absent, which is what the editor mirrors: `{ "defaults":
  // null }` leaves the seeds to each account, it does not seed them with null.
  const { dir, file } = policyFile('{ "defaults": null, "enforced": null }');
  try {
    const { config } = await withPolicyEnv({ SETTINGS_POLICY_FILE: file }, () =>
      boot("nulls"),
    );
    assert.deepEqual(config.settingsPolicy, {
      defaults: {},
      enforced: {},
      changes: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a policy file is read as the document it is", async () => {
  const { dir, file } = policyFile(
    JSON.stringify({
      defaults: { "chat.notify": true },
      enforced: { "mail.signature": "" },
      changes: [{ version: "2026-09-01", settings: { "theme.name": "dark" } }],
      identities: { locked: ["Ada@Example.org"] },
    }),
  );
  try {
    const { config } = await withPolicyEnv({ SETTINGS_POLICY_FILE: file }, () =>
      boot("good-file"),
    );
    assert.deepEqual(config.settingsPolicy, {
      defaults: { "chat.notify": true },
      enforced: { "mail.signature": "" },
      changes: [{ version: "2026-09-01", settings: { "theme.name": "dark" } }],
      identities: { locked: ["ada@example.org"] },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed SETTINGS_CHANGES names the variable it came from", async () => {
  // The variable is parsed through the same guard as the file: a bare
  // SyntaxError names neither the variable nor the fact that a policy was
  // involved at all, and a bad value here has to stop the boot like any other.
  const failed = await bootFailure("bad-changes-json", {
    SETTINGS_CHANGES: '{ "version": }',
  });
  assert.match(
    refusal(failed),
    /Invalid SETTINGS_CHANGES/,
    "the boot must refuse malformed changes",
  );
});

test("SETTINGS_CHANGES that is not a list is refused by name", async () => {
  const failed = await bootFailure("changes-not-a-list", {
    SETTINGS_CHANGES: '{"version":"v"}',
  });
  assert.match(refusal(failed), /Invalid SETTINGS_CHANGES: "changes" must be a list/);
});

test("a section straight from the environment is a JSON object or nothing", async () => {
  const scalar = await bootFailure("env-scalar", { SETTINGS_DEFAULTS: '"dark"' });
  assert.match(
    refusal(scalar),
    /Invalid SETTINGS_DEFAULTS: not a JSON object/,
    "a scalar is not a section",
  );

  const { config } = await withPolicyEnv(
    {
      SETTINGS_DEFAULTS: '{"theme.name":"dark"}',
      SETTINGS_ENFORCED: '{"mail.signature":""}',
      SETTINGS_CHANGES: '[{"version":"v1","settings":{"chat.notify":true}}]',
    },
    () => boot("good-env"),
  );
  assert.deepEqual(config.settingsPolicy, {
    defaults: { "theme.name": "dark" },
    enforced: { "mail.signature": "" },
    changes: [{ version: "v1", settings: { "chat.notify": true } }],
  });
});
