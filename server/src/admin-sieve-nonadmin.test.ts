import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * System Sieve scripts (ADR 0008) sit behind `requireAdmin` like every other
 * admin route (ADR 0001). Separate file on purpose — the mock reads
 * MOCK_ADMIN at import, so the admin and non-admin cases need separate
 * processes (see `admin-nonadmin.test.ts`).
 */

const PORT = 18861;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_ADMIN = "0";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-sieve-nonadmin";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };
let cookie = "";

async function call(path: string, init: RequestInit = {}) {
  const res = await app.request(path, {
    ...init,
    headers: { ...HEADERS, ...(init.headers as Record<string, string>), cookie },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  return { status: res.status, body: await res.json() };
}

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }),
  });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a non-admin cannot list or write system Sieve scripts", async () => {
  const list = await call("/api/admin/sieve/system");
  assert.equal(list.status, 403);
  assert.equal((list.body as { error?: string }).error, "forbidden");

  const create = await call("/api/admin/sieve/system", {
    method: "POST",
    body: JSON.stringify({
      name: "x",
      description: null,
      contents: "stop;",
      activate: false,
    }),
  });
  assert.equal(create.status, 403);
});
