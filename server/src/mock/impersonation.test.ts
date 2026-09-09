import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The mock's authentication surface for the impersonation paths (ADR 0005).
 *
 * Real 0.16 facts reproduced here, checked in stalwartlabs/stalwart source
 * (v0.16.21, 2026-09-07; re-verify against a live server with a dated comment
 * per repo convention): the composite username `{target}%{master}` splits at
 * the first `%`; a master identical to the target is not impersonation; the
 * master's credentials are what authenticate; app passwords are refused for
 * impersonation; and the impersonated session is the target's own.
 *
 * The mock knows two principals: the demo user (a Stalwart admin by
 * default: its permission list carries the admin marker and the
 * `impersonate` right, ADR 0007) and the target, bob@example.com.
 */

const PORT = 18791;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-mock-impersonation";

const DEMO = "demo@example.com";
const BOB = "bob@example.com";

const mock = await import("./index.js");
const BASE = `http://127.0.0.1:${PORT}`;

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function sessionDoc(
  authorization: string,
): Promise<{ status: number; body: ReturnType<typeof JSON.parse> }> {
  const res = await fetch(`${BASE}/.well-known/jmap`, {
    headers: { authorization },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function jmap(authorization: string, methodCalls: unknown[]) {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls,
    }),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  // A known app password on the demo account, the way x:AppPassword/set
  // would mint one.
  (
    mock as { account: { appPasswords: { id: string; secret: string }[] } }
  ).account.appPasswords.push({
    id: "ap-fixed",
    description: "fixture",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    secret: "$app$ap-fixed$fixture-secret",
  });
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the target signs in as themselves with their own password", async () => {
  const s = await sessionDoc(basic(BOB, "bob-password"));
  assert.equal(s.status, 200);
  assert.equal(s.body.username, BOB);
  assert.equal(
    s.body.accounts[s.body.primaryAccounts["urn:ietf:params:jmap:filenode"]].isPersonal,
    true,
  );
  // The target's session carries no group accounts: since ADR 0007 admin
  // state is a permission-list fact (`/api/account`), not a session fact.
  assert.equal(
    Object.values(s.body.accounts).some(
      (a) => (a as { name?: string }).name === "gilbert-admin@example.com",
    ),
    false,
  );
});

test("the composite username authenticates as the target with the master's credentials", async () => {
  const s = await sessionDoc(basic(`${BOB}%${DEMO}`, "demo-password"));
  assert.equal(s.status, 200);
  assert.equal(s.body.username, BOB, "the impersonated session is the target's own");
  assert.equal(
    s.body.primaryAccounts["urn:ietf:params:jmap:filenode"],
    "b1",
    "and names the target's own account",
  );
});

test("a composite naming an unknown target or master is refused", async () => {
  assert.equal(
    (await sessionDoc(basic(`nobody@example.com%${DEMO}`, "demo-password"))).status,
    401,
  );
  assert.equal(
    (await sessionDoc(basic(`${BOB}%nobody@example.com`, "demo-password"))).status,
    401,
  );
  assert.equal((await sessionDoc(basic(`${BOB}%${DEMO}`, "wrong-password"))).status, 401);
});

test("a master identical to the target is a plain login, not impersonation", async () => {
  // Stalwart drops the master when it equals the account (UsernameParts::new).
  const s = await sessionDoc(basic(`${DEMO}%${DEMO}`, "demo-password"));
  assert.equal(s.status, 200);
  assert.equal(s.body.username, DEMO);
  assert.equal(s.body.authType, undefined, "plain login, not an app password");
});

test("app passwords are refused for impersonation", async () => {
  const appSecret = "$app$ap-fixed$fixture-secret";
  // The secret is a valid credential for the demo user on its own...
  const direct = await sessionDoc(basic(DEMO, appSecret));
  assert.equal(direct.status, 200);
  assert.equal(
    direct.body.authType,
    "app-password",
    "the mock says how it authenticated",
  );
  // ...but refused as the master of a composite.
  const composite = await sessionDoc(basic(`${BOB}%${DEMO}`, appSecret));
  assert.equal(composite.status, 401);
});

test("registry state is the authenticating principal's own", async () => {
  const auth = basic(BOB, "bob-password");
  const before = await jmap(auth, [
    [
      "x:AccountPassword/set",
      {
        accountId: "b1",
        update: { singleton: { currentSecret: "bob-password", secret: "bob-switched" } },
      },
      "s",
    ],
  ]);
  assert.equal(before.status, 200);
  assert.equal(
    (await sessionDoc(basic(BOB, "bob-password"))).status,
    401,
    "the old password is dead",
  );
  assert.equal(
    (await sessionDoc(basic(BOB, "bob-switched"))).status,
    200,
    "the new password works",
  );
  assert.equal(
    (await sessionDoc(basic(DEMO, "demo-password"))).status,
    200,
    "the demo user's password was untouched",
  );
});
