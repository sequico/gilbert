import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * A blob download that the mail server refuses for credentials.
 *
 * The data path signs the reader out on a 401 by design, and the browser's
 * `fetchBlob`/`fetchBlobText` are written to do exactly that. The blob route
 * used to answer a 502 for any non-OK upstream, so an expired credential on a
 * download surfaced as a server error and that branch was unreachable. This
 * pins the route to the same 401 the `/api/jmap` route answers.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-blob-auth";
process.env.LOGIN_RATE_LIMIT = "10000";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

let cookie = "";

before(async () => {
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a download the mail server refuses for credentials signs the reader out", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/jmap/download/"))
      return new Response("", { status: 401 });
    return real(input, init);
  }) as typeof fetch;
  try {
    const res = await app.request("/api/blob/a1/some-blob/x.txt", {
      headers: { cookie, "x-requested-with": "gilbert" },
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "unauthenticated");
  } finally {
    globalThis.fetch = real;
  }
  // The session is gone, exactly as a 401 on /api/jmap leaves it.
  const after = await app.request("/api/auth/session", { headers: { cookie } });
  assert.equal(after.status, 401);
});
