import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The guard that refuses to force another Gilbert administrator (ADR 0001,
 * the admin Users surface): when the target is itself a member of the admin
 * group, the impersonated session shows it and the endpoint answers 403 —
 * for both setting and clearing the directive.
 *
 * The mock makes the target an admin too (MOCK_TARGET_IS_ADMIN=1) so the
 * refusal path is exercised end to end.
 */

const PORT = 18802;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.MOCK_ADMIN_GROUP = "gilbert-admin@example.com";
process.env.MOCK_TARGET_IS_ADMIN = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-force-guard";
process.env.LOGIN_RATE_LIMIT = "10000";

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> | null; cookie: string }> {
  const res = await app.request(path, {
    ...init,
    headers: {
      ...HEADERS,
      ...(init.headers as Record<string, string>),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

let adminCookie = "";

before(async () => {
  const res = await call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username: ADMIN, password: ADMIN_PASS }),
  });
  assert.equal(res.status, 200, "admin login should succeed against the mock");
  adminCookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("an administrator cannot force another administrator's password", async () => {
  const set = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB, clear: false }),
  });
  assert.equal(set.status, 403);
  assert.equal(
    (set.body as { error: string }).error,
    "target_is_admin",
    "the refusal names the reason",
  );
});

test("an administrator cannot release the directive on another administrator either", async () => {
  const clear = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB, clear: true }),
  });
  assert.equal(clear.status, 403);
  assert.equal((clear.body as { error: string }).error, "target_is_admin");
});
