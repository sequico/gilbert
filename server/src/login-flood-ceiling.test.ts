import assert from "node:assert/strict";
import { test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * The ceiling that answers without the body.
 *
 * `loginFloodLimiter` is the one sign-in limit that is never refunded, so it
 * has to be the cheapest thing on the endpoint to answer: it needs neither the
 * parsed body nor the upstream, and it is consulted before anything is read.
 * The observable consequence is that once the ceiling is spent, a request
 * whose body is not even JSON answers 429 rather than 400 — it never reaches
 * the parse. Consulted after the parse, as it was, every one of these would be
 * a 400 and the ceiling would only ever be felt by well-formed attackers.
 *
 * The limit is left at its floor so the ceiling (twenty times it) is reachable
 * in a few requests, and nothing here reaches Stalwart: the answer is settled
 * before any upstream is asked.
 */

const PORT = await freePort();
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-login-flood";
process.env.LOGIN_RATE_LIMIT = "1";

const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

test("the flood ceiling answers a body that is not JSON, rather than the parse", async () => {
  let limited: Response | null = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: HEADERS,
      body: "not json",
    });
    if (res.status === 429) limited = res;
    else assert.equal(res.status, 400, "before the ceiling, a bad body is a bad request");
  }
  assert.ok(limited, "the ceiling must be reachable in a few dozen attempts");
  assert.equal(((await limited.json()) as { error: string }).error, "rate_limited");
  assert.ok(limited.headers.get("retry-after"), "a refusal says how long to wait");
});
