/**
 * The agent process (ADR 0031, 0036), end to end against the mock Stalwart.
 *
 * What is pinned is the wiring `npm run agent` and `dev:mock:agent` rest on, and
 * nothing smaller would prove it: the process boots on the deployment's own
 * handshake, finds the installation's **model** in the document the Master's
 * account already holds (the demo seed, ADR 0011), resolves the **groups** that
 * document's principal works, and asks the loop for a pass — the pass is what
 * takes the installation's claim, so the claim document's holder is the proof
 * that a pass was asked.
 *
 * The pass is the **first** one, asked on the way up rather than by an interval:
 * the process is left on the product's own thirty-second period, and a claim
 * taken within the wait below can only be that first pass — a wait that came due
 * while nothing was running is worked at once, not up to half a minute later.
 *
 * No model call is made: the demo ships no rules, so no pass reaches a provider
 * and none is stubbed. What a pass does with a rule and a model is `loop.test.ts`,
 * and the supervisor's own contract is `supervisor.test.ts`.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
// The demo traffic writes into accounts on intervals: nothing here measures a
// write, but a loop that reads an account is read against a still one.
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-the-agent-process";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { readClaim } = await import("./claim.js");
const { startAgent } = await import("./supervisor.js");

const BASE = `http://127.0.0.1:${PORT}`;
const MASTER = "gilbert@example.com";
const AUTH = `Basic ${Buffer.from(`${MASTER}:gilbert-password`).toString("base64")}`;

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Something a pass writes, waited for: the work is asynchronous by design. */
async function until<T>(read: () => Promise<T>, ms = 5000): Promise<T | null> {
  for (let waited = 0; waited < ms; waited += 50) {
    const found = await read();
    if (found) return found;
    await sleep(50);
  }
  return null;
}

const HOLDER = "the-agent-process";

test("a handshake and a model are a process: it claims the installation and asks again", async (t) => {
  await waitForPort(BASE, AUTH);
  const lines: string[] = [];
  const agent = await startAgent({
    log: (line: string) => lines.push(line),
    holder: HOLDER,
  });
  assert.ok(
    agent,
    `the installation has a model, so it has an agent: ${lines.join(" | ")}`,
  );
  t.after(() => agent.stop());

  const session = await fetchUpstreamSession(AUTH, BASE);
  const ctx = { authorization: AUTH, session, username: MASTER };
  const claim = await until(async () => {
    const held = await readClaim(ctx);
    return held?.holder === HOLDER ? held : null;
  });
  assert.ok(claim, "a pass was asked, and the pass took the installation's claim");
  assert.ok(
    Date.parse(claim.expires) > Date.now(),
    "and the claim is this process's for a window, not a document left behind",
  );
  assert.match(
    lines[0] ?? "",
    /asking for a pass every/,
    "with the interval the process was told to ask on",
  );
});
