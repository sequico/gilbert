import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * The admin grant (ADR 0001): a signed-in user whose `/api/account`
 * permission list carries the configured admin marker is a Stalwart admin
 * and therefore a Gilbert admin. The unit tests pin the marker rule; the
 * e2e half proves the flag arrives on the session when the mock reports
 * the marker.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-flag";

const { isStalwartAdmin } = await import("./upstream.js");
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

test("isStalwartAdmin reads the admin marker from the permission list", () => {
  // The marker is `sysAccountCreate` by default (config.adminPermissionMarker,
  // live-verified 2026-09-09); the recovery admin token reports every
  // permission, marker included.
  assert.equal(
    isStalwartAdmin(["jmapEmailGet", "sysAccountCreate", "impersonate"]),
    true,
  );
  // An admin role bundles `impersonate`, but the marker is what decides: a
  // non-admin given `impersonate` alone is not a Stalwart admin.
  assert.equal(isStalwartAdmin(["jmapEmailGet", "impersonate"]), false);
  assert.equal(isStalwartAdmin(["jmapEmailGet", "sysAccountSettingsGet"]), false);
  // Fail-closed: an empty or missing list is never admin.
  assert.equal(isStalwartAdmin([]), false);
  assert.equal(isStalwartAdmin(null), false);
  assert.equal(isStalwartAdmin(undefined), false);
});

test("a Stalwart admin signs in with isAdmin on the session", async () => {
  const res = await call("/api/auth/session");
  assert.equal(res.status, 200);
  assert.equal((res.body as { gilbert?: { isAdmin?: boolean } }).gilbert?.isAdmin, true);
});
