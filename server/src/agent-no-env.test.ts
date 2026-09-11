/**
 * The invariant behind the deployment's agent pair: a process whose environment
 * carries no pair still starts (ADR 0003).
 *
 * An installation that names no agent serves its people exactly as one that
 * does — it is inert, never unreachable — and its own administration screen is
 * where that is said. So reading the configuration with `GILBERT_AGENT_ADDRESS`
 * and `GILBERT_AGENT_PASSWORD` absent must succeed: the import below *is* the
 * assertion, and it fails the moment a `throw` returns to module load.
 *
 * `node --test` gives every file its own process, so clearing the environment
 * here cannot reach another test file.
 */

import assert from "node:assert/strict";
import test from "node:test";

delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;
delete process.env.GILBERT_AGENT_AREAS;

// Imported after the environment is cleared, and deliberately not hoisted.
const { config, agentAddress, agentGroupAreas } = await import("./config.js");
const { AGENT_AREAS } = await import("./agent/documents.js");

test("an installation with no agent in its environment still loads", () => {
  assert.equal(config.agent.address, "");
  assert.equal(config.agent.password, "");
  assert.equal(agentAddress(), "");
  assert.deepEqual(
    config.agent.areas,
    [...AGENT_AREAS],
    "with nothing said about areas, the deployment serves all of them",
  );
});

test("and no group is narrowed, because there is no agent to work in one", () => {
  assert.equal(agentGroupAreas("team@example.org"), null);
});
