import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * Gilbert requires Stalwart 1.0 or newer, and the version that matters is the
 * FileNode shape: 0.16 and 1.0 both publish `1.0.0` as the server version, so
 * the only honest question is how a node comes back. A server answers `@type`
 * on 1.0 and `nodeType` on 0.16; the probe in `appFolder.ts` reads one node and
 * refuses the older shape at sign-in, before the boot writes anything.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_FILENODE_V0 = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-login-guard";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a 0.16 FileNode shape is refused, with good credentials", async () => {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "gilbert" },
    body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }),
  });
  const body = (await res.json()) as { error?: string; message?: string };
  assert.equal(res.status, 501);
  assert.equal(body.error, "unsupported_server");
  assert.match(body.message ?? "", /credentials are fine/i);
});
