import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * An account that outranks the administrator acting on it (ADR 0001).
 *
 * The admin marker answers "is this account an administrator", which is one
 * permission. It does not answer the question a privileged write has to ask:
 * whether the target may hold *more* than the caller. Stalwart checks that a
 * caller holds every permission they grant when roles change and when an
 * account is created — not for every write — so an administrator could reach
 * into an account carrying a richer custom role and force a change on it.
 *
 * The target here holds a permission the plain administrator does not, and not
 * the marker: exactly the case `isStalwartAdmin` cannot see, and the one
 * `outranks` is for.
 */

const PORT = 18864;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.MOCK_TARGET_EXTRA_PERMISSION = "sysTenantCreate";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-outranks";
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

test("an administrator cannot force a change on an account that outranks them", async () => {
  const res = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB, clear: false }),
  });
  assert.equal(res.status, 403);
  assert.equal(
    (res.body as { error: string }).error,
    "target_outranks",
    "the refusal names the reason, and it is not the marker's reason",
  );
});
