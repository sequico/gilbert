import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The admin flag's other half: without the admin marker in the `/api/account`
 * permission list, isAdmin is false. Separate file on purpose — the mock
 * reads MOCK_ADMIN at import, so the two cases need separate processes.
 *
 * Mock port: must not collide with any other test file — the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 18812;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_ADMIN = "0";
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

test("a user without the admin marker signs in with isAdmin false", async () => {
  const res = await call("/api/auth/session");
  assert.equal(res.status, 200);
  assert.equal((res.body as { gilbert?: { isAdmin?: boolean } }).gilbert?.isAdmin, false);
});

test("a non-admin cannot create a page or a folder in the knowledge base", async () => {
  // Creating the tree is an administrator's (ADR 0024): a member writes the
  // draft of a page that exists, and nothing else.
  const page = await call("/api/knowledge/create", {
    method: "POST",
    body: JSON.stringify({ scope: "company", title: "Nope" }),
  });
  assert.equal(page.status, 403, JSON.stringify(page.body));
  const folder = await call("/api/knowledge/folder", {
    method: "POST",
    body: JSON.stringify({ scope: "company", name: "Nope" }),
  });
  assert.equal(folder.status, 403, JSON.stringify(folder.body));
});
