/**
 * The invariant behind the one-command installation (ADR 0003): the function the
 * server calls to start a fleet really does start one, and stopping it gives the
 * group back.
 *
 * What is asserted is the pair of halves, not the log line: `startAgentFleet()`
 * claims the group the agent holds without anybody asking, and its `stop()`
 * releases that claim. Those two are the whole difference between "start the
 * server" and a group granted to an agent nothing serves — the failure that
 * arrives silently, because the process that would have spoken is the one that
 * was never started.
 *
 * The timing is the deployment's own knobs, set here rather than waited out: a
 * pass is one poll interval away, and the interval a production deployment wants
 * is a minute. The two intervals are deliberately far apart — a pass claims the
 * account, so it is the one that has to happen soon, while a heartbeat is a
 * second writer on the same document and nothing here is asking about it.
 *
 * `node --test` gives every file its own process, so the environment set here
 * cannot reach another test file.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

const PORT = 18857;
process.env.MOCK_PORT = String(PORT);
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";
process.env.GILBERT_AGENT_POLL_MS = "2000";
process.env.GILBERT_AGENT_HEARTBEAT_MS = "60000";
// The agent's own socket belongs to a deployment that asks for one; a server
// process has its own health route, and a test that opened a second would be
// asserting on the wrong endpoint.
delete process.env.GILBERT_AGENT_HEALTH_PORT;

const mock = await import("./mock/index.js");
const { startAgentFleet } = await import("./agent/agent.js");
const { AgentStore } = await import("./agent/store.js");
const { fetchUpstreamSession } = await import("./upstream.js");

const BASE = `http://127.0.0.1:${PORT}`;
/** A group mailbox of the demo session, which the mock's agent holds. */
const GROUP = "a3";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** Wait for a condition a pass writes, rather than for a fixed sleep. */
async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("starting the fleet claims the agent's group, and stopping gives it back", async () => {
  const fleet = await startAgentFleet();
  try {
    await until(
      "the group to be claimed",
      async () => (await new AgentStore(ctx, GROUP).readClaim()) !== null,
    );
    const claim = await new AgentStore(ctx, GROUP).readClaim();
    assert.ok(claim, "the fleet holds the group with nobody having asked a pass for it");
    assert.ok(
      claim.doc.agent.length > 0,
      "and the claim names the agent that holds it, which is how a peer knows",
    );
  } finally {
    // Released before the next pass comes round: a pass renews the claim it
    // finds, and the release is conditional on the state it read. An in-flight
    // pass that outlives the stop is the one case this test does not pin, and
    // it is recorded in ROADMAP.md with the rest of the agent diagnosis work.
    await fleet.stop();
  }
  assert.equal(
    await new AgentStore(ctx, GROUP).readClaim(),
    null,
    "the server's shutdown is what gives the claim back, so no lease has to lapse",
  );
});
