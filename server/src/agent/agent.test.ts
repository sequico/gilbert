/**
 * The agent the server starts with itself (ADR 0031, 0036).
 *
 * What is pinned is the wiring that makes the agent part of the product rather
 * than a second process: the installation's **real boot** against the mock
 * Stalwart (`bootInstallation`), handed to the agent's own start
 * (`supervisor.ts`), finds the installation's **model** in the document the
 * Master's account already holds (the demo seed, ADR 0011) and asks the loop for
 * a pass — the pass is what takes the installation's claim, so the claim
 * document's holder is the proof that a pass was asked.
 *
 * The pass is the **first** one, asked on the way up rather than by an interval:
 * the agent is left on the product's own ten-second period, and a claim taken
 * within the wait below can only be that first pass — a wait that came due while
 * nothing was running is worked at once, not up to ten seconds later.
 *
 * The accounts that pass works are the groups the Master holds, read from the
 * mail server by that pass itself (`supervisor.ts`'s `resolveGroupAccounts`):
 * the demo seeds the agent into two of them, so the pass works real accounts and
 * leaves the claim behind it.
 *
 * No model call is made: the demo ships no rules, so no pass reaches a provider
 * and none is stubbed. What a pass does with a rule and a model is `loop.test.ts`,
 * and the agent's own conditions are `supervisor.test.ts`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const { bootInstallation } = await import("../bootstrap.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId, writeAppFile } = await import("../appFolder.js");
const { readClaim } = await import("./claim.js");
const { startAgent } = await import("./supervisor.js");
const { INSTALLATION_FILE, installationDefaults } = await import(
  "../shared/installation.js"
);

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

const HOLDER = "the-server-process";

test("the installation's boot and its model are an agent whose first pass takes the claim", async (t) => {
  await waitForPort(BASE, AUTH);
  const boot = await bootInstallation();
  const lines: string[] = [];
  const agent = await startAgent(boot, {
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
    "with the interval the agent asks on",
  );
});

test("an installation that has chosen no model leaves the boot done and the agent idle", async () => {
  /*
   * The document the boot reads, with no model: the administration has not
   * chosen one, which ADR 0031 answers with no agent rather than a provider
   * nobody chose. What is asserted is the whole of what the server needs — the
   * boot resolved and the agent answered a value — so a condition of the agent
   * can never be the reason a server does not come up.
   */
  const session = await fetchUpstreamSession(AUTH, BASE);
  const ctx = { authorization: AUTH, session, username: MASTER };
  const accountId = filesAccountId(ctx);
  assert.ok(accountId, "the Master's session holds a Files account");
  await writeAppFile(ctx, accountId, INSTALLATION_FILE, {
    ...installationDefaults(),
    secret: "an-installation-secret-long-enough-to-seal-a-session-with",
  });

  const boot = await bootInstallation();
  assert.equal(
    boot.configuration.appSecretSource,
    "document",
    "the boot is a serving boot: a secret it read, not one it minted",
  );
  const lines: string[] = [];
  const agent = await startAgent(boot, { log: (line: string) => lines.push(line) });
  assert.equal(agent, null, "and the agent is idle");
  assert.deepEqual(lines, [
    "[gilbert] agent: this installation has chosen no model, so the agent stays idle until one is chosen (ADR 0031)",
  ]);
});

test("the server's own boot is what starts it, and the shutdown gives it up", async () => {
  /*
   * The one link a test cannot run: the server's boot binds a port and holds it,
   * so a test that called it would never return. What is asserted is therefore
   * the boot's own text — the agent is started with the installation that boot
   * read, and stopped with the rest of the shutdown — and the behaviour on both
   * ends of that line is the two tests above (`startAgent` on a real boot) and
   * `supervisor.test.ts` (`stop`).
   */
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /const agent = await startAgent\(boot,/,
    "the boot starts the agent with the installation it read",
  );
  assert.match(source, /agent\?\.stop\(\);/, "and the shutdown gives it up");
});
