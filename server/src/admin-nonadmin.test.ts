import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort, jsonCall } from "./testkit.js";

/**
 * The admin flag's other half: without the admin marker in the `/api/account`
 * permission list, isAdmin is false. Separate file on purpose — the mock
 * reads MOCK_ADMIN at import, so the two cases need separate processes.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_ADMIN = "0";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-non-admin-flag";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

const call = jsonCall(app, HEADERS);

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
  // Creating the tree is an administrator's (ADR 0020): a member writes the
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

test("a non-admin cannot write the company knowledge base through the shared save", async () => {
  // Saving the draft of a page that exists is a member's for a group's base,
  // but the company's is an administration's: the one shared save route gates
  // that tier on the same door as every other admin route (ADR 0020).
  const res = await call("/api/knowledge/save", {
    method: "POST",
    body: JSON.stringify({
      scope: "company",
      folder: "some-article",
      input: { title: "Nope", tags: [], blocks: [], text: "" },
    }),
  });
  assert.equal(res.status, 403, JSON.stringify(res.body));
});
