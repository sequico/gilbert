import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The admin grant: membership of the `gilbert-admin@<domain>` group mailbox
 * (ADR 0001). The unit tests pin the matching rules; the e2e half proves the
 * flag arrives on the session when the mock advertises the group.
 */

const PORT = 18798;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_ADMIN_GROUP = "gilbert-admin@example.com";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-flag";

const { isAdminSession } = await import("./upstream.js");
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
    body: JSON.stringify({
      username: "demo@example.com",
      password: "demo-password",
    }),
  });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("isAdminSession matches the group by local part, on any domain", () => {
  const session = (accounts: unknown[]) =>
    ({ accounts: Object.fromEntries(accounts.map((a, i) => [`a${i}`, a])) }) as never;
  const sameDomain = { name: "gilbert-admin@example.com", isPersonal: false };
  // A member whose own address is on another domain of the same server is an
  // admin too: the grant is server-scoped, never tied to the member's own
  // domain (ADR 0001).
  const otherDomain = { name: "gilbert-admin@example.org", isPersonal: false };
  const personal = { name: "gilbert-admin@example.com", isPersonal: true };
  const wrong = { name: "team@example.com", isPersonal: false };
  assert.equal(isAdminSession(session([sameDomain])), true);
  assert.equal(isAdminSession(session([otherDomain])), true);
  assert.equal(isAdminSession(session([personal])), false);
  assert.equal(isAdminSession(session([wrong])), false);
  assert.equal(isAdminSession(session([])), false);
});

test("a member of the admin group signs in with isAdmin on the session", async () => {
  const res = await call("/api/auth/session");
  assert.equal(res.status, 200);
  assert.equal((res.body as { gilbert?: { isAdmin?: boolean } }).gilbert?.isAdmin, true);
});
