import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The admin Users surface (ADR 0001 §5, ADR 0007): the directory
 * enumeration returns individual accounts only (groups filtered out by the
 * Principal/query type filter), the impersonation probe says whether this
 * session may act, and non-admins get 403.
 */

const PORT = 18801;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-users";
process.env.LOGIN_RATE_LIMIT = "10000";

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";
const BOB_PASS = "bob-password";

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

async function login(username: string, password: string) {
  return call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

let adminCookie = "";

before(async () => {
  const res = await login(ADMIN, ADMIN_PASS);
  assert.equal(res.status, 200, "admin login should succeed against the mock");
  adminCookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a non-admin cannot list users", async () => {
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200);
  const res = await call("/api/admin/users", bob.cookie);
  assert.equal(res.status, 403);
});

test("the directory enumeration returns individual accounts, groups excluded", async () => {
  const res = await call("/api/admin/users", adminCookie);
  assert.equal(res.status, 200);
  const body = res.body as {
    users: Array<{ id: string; name: string }>;
    enumeration: boolean;
    canImpersonate: boolean;
  };
  assert.equal(body.enumeration, true);
  assert.ok(Array.isArray(body.users) && body.users.length > 0);
  const names = body.users.map((u) => u.name);
  assert.ok(
    names.includes("ada@example.org"),
    "an individual principal from the mock directory is listed",
  );
  assert.ok(
    !names.includes("team@example.org"),
    "group principals are filtered out by the type filter",
  );
  for (const name of names)
    assert.ok(name.includes("@"), `every listed user is an address: ${name}`);
});

test("the impersonation probe reports a session that may act on accounts", async () => {
  const res = await call("/api/admin/users", adminCookie);
  const body = res.body as {
    impersonation: "ok" | "denied" | "unknown";
  };
  assert.equal(body.impersonation, "ok");
});
