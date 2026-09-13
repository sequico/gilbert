import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The installation-wide policy document (ADR 0001 §4, ADR 0004, ADR 0015):
 * only admins read or publish it; an invalid document is refused; a valid
 * publish writes into every individual account the directory lists — the
 * publisher's own account included — and each account's own authenticated
 * `GET /api/account/policy` answers with what the publish just wrote there.
 */

const PORT = 18799;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-policy";
process.env.LOGIN_RATE_LIMIT = "10000";
// The installation under test names no agent, so the policy tests exercise the
// document with none in the environment.
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";
const BOB_PASS = "bob-password";

type Body = Record<string, unknown>;

interface AccountPolicy {
  policy: {
    defaults: Record<string, unknown>;
    enforced: Record<string, unknown>;
    changes: Array<{ version: string; settings: Record<string, unknown> }>;
  };
}

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");
const { readAccountPolicy } = await import("./adminPolicy.js");
const { filesAccountId } = await import("./appFolder.js");
const { fetchUpstreamSession } = await import("./upstream.js");

const BASE = `http://127.0.0.1:${PORT}`;
const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Body | null; cookie: string }> {
  const res = await app.request(path, {
    ...init,
    headers: {
      ...HEADERS,
      ...(init.headers as Record<string, string>),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Body) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

async function login(
  username: string,
  password: string,
): Promise<{ status: number; body: Body | null; cookie: string }> {
  return call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

let adminCookie = "";

before(async () => {
  const res = await login(ADMIN, ADMIN_PASS);
  assert.equal(res.status, 200, "admin login should succeed against the mock");
  adminCookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

const DOC = JSON.stringify(
  {
    defaults: { density: "cozy" },
    enforced: { readingPane: false },
    changes: [{ version: "v1", settings: { autoAdvance: false } }],
  },
  null,
  2,
);

test("a non-admin cannot read or publish the policy", async () => {
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200, "bob should be able to sign in");
  const read = await call("/api/admin/policy", bob.cookie);
  assert.equal(read.status, 403, "only an admin reads the policy");
  const write = await call("/api/admin/policy", bob.cookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(write.status, 403, "only an admin publishes the policy");
});

test("an admin reads the current policy as the editor document", async () => {
  const res = await call("/api/admin/policy", adminCookie);
  assert.equal(res.status, 200);
  const policy = JSON.parse((res.body as { policy: string }).policy) as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    Object.keys(policy).sort(),
    ["changes", "defaults", "enforced"],
    "the editor document has the three sections",
  );
});

test("an invalid document is refused with a message that says what is wrong", async () => {
  const cases: Array<[string, string]> = [
    ["not json at all", "Not valid JSON"],
    [JSON.stringify([1, 2]), "must be a JSON object"],
    [JSON.stringify({ defaults: 3 }), '"defaults" must be an object'],
    [JSON.stringify({ enforced: "x" }), '"enforced" must be an object'],
    [
      JSON.stringify({
        changes: [
          { version: "v1", settings: { a: 1 } },
          { version: "v1", settings: { a: 2 } },
        ],
      }),
      'share the version "v1"',
    ],
    [JSON.stringify({ changes: [{ version: "", settings: {} }] }), 'has no "version"'],
    [JSON.stringify({ changes: "nope" }), '"changes" must be an array'],
  ];
  for (const [bad, expected] of cases) {
    const res = await call("/api/admin/policy", adminCookie, {
      method: "POST",
      body: bad,
    });
    assert.equal(res.status, 400, `should refuse: ${bad.slice(0, 60)}`);
    const message = (res.body as { message: string }).message;
    assert.ok(
      message.includes(expected),
      `message should say: ${expected} — got: ${message}`,
    );
  }
  // No invalid publish reached the admin's own account either.
  const read = await call("/api/admin/policy", adminCookie);
  const policy = JSON.parse((read.body as { policy: string }).policy) as {
    enforced: Record<string, unknown>;
  };
  assert.equal(
    Object.keys(policy.enforced).length,
    0,
    "no invalid publish reached the running policy",
  );
});

test("a valid publish writes into the publisher's own account and every other one the directory lists", async () => {
  const res = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(res.status, 200);
  assert.equal((res.body as { ok: boolean }).ok, true);
  const { reached, unreached } = res.body as {
    reached: number;
    unreached: Array<{ address: string; message: string }>;
  };
  // The mock directory lists five people plus the agent principal, besides
  // the publishing admin itself: every one of them is reached, none refused.
  assert.ok(reached >= 6, `expected at least 6 accounts reached, got ${reached}`);
  assert.deepEqual(unreached, [], "nothing in the mock directory refused the write");

  // The publisher's own next read of the editor shows exactly what it wrote.
  const admin = await call("/api/admin/policy", adminCookie);
  const adminDoc = JSON.parse((admin.body as { policy: string }).policy) as {
    defaults: Record<string, unknown>;
    enforced: Record<string, unknown>;
  };
  assert.equal(adminDoc.enforced.readingPane, false);
  assert.equal(adminDoc.defaults.density, "cozy");

  // A directory account that never signs in (it has no password in this
  // mock) still has the publish in its own account -- verified the way the
  // administrator reaches it, by impersonation, rather than by signing in.
  const adaAuth = `Basic ${Buffer.from(`ada@example.org%${ADMIN}:${ADMIN_PASS}`).toString("base64")}`;
  const adaSession = await fetchUpstreamSession(adaAuth, BASE);
  const adaCtx = {
    authorization: adaAuth,
    session: adaSession,
    username: "ada@example.org",
  };
  const adaAccountId = filesAccountId(adaCtx);
  assert.ok(adaAccountId, "ada's impersonated session has a Files account");
  const adaPolicy = await readAccountPolicy(adaCtx, adaAccountId);
  assert.ok(adaPolicy, "the publish reached ada's own account");
  assert.equal(adaPolicy!.enforced.readingPane, false);
  assert.equal(adaPolicy!.defaults.density, "cozy");
  assert.equal(adaPolicy!.changes[0]!.version, "v1");

  // Bob is not part of this mock's enumerable directory (he exists only as a
  // separate impersonation-test target), so the publish does not reach him —
  // his own read falls back to the environment's bootstrap, unchanged.
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200);
  const bobPolicy = await call("/api/account/policy", bob.cookie);
  assert.equal(bobPolicy.status, 200);
  const sp = (bobPolicy.body as unknown as AccountPolicy).policy;
  assert.equal(
    sp.enforced.readingPane,
    undefined,
    "bob was never reached by this publish",
  );
});

test("publishing kicks every session except the caller's", async () => {
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200);
  const alive = await call("/api/auth/session", bob.cookie);
  assert.equal(alive.status, 200, "bob's session is alive before the publish");
  const res = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(res.status, 200);
  assert.ok((res.body as { kicked: number }).kicked >= 1, "other sessions were kicked");
  const dead = await call("/api/auth/session", bob.cookie);
  assert.equal(dead.status, 401, "the kicked session lands on sign-in");
  const stillAdmin = await call("/api/admin/policy", adminCookie);
  assert.equal(stillAdmin.status, 200, "the publishing admin's session survives");
});

test("a signed-in account with no publish yet reads the environment's bootstrap", async () => {
  // Bob has been reached by every publish above, so this only pins the shape
  // of the authenticated door itself: any signed-in account, not just an
  // admin, may read its own policy.
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200);
  const res = await call("/api/account/policy", bob.cookie);
  assert.equal(res.status, 200);
  const policy = (res.body as unknown as AccountPolicy).policy;
  assert.ok("defaults" in policy && "enforced" in policy && "changes" in policy);
});
