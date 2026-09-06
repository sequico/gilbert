import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The other half of the admin flag: without the `gilbert-admin@…` group in
 * the session accounts, isAdmin is false. Separate file on purpose — the mock
 * reads MOCK_ADMIN_GROUP at import, so the two cases need separate processes.
 */

const PORT = 18799;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_ADMIN_GROUP = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-non-admin-flag";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
let cookie = "";
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(path: string, init: RequestInit = {}) {
  const res = await app.request(path, {
    ...init,
    headers: {
      ...HEADERS,
      ...(init.headers as Record<string, string>),
      ...(cookie ? { cookie } : {}),
    },
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

test("a user outside the admin group signs in with isAdmin false", async () => {
  const res = await call("/api/auth/session");
  assert.equal(res.status, 200);
  assert.equal((res.body as { gilbert?: { isAdmin?: boolean } }).gilbert?.isAdmin, false);
});
