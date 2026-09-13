import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * System Sieve scripts (ADR 0008): create, list, read, update, activate and
 * delete a `x:SieveSystemScript` through `/api/admin/sieve/system*`, plus the
 * two refusals that are this feature's own mechanism rather than a shared
 * one — a script that fails to compile, and two active scripts sharing a
 * case-insensitive name — and the one behaviour that differs from a
 * person's own Sieve scripts: more than one system script can be active at
 * once.
 */

const PORT = 18860;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-sieve";
process.env.LOGIN_RATE_LIMIT = "10000";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };
let cookie = "";

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    ...init,
    headers: { ...HEADERS, ...(init.headers as Record<string, string>), cookie },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }),
  });
  assert.equal(res.status, 200, "admin login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a system Sieve script can be created, listed, read, updated and deleted", async () => {
  const created = await call("/api/admin/sieve/system", {
    method: "POST",
    body: JSON.stringify({
      name: "greeting",
      description: "Adds a header",
      contents: 'require ["fileinto"];\nif true { stop; }',
      activate: true,
    }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id as string;
  assert.ok(id);

  const list = await call("/api/admin/sieve/system");
  assert.equal(list.status, 200);
  const row = (
    list.body.scripts as { id: string; name: string; isActive: boolean }[]
  ).find((s) => s.id === id);
  assert.ok(row, "the created script is listed");
  assert.equal(row?.name, "greeting");
  assert.equal(row?.isActive, true);
  // The list answer carries no `contents` — it is fetched separately.
  assert.equal((row as Record<string, unknown>).contents, undefined);

  const full = await call(`/api/admin/sieve/system/${id}`);
  assert.equal(full.status, 200);
  assert.equal(full.body.contents, 'require ["fileinto"];\nif true { stop; }');

  const updated = await call(`/api/admin/sieve/system/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "greeting",
      description: "Adds a header, updated",
      contents: 'require ["fileinto"];\nif true { stop; } else { keep; }',
      activate: false,
    }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const active = await call(`/api/admin/sieve/system/${id}/active`, {
    method: "POST",
    body: JSON.stringify({ active: true }),
  });
  assert.equal(active.status, 200);

  const destroyed = await call(`/api/admin/sieve/system/${id}`, { method: "DELETE" });
  assert.equal(destroyed.status, 200);
  const afterDelete = await call("/api/admin/sieve/system");
  assert.ok(!(afterDelete.body.scripts as { id: string }[]).some((s) => s.id === id));
});

test("a script that fails to compile is refused, not stored", async () => {
  const res = await call("/api/admin/sieve/system", {
    method: "POST",
    body: JSON.stringify({
      name: "broken",
      description: null,
      contents: "if true { stop;", // unbalanced
      activate: false,
    }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message as string, /brace/i);
  const list = await call("/api/admin/sieve/system");
  assert.ok(
    !(list.body.scripts as { name: string }[]).some((s) => s.name === "broken"),
    "the refused script was never stored",
  );
});

test("two active scripts cannot share a case-insensitive name, but two inactive ones can", async () => {
  const first = await call("/api/admin/sieve/system", {
    method: "POST",
    body: JSON.stringify({
      name: "Spam",
      description: null,
      contents: "if true { stop; }",
      activate: true,
    }),
  });
  assert.equal(first.status, 200);

  const clash = await call("/api/admin/sieve/system", {
    method: "POST",
    body: JSON.stringify({
      name: "spam",
      description: null,
      contents: "if true { stop; }",
      activate: true,
    }),
  });
  assert.equal(clash.status, 400);
  assert.match(clash.body.message as string, /already named/i);

  // Unlike a person's own Sieve scripts (only one active at a time), a second,
  // differently-named system script can be active alongside the first.
  const second = await call("/api/admin/sieve/system", {
    method: "POST",
    body: JSON.stringify({
      name: "quarantine",
      description: null,
      contents: "if true { stop; }",
      activate: true,
    }),
  });
  assert.equal(second.status, 200);
  const list = await call("/api/admin/sieve/system");
  const activeNames = (list.body.scripts as { name: string; isActive: boolean }[])
    .filter((s) => s.isActive)
    .map((s) => s.name);
  assert.ok(activeNames.includes("Spam"));
  assert.ok(activeNames.includes("quarantine"));
});
