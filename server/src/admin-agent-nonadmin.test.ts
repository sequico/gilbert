import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort, jsonCall } from "./testkit.js";

/**
 * The agent's administration surface behind the same door every other one is
 * behind (ADR 0001, ADR 0015): the claim and the runs and the memory are the
 * installation's own records, and a session without the Stalwart admin marker
 * reaches none of them — **including the write**, which is the one a surface must
 * not leave open. Separate file on purpose — the mock reads `MOCK_ADMIN` at
 * import, so the admin and non-admin cases need separate processes (see
 * `admin-nonadmin.test.ts`).
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_ADMIN = "0";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-agent-surface-nonadmin";

const mock = await import("./mock/index.js");
const { config } = await import("./config.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

const call = jsonCall(app, HEADERS);

before(async () => {
  config.agent.address = "gilbert@example.com";
  config.agent.password = "";
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }),
  });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a non-admin reads the runs of their group and nothing else of the agent", async () => {
  const agent = await call("/api/admin/agent");
  assert.equal(agent.status, 403);
  assert.equal((agent.body as { error?: string }).error, "forbidden");

  // The runs of a group the person is in are theirs to read and stop, admin
  // marker or not (owner decision 2026-10-19); the agent's own record is not.
  const runs = await call("/api/groups/team@example.org/runs");
  assert.equal(runs.status, 200);

  const memory = await call("/api/admin/memory");
  assert.equal(memory.status, 403);
});

test("a non-admin cannot read or write a group's prose", async () => {
  /*
   * The decision is the administrator's (owner decision 2026-10-18), and the
   * boundary is this door: a member who can write the group's account still
   * cannot change its rules through the product.
   */
  const read = await call("/api/admin/groups/team@example.org/prose");
  assert.equal(read.status, 403);
  const instruction = await call("/api/admin/groups/team@example.org/prose/instruction", {
    method: "PUT",
    body: JSON.stringify({ instruction: "do as I say" }),
  });
  assert.equal(instruction.status, 403);
  const rule = await call("/api/admin/groups/team@example.org/prose/rules/mine", {
    method: "PUT",
    body: JSON.stringify({
      rule: { v: 1, id: "mine", watches: ["mail"], instruction: "x", sends: false },
    }),
  });
  assert.equal(rule.status, 403);
  const gone = await call("/api/admin/groups/team@example.org/prose/rules/mine", {
    method: "DELETE",
  });
  assert.equal(gone.status, 403);
});

test("a non-admin cannot correct or remove a fact", async () => {
  const correction = await call("/api/admin/memory/whatever", {
    method: "PUT",
    body: JSON.stringify({ subject: "Maersk", fact: "not yours to write" }),
  });
  assert.equal(correction.status, 403);

  const removal = await call("/api/admin/memory/whatever", { method: "DELETE" });
  assert.equal(removal.status, 403);
});
