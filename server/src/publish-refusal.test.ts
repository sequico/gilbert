import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PublishOutcome } from "./app.js";

/**
 * A publish into an installation where one account refuses (ADR 0001).
 *
 * The directory lists an account the server will not let anyone act as. That is
 * not a failure of the publish — the policy still reaches every other account —
 * but it is a fact about the installation, and the outcome names it: which
 * account, why, and that the installation therefore does not carry the policy
 * everywhere. A count of successes that reads as "published" is what this
 * refuses to be.
 */

const PORT = 18906;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
// The account the server refuses to act as, as the directory still lists it.
process.env.MOCK_REFUSED_USER = "carol@example.com";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-publish-refusal";
process.env.LOGIN_RATE_LIMIT = "10000";
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const REFUSED = "carol@example.com";

type Body = Record<string, unknown>;

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Body | null; cookie: string }> {
  const res = await app.request(path, {
    ...init,
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Body) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

let adminCookie = "";

before(async () => {
  const res = await call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username: ADMIN, password: ADMIN_PASS }),
  });
  assert.equal(res.status, 200, "the admin should be able to sign in");
  adminCookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

const DOC = JSON.stringify({ enforced: { readingPane: false } }, null, 2);

test("the account the server refuses to act as is named, with its reason", async () => {
  const res = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(res.status, 200, "a refusal on one account is not a failed publish");
  const outcome = (res.body as { outcome: PublishOutcome }).outcome;

  const refused = outcome.unreached.find((one) => one.address === REFUSED);
  assert.ok(refused, `the outcome names ${REFUSED} rather than leaving it out`);
  assert.equal(
    refused!.code,
    "impersonation-refused",
    "the reason travels as a code the client composes a sentence from",
  );
  assert.ok(refused!.message.length > 0, "and the server's own words come with it");

  assert.ok(
    outcome.reached.length > 1,
    "every other account the directory lists was still written to",
  );
  assert.equal(
    outcome.complete,
    false,
    "one account short of the directory is not an installation that carries the policy",
  );
});
