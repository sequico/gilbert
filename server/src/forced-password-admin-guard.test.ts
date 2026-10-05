import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The admin half of the forced-password-change endpoints (ADR 0001): without
 * the admin marker in the session's `/api/account` permission list the guard
 * answers 403 before anything touches the target. The mock also refuses the
 * composite `{target}%{admin}` impersonation username when the master does
 * not hold Stalwart's `impersonate` permission — the right the actions
 * themselves use (ADR 0001). Separate file on purpose: the mock reads
 * MOCK_ADMIN at import, so this case needs its own process.
 */

const PORT = 18792;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.MOCK_ADMIN = "0";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-guard";

const DEMO = "demo@example.com";
const BOB = "bob@example.com";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };
let cookie = "";

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
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: "demo-password" }),
  });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a non-admin is refused by the requireAdmin guard", async () => {
  const session = await call("/api/auth/session");
  assert.equal(session.body.gilbert.isAdmin, false);
  const res = await call("/api/admin/force-password-change", {
    method: "POST",
    body: JSON.stringify({ target: BOB }),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "forbidden");
});

test("the refusal happens before any target work", async () => {
  // Even a body the guard would reject out of hand never reaches the handler:
  // the 403 is the guard's, not a validation error.
  const res = await call("/api/admin/force-password-change", {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "forbidden");
});

test("without the impersonation right the mock refuses the composite username", async () => {
  // The same request the server would make for an admin action: composite
  // `{target}%{master}` with valid master credentials. A non-admin master
  // holds no `impersonate` permission (ADR 0001).
  const res = await fetch(`http://127.0.0.1:${PORT}/.well-known/jmap`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${BOB}%${DEMO}:demo-password`).toString("base64")}`,
    },
  });
  assert.equal(res.status, 401, "the impersonation right is the grant (ADR 0001)");
});

test("a non-admin's own data path is unaffected", async () => {
  const res = await call("/api/jmap", {
    method: "POST",
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core"],
      methodCalls: [["Principal/get", { accountId: "a1", ids: null }, "p"]],
    }),
  });
  assert.equal(res.status, 200);
});
