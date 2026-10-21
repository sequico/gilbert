/**
 * The one-off clear of the rules' documents (ADR 0038).
 *
 * What is pinned: the old rule documents go, the marker says it happened, and a
 * second call removes nothing — a process that restarts does not walk the folder
 * again, and the instruction the group wrote now is not touched.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  type Ctx,
  destroyAppNode,
  ensureFolderPath,
  filesAccountId,
  findAppFileAt,
  findFolderPath,
  writeAppFileAt,
} from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-legacy";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { clearLegacyAgentState, RESET_FILE } = await import("./legacy.js");
const { INSTRUCTION_FILE } = await import("../shared/instruction.js");

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
  await clean();
});

after(async () => {
  await clean();
  (mock as { server?: { close(): void } }).server?.close();
});

/** Leave the account as the test found it: no rules, no marker, no instruction. */
async function clean(): Promise<void> {
  const rules = await findFolderPath(ctx, accountId, "rules");
  if (rules) await destroyAppNode(ctx, accountId, rules, { removeChildren: true });
  for (const path of ["agent/rules.json", RESET_FILE, INSTRUCTION_FILE]) {
    const found = await findAppFileAt(ctx, accountId, path).catch(() => null);
    const id = found?.file && typeof found.file.id === "string" ? found.file.id : null;
    if (id) await destroyAppNode(ctx, accountId, id).catch(() => undefined);
  }
}

test("the old rule documents go once, and the instruction stays", async () => {
  const rules = await ensureFolderPath(ctx, accountId, "rules");
  assert.ok(rules);
  await writeAppFileAt(ctx, accountId, "rules/shipper.json", { v: 2, id: "shipper" });
  await writeAppFileAt(ctx, accountId, "agent/rules.json", { v: 1 });
  await writeAppFileAt(ctx, accountId, INSTRUCTION_FILE, {
    v: 2,
    instruction: "Answer the shipper.",
    areas: ["mail"],
  });

  assert.deepEqual(await clearLegacyAgentState(ctx, accountId), [
    "rules/",
    "agent/rules.json",
  ]);
  assert.equal(await findFolderPath(ctx, accountId, "rules"), null, "the folder is gone");
  assert.equal(
    (await findAppFileAt(ctx, accountId, "agent/rules.json"))?.file ?? null,
    null,
    "and the legacy document with it",
  );
  assert.ok(
    (await findAppFileAt(ctx, accountId, RESET_FILE))?.file,
    "the marker says it was done",
  );
  assert.ok(
    (await findAppFileAt(ctx, accountId, INSTRUCTION_FILE))?.file,
    "and the group's instruction is not touched",
  );

  assert.deepEqual(
    await clearLegacyAgentState(ctx, accountId),
    [],
    "a second call removes nothing",
  );
});
