/**
 * The installation's switch, against the mock Stalwart (ADR 0038).
 *
 * The switch governs whether the agent acts at all, so its two shapes are pinned
 * here: absent means on, and a document that is there and cannot be read stops
 * the pass rather than being read as on. The second is the one direction of the
 * failure that acts — reading a broken file as "on" would re-enable an agent
 * somebody turned off.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-switch";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId, writeAppBytesAt, writeAppFileAt } = await import(
  "../appFolder.js"
);
const { AGENT_SWITCH_FILE, readAgentSwitch, rememberedAgentSwitch, writeAgentSwitch } =
  await import("./switch.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

let ctx: Ctx;
let accountId: string;

before(async () => {
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the demo account owns Files");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("an installation that never chose has its agent, and a write is read back", async () => {
  assert.deepEqual(await readAgentSwitch(ctx, accountId), { enabled: true });
  assert.deepEqual(rememberedAgentSwitch(), { enabled: true });

  await writeAgentSwitch(ctx, accountId, false);
  assert.deepEqual(await readAgentSwitch(ctx, accountId), { enabled: false });
  assert.deepEqual(rememberedAgentSwitch(), { enabled: false });

  await writeAgentSwitch(ctx, accountId, true);
  assert.deepEqual(await readAgentSwitch(ctx, accountId), { enabled: true });
});

test("a switch that is there and is not a document stops the pass", async () => {
  // A value the build does not read is not "on": the agent somebody turned off
  // would act again, which is the one failure of this file that does something.
  await writeAppFileAt(ctx, accountId, AGENT_SWITCH_FILE, { enabled: "false" });
  await assert.rejects(
    () => readAgentSwitch(ctx, accountId),
    /cannot be read|not a document/,
  );
  assert.equal(rememberedAgentSwitch(), null, "and the last good value answers nothing");
});

test("a switch that is not JSON stops the pass, and is left as it is", async () => {
  await writeAppBytesAt(
    ctx,
    accountId,
    AGENT_SWITCH_FILE,
    new TextEncoder().encode("not json"),
    "application/json",
  );
  await assert.rejects(() => readAgentSwitch(ctx, accountId), /not a document/);
  assert.equal(rememberedAgentSwitch(), null);
});
