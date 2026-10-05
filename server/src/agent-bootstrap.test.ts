import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * The installation's agent is bootstrap configuration, and it arrives in the
 * environment of whoever starts the process — the one place a secret belongs
 * (ADR 0003). Nothing is read from a file, and nothing is re-read later: the
 * environment cannot change under a running process, so an operator who names a
 * different agent, or gives it a different secret, says so in the deployment
 * and restarts it.
 *
 * `config` is imported after the environment is staged, because the bootstrap
 * is resolved when the module loads.
 */
const original = {
  address: process.env.GILBERT_AGENT_ADDRESS,
  password: process.env.GILBERT_AGENT_PASSWORD,
};

process.env.GILBERT_AGENT_ADDRESS = "Agent@Example.com";
process.env.GILBERT_AGENT_PASSWORD = "p-env";

const { config } = await import("./config.js");

test.after(() => {
  for (const [key, value] of Object.entries({
    GILBERT_AGENT_ADDRESS: original.address,
    GILBERT_AGENT_PASSWORD: original.password,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("the installation's agent is the one the environment names", () => {
  assert.equal(config.agent.address, "agent@example.com", "normalized as it is read");
  assert.equal(config.agent.password, "p-env");
});

test("the record is resolved once: the environment moving on changes nothing", () => {
  process.env.GILBERT_AGENT_ADDRESS = "other@example.com";
  process.env.GILBERT_AGENT_PASSWORD = "p-other";
  assert.equal(
    config.agent.address,
    "agent@example.com",
    "a running process keeps the agent it started with",
  );
  assert.equal(config.agent.password, "p-env");
  process.env.GILBERT_AGENT_ADDRESS = "agent@example.com";
  process.env.GILBERT_AGENT_PASSWORD = "p-env";
});
