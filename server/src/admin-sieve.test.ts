import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * System Sieve scripts (ADR 0008): create, list, read, update, activate and
 * delete a `x:SieveSystemScript` through `/api/admin/sieve/system*`, plus the
 * refusals that are this feature's own mechanism rather than a shared one —
 * a script that fails to compile, two active scripts sharing a
 * case-insensitive name, and a write built on a `state` that has since
 * moved — and the one behaviour that differs from a person's own Sieve
 * scripts: more than one system script can be active at once.
 */

const PORT = await freePort();
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

test("updating a script that no longer exists is answered as a refusal, not a silent success", async () => {
  const res = await call("/api/admin/sieve/system/does-not-exist", {
    method: "PUT",
    body: JSON.stringify({
      name: "ghost",
      description: null,
      contents: "if true { stop; }",
      activate: false,
    }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message as string, /no longer exists/i);
});

test("a save built on a state that has since moved is refused, not silently overwritten", async () => {
  const created = await call("/api/admin/sieve/system", {
    method: "POST",
    body: JSON.stringify({
      name: "stale-write",
      description: null,
      contents: "if true { stop; }",
      activate: false,
    }),
  });
  assert.equal(created.status, 200);
  const id = created.body.id as string;

  const read = await call(`/api/admin/sieve/system/${id}`);
  assert.equal(read.status, 200);
  const staleState = read.body.state as string;
  assert.ok(staleState);

  // Someone else's edit lands first, advancing the state past what was read above.
  const firstWrite = await call(`/api/admin/sieve/system/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "stale-write",
      description: null,
      contents: "if true { keep; }",
      activate: false,
      state: staleState,
    }),
  });
  assert.equal(firstWrite.status, 200, JSON.stringify(firstWrite.body));

  // A second write built on the same, now-stale read is refused rather than
  // clobbering the first one.
  const staleWrite = await call(`/api/admin/sieve/system/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "stale-write",
      description: null,
      contents: "if true { stop; } else { keep; }",
      activate: true,
      state: staleState,
    }),
  });
  assert.equal(staleWrite.status, 409, JSON.stringify(staleWrite.body));
  assert.equal(staleWrite.body.error, "conflict");

  // The content the first write stored is still there, untouched by the refused one.
  const after = await call(`/api/admin/sieve/system/${id}`);
  assert.equal(after.body.contents, "if true { keep; }");
  assert.equal(after.body.isActive, false);
});

test("activating a script from the list is also guarded by state, and a stale toggle is refused", async () => {
  const created = await call("/api/admin/sieve/system", {
    method: "POST",
    body: JSON.stringify({
      name: "toggle-race",
      description: null,
      contents: "if true { stop; }",
      activate: false,
    }),
  });
  assert.equal(created.status, 200);
  const id = created.body.id as string;

  const list1 = await call("/api/admin/sieve/system");
  const staleListState = list1.body.state as string;
  assert.ok(staleListState);

  // A rename (any write) advances the type's state past what the list above read.
  const rename = await call(`/api/admin/sieve/system/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "toggle-race",
      description: "renamed first",
      contents: "if true { stop; }",
      activate: false,
    }),
  });
  assert.equal(rename.status, 200);

  const staleToggle = await call(`/api/admin/sieve/system/${id}/active`, {
    method: "POST",
    body: JSON.stringify({ active: true, state: staleListState }),
  });
  assert.equal(staleToggle.status, 409);
  assert.equal(staleToggle.body.error, "conflict");

  const list2 = await call("/api/admin/sieve/system");
  const row = (list2.body.scripts as { id: string; isActive: boolean }[]).find(
    (s) => s.id === id,
  );
  assert.equal(row?.isActive, false, "the refused toggle never applied");
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
