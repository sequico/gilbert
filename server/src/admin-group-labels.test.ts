import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The admin group-label catalog surface (ADR 0006), end to end against the
 * mock.
 *
 * Membership is the grant: an administrator who is a member of the group
 * reads and writes the catalog through their own session on the group's
 * account (no impersonation), and a non-member administrator is refused —
 * Stalwart 0.16 refuses to mint a session for an impersonated group account
 * (live-verified 2026-09-09; the mock reproduces the refusal). The demo user
 * is a member of `team@example.org` and not of `legal@example.org`, which
 * the directory also lists.
 */

const PORT = 18820;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-group-labels";
process.env.LOGIN_RATE_LIMIT = "10000";

const DEMO = "demo@example.com";
const TEAM = "team@example.org";
const LEGAL = "legal@example.org";

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
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
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

test("the directory lists the member and the non-member group", async () => {
  const res = await call("/api/admin/groups");
  assert.equal(res.status, 200);
  const names = ((res.body as { groups?: Array<{ name: string }> }).groups ?? []).map(
    (g) => g.name,
  );
  assert.ok(names.includes(TEAM));
  assert.ok(names.includes(LEGAL));
});

test("a member administrator reads and writes the group's catalog through their own session", async () => {
  const initial = await call(`/api/admin/groups/${TEAM}/labels`);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, { labels: [] });

  const label = { keyword: "urgent", name: "Urgent", color: "#d94f4f" };
  const posted = await call(`/api/admin/groups/${TEAM}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [label] }),
  });
  assert.equal(posted.status, 200);
  assert.deepEqual(posted.body, { ok: true });

  const read = await call(`/api/admin/groups/${TEAM}/labels`);
  assert.equal(read.status, 200);
  assert.deepEqual(
    read.body,
    { labels: [label] },
    "the catalog persisted in the group's files",
  );
});

test("a non-member administrator is refused with an honest 403", async () => {
  const res = await call(`/api/admin/groups/${LEGAL}/labels`);
  assert.equal(res.status, 403);
  const denied = res.body as { error: string; need?: string; message?: unknown };
  assert.equal(denied.error, "group_not_accessible", "the refusal names the reason");
  assert.equal(denied.need, "labels", "and the section the surface asked for");
  assert.ok(!("message" in denied), "the sentence is composed where it is read");
  const posted = await call(`/api/admin/groups/${LEGAL}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [] }),
  });
  assert.equal(posted.status, 403);
  const refused = posted.body as { error: string; need?: string; message?: unknown };
  assert.equal(refused.error, "group_not_accessible");
  assert.equal(refused.need, "labels");
  assert.ok(!("message" in refused));
});

test("the mock refuses impersonating a group, like a real 0.16 server", async () => {
  const composite = await fetch(`http://127.0.0.1:${PORT}/.well-known/jmap`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${TEAM}%${DEMO}:demo-password`).toString("base64")}`,
    },
  });
  assert.equal(composite.status, 401, "no session for an impersonated group account");
  const plain = await fetch(`http://127.0.0.1:${PORT}/.well-known/jmap`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${TEAM}:demo-password`).toString("base64")}`,
    },
  });
  assert.equal(plain.status, 401, "group principals have no credentials");
});
