import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/*
 * Naming an agent writes the secret it signs in with into the deployment's own
 * record of it — the agents file `GILBERT_AGENTS_FILE` points at — because that
 * file is the one copy of the secret this product can put where a worker reads
 * it. An installation whose agent is named by its policy and whose deployment
 * carries no address and no password is the case that matters: it is a running
 * installation, the surface says no worker can sign in as the agent, and the
 * save is what has to turn that around without a restart and without an
 * operator carrying the secret anywhere.
 *
 * The files are staged before `config` is imported, because the policy and the
 * bootstrap are read when the module loads; the deposit is what has to work
 * afterwards.
 */
const dir = mkdtempSync(join(tmpdir(), "gilbert-agent-deposit-"));
const agents = join(dir, "agents.json");
const policy = join(dir, "policy.json");
const original = {
  agents: process.env.GILBERT_AGENTS_FILE,
  address: process.env.GILBERT_AGENT_ADDRESS,
  password: process.env.GILBERT_AGENT_PASSWORD,
  policy: process.env.SETTINGS_POLICY_FILE,
};

process.env.GILBERT_AGENTS_FILE = agents;
process.env.SETTINGS_POLICY_FILE = policy;
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;
writeFileSync(policy, JSON.stringify({ agent: { address: "gilbert@example.com" } }));
/* The file an operator mounts first, naming no agent yet: the policy is what
   says which address this installation acts as. */
writeFileSync(agents, JSON.stringify({ _comment: ["a deployment's own note"] }));

const { depositAgentSecret } = await import("./agentAdmin.js");
const { agentAddressSource, agentHasSecret } = await import("./config.js");

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries({
    GILBERT_AGENTS_FILE: original.agents,
    GILBERT_AGENT_ADDRESS: original.address,
    GILBERT_AGENT_PASSWORD: original.password,
    SETTINGS_POLICY_FILE: original.policy,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("the save is what makes the deployment hold the secret, at once", () => {
  assert.equal(
    agentAddressSource(),
    "policy",
    "the case under test is an installation whose policy names its agent",
  );
  assert.equal(
    agentHasSecret(),
    false,
    "a policy address the deployment holds no password for is what the surface reports",
  );

  assert.equal(depositAgentSecret("s3cret"), true);

  assert.equal(
    agentHasSecret(),
    true,
    "the deployment holds the secret the save wrote, with no restart and nothing in the environment",
  );
  const doc = JSON.parse(readFileSync(agents, "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    doc,
    {
      _comment: ["a deployment's own note"],
      "gilbert@example.com": { password: "s3cret" },
    },
    "the agent's entry is written beside the deployment's own keys, and it is the address the policy names",
  );
});

test("an entry that differs only in case is the same entry", () => {
  writeFileSync(
    agents,
    JSON.stringify({
      "Gilbert@Example.com": { password: "old", areas: ["mail"] },
    }),
  );

  assert.equal(depositAgentSecret("s3cret"), true);

  const doc = JSON.parse(readFileSync(agents, "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    doc,
    { "Gilbert@Example.com": { password: "s3cret", areas: ["mail"] } },
    "the entry the agent already had is the one replaced, and what it narrowed is kept",
  );
});

test("a file that names another agent is left alone", () => {
  const other = JSON.stringify({ "other@example.com": { password: "x" } });
  writeFileSync(agents, other);

  assert.equal(depositAgentSecret("s3cret"), false);
  assert.equal(
    readFileSync(agents, "utf8"),
    other,
    "a write that would leave one file naming two agents is refused, not performed",
  );
});

test("a file that cannot be written answers no rather than throwing", () => {
  process.env.GILBERT_AGENTS_FILE = join(dir, "missing", "agents.json");
  try {
    assert.equal(depositAgentSecret("s3cret"), false);
  } finally {
    process.env.GILBERT_AGENTS_FILE = agents;
  }
});
