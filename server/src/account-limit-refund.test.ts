import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort, jsonCall } from "./testkit.js";

/**
 * An outage must not spend a credential endpoint's attempts.
 *
 * The account limiter (20 attempts / 15 minutes) bounds password guessing, and
 * it is spent before the upstream call. When the mail server cannot be reached
 * at all, that failure is not a judgement about the password, so the attempt
 * has to go back — otherwise a reader retrying through a brief outage spends
 * the window and is answered 429 for a quarter of an hour after it ended
 * (#239, the login path's own rule).
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-account-limit-refund";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };
const realFetch = globalThis.fetch;

const call = jsonCall(app, HEADERS);

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }),
  });
  assert.equal(res.status, 200, "the mock signs the reader in");
  // Take the mail server away: every upstream request now fails at the
  // connection, which is the outage the attempts must survive.
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  (mock as { server?: { close(): void } }).server?.close();
});

test("an outage does not spend a credential endpoint's attempts", async () => {
  // More than the limiter's twenty: without the refund, the twenty-first is 429.
  for (let i = 0; i < 25; i++) {
    const res = await call("/api/account/app-passwords/revoke", {
      method: "POST",
      body: JSON.stringify({ id: "anything" }),
    });
    assert.notEqual(res.status, 429, `attempt ${i + 1} must not be rate limited`);
    assert.equal(res.status, 502, "the outage is answered as an upstream failure");
  }
});
