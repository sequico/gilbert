import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The forced-password-change door (ADR 0004), end to end against the mock.
 *
 * The mock knows two principals: the demo user, an admin by default, and the
 * target principal (bob@example.com) whose account the admin acts on through
 * Stalwart 0.16 impersonation — composite username `{target}%{admin}` with
 * the admin's credentials. What is asserted here is the server's behaviour:
 * sign-in reads the directive and flags the session; the door answers 403 on
 * every data route while the directive exists; a successful password change
 * clears the directive and unblocks; app-password sessions are not gated; a
 * corrupt directive reads as absent.
 */

const PORT = 18790;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-forced-password-change";
// This file signs in the same two principals many times; every test request
// shares one address, so the per-address login ceiling would trip at ten.
process.env.LOGIN_RATE_LIMIT = "10000";

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";
const BOB_PASS = "bob-password";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

/** API call carrying an explicit cookie; returns status, body and any new cookie. */
async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: ReturnType<typeof JSON.parse>; cookie: string }> {
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
    body: text ? JSON.parse(text) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

async function login(
  username: string,
  password: string,
): Promise<{ status: number; body: ReturnType<typeof JSON.parse>; cookie: string }> {
  return call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

async function jmap(cookie: string): Promise<{
  status: number;
  body: ReturnType<typeof JSON.parse>;
}> {
  const res = await call("/api/jmap", cookie, {
    method: "POST",
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"],
      methodCalls: [
        ["FileNode/query", { accountId: "b1", filter: { isTopLevel: true } }, "q"],
      ],
    }),
  });
  return { status: res.status, body: res.body };
}

let adminCookie = "";

before(async () => {
  const res = await login(ADMIN, ADMIN_PASS);
  assert.equal(res.status, 200, "the admin should sign in against the mock");
  adminCookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("signing in without the directive is not forced (missing file = not forced)", async () => {
  const res = await login(BOB, BOB_PASS);
  assert.equal(res.status, 200);
  assert.equal(res.body.gilbert.mustChangePassword, false);
  const proxied = await jmap(res.cookie);
  assert.equal(proxied.status, 200, "the data path is open for a fresh account");
});

test("an admin sets the directive through impersonation", async () => {
  const res = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true });
});

test("a forced sign-in is flagged and every data route answers 403", async () => {
  const res = await login(BOB, BOB_PASS);
  assert.equal(res.status, 200);
  assert.equal(
    res.body.gilbert.mustChangePassword,
    true,
    "sign-in reads the directive and marks the session",
  );
  assert.equal(res.body.gilbert.isAdmin, false, "the target is not an admin");

  const proxied = await jmap(res.cookie);
  assert.equal(proxied.status, 403);
  assert.equal(proxied.body.error, "password_change_required");

  // Every data route is behind the same door: account state, uploads, blobs,
  // the calendar/image proxies and the push stream.
  for (const [path, init] of [
    ["/api/account/security", { method: "GET" }],
    ["/api/account/app-passwords", { method: "GET" }],
    ["/api/upload/b1", { method: "POST" }],
    ["/api/blob/b1/bogus/name.txt", { method: "GET" }],
    ["/api/image", { method: "GET" }],
    ["/api/ics", { method: "GET" }],
    ["/api/events", { method: "GET" }],
    // A route this build does not have is walled too: the door is the list of
    // what stays open, so a route added later is born behind it.
    ["/api/not-a-route-yet", { method: "GET" }],
  ] as const) {
    const r = await call(path, res.cookie, init);
    assert.equal(r.status, 403, `${path} should be gated`);
    assert.equal(r.body.error, "password_change_required", path);
  }

  // The routes the wall needs stay open.
  const session = await call("/api/auth/session", res.cookie, { method: "GET" });
  assert.equal(session.status, 200);
  assert.equal(session.body.gilbert.mustChangePassword, true);
  const config = await call("/api/config", "", { method: "GET" });
  assert.equal(config.status, 200);
});

test("changing the password clears the directive and unblocks the session", async () => {
  const res = await login(BOB, BOB_PASS);
  assert.equal(res.status, 200);
  assert.equal(res.body.gilbert.mustChangePassword, true);

  const changed = await call("/api/account/password", res.cookie, {
    method: "POST",
    body: JSON.stringify({ current: BOB_PASS, next: "bob-forced-new-1" }),
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  const proxied = await jmap(changed.cookie);
  assert.equal(proxied.status, 200, "the door is open after the change");
  const session = await call("/api/auth/session", changed.cookie, { method: "GET" });
  assert.equal(session.body.gilbert.mustChangePassword, false);
});

test("a user forced while signed in is stopped at their next request", async () => {
  const res = await login(BOB, "bob-forced-new-1");
  assert.equal(res.status, 200);
  assert.equal(res.body.gilbert.mustChangePassword, false);

  const forced = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB }),
  });
  assert.equal(forced.status, 200);

  const proxied = await jmap(res.cookie);
  assert.equal(proxied.status, 403, "the open session is stopped at its next request");
  assert.equal(proxied.body.error, "password_change_required");

  const cleared = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB, clear: true }),
  });
  assert.equal(cleared.status, 200);

  const again = await jmap(res.cookie);
  assert.equal(again.status, 200, "clearing the directive opens the door again");
  const session = await call("/api/auth/session", res.cookie, { method: "GET" });
  assert.equal(session.body.gilbert.mustChangePassword, false);
});

test("an admin clears the directive and a fresh sign-in is not forced", async () => {
  const forced = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB }),
  });
  assert.equal(forced.status, 200);
  const flagged = await login(BOB, "bob-forced-new-1");
  assert.equal(flagged.body.gilbert.mustChangePassword, true);

  const cleared = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB, clear: true }),
  });
  assert.equal(cleared.status, 200);

  const res = await login(BOB, "bob-forced-new-1");
  assert.equal(res.status, 200);
  assert.equal(res.body.gilbert.mustChangePassword, false);
});

test("an app-password sign-in is not gated", async () => {
  const res = await login(BOB, "bob-forced-new-1");
  assert.equal(res.status, 200);
  const created = await call("/api/account/app-passwords", res.cookie, {
    method: "POST",
    body: JSON.stringify({ description: "worker" }),
  });
  assert.equal(created.status, 200);
  const appSecret: string = created.body.secret;
  assert.ok(appSecret);

  // Force the account, then prove the wall applies to the password session
  // but not to the app-password session.
  const forced = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB }),
  });
  assert.equal(forced.status, 200);

  const plain = await login(BOB, "bob-forced-new-1");
  assert.equal(plain.body.gilbert.mustChangePassword, true, "password sign-in is gated");
  assert.equal((await jmap(plain.cookie)).status, 403);

  const viaApp = await login(BOB, appSecret);
  assert.equal(viaApp.status, 200);
  assert.equal(
    viaApp.body.gilbert.mustChangePassword,
    false,
    "an app-password session is not forced (ADR 0004)",
  );
  const proxied = await jmap(viaApp.cookie);
  assert.equal(proxied.status, 200, "the data path stays open for the app password");
  const security = await call("/api/account/security", viaApp.cookie, { method: "GET" });
  assert.equal(security.status, 200);

  await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB, clear: true }),
  });
});

test("a corrupt directive file reads as not forced", async () => {
  const forced = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB }),
  });
  assert.equal(forced.status, 200);

  // Corrupt the file the way any JMAP client of the account owner could: the
  // mock is a real 0.16-shaped server, so this goes straight at it with the
  // account's own credentials.
  const auth = `Basic ${Buffer.from(`${BOB}:bob-forced-new-1`).toString("base64")}`;
  const upload = await fetch(`http://127.0.0.1:${PORT}/jmap/upload/b1/`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "text/plain" },
    body: "this is not the directive document {",
  });
  assert.equal(upload.status, 200);
  const { blobId } = (await upload.json()) as { blobId: string };

  const query = await fetch(`http://127.0.0.1:${PORT}/jmap/`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"],
      methodCalls: [
        ["FileNode/query", { accountId: "b1", filter: { isTopLevel: true } }, "q"],
        [
          "FileNode/get",
          {
            accountId: "b1",
            "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" },
            properties: ["id", "name", "nodeType"],
          },
          "g",
        ],
      ],
    }),
  });
  const tree = (await query.json()) as {
    methodResponses: [string, Record<string, unknown>, string][];
  };
  const top = (
    tree.methodResponses.find((r) => r[2] === "g")![1] as {
      list?: unknown;
    }
  ).list as { id: string; name: string }[];
  const gilbert = top.find((n) => n.name === "gilbert");
  assert.ok(gilbert, "the app folder exists after the admin set");

  const childQuery = await fetch(`http://127.0.0.1:${PORT}/jmap/`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"],
      methodCalls: [
        ["FileNode/query", { accountId: "b1", filter: { parentId: gilbert!.id } }, "q"],
        [
          "FileNode/get",
          {
            accountId: "b1",
            "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" },
            properties: ["id", "name"],
          },
          "g",
        ],
      ],
    }),
  });
  const children = (await childQuery.json()) as {
    methodResponses: [string, Record<string, unknown>, string][];
  };
  const files = (
    children.methodResponses.find((r) => r[2] === "g")![1] as {
      list?: unknown;
    }
  ).list as { id: string; name: string }[];
  const directive = files.find((n) => n.name === "must-change-password.json");
  assert.ok(directive, "the directive file exists");

  const update = await fetch(`http://127.0.0.1:${PORT}/jmap/`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"],
      methodCalls: [
        [
          "FileNode/set",
          { accountId: "b1", update: { [directive!.id]: { blobId } } },
          "s",
        ],
      ],
    }),
  });
  assert.equal(update.status, 200);

  // A corrupt directive must not refuse sign-in: it reads as not forced and
  // the server logs loudly (ADR 0001).
  const res = await login(BOB, "bob-forced-new-1");
  assert.equal(res.status, 200);
  assert.equal(res.body.gilbert.mustChangePassword, false);
  assert.equal((await jmap(res.cookie)).status, 200);

  await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB, clear: true }),
  });
});

test("the admin surface needs a password session: app passwords cannot impersonate", async () => {
  // Give the admin an app password and sign in with it, the way a 2FA
  // account must.
  const created = await call("/api/account/app-passwords", adminCookie, {
    method: "POST",
    body: JSON.stringify({ description: "admin-worker" }),
  });
  assert.equal(created.status, 200);
  const appSecret: string = created.body.secret;
  const viaApp = await login(ADMIN, appSecret);
  assert.equal(viaApp.status, 200);
  assert.equal(
    viaApp.body.gilbert.isAdmin,
    true,
    "the app-password session is still an admin",
  );
  assert.equal(viaApp.body.gilbert.mustChangePassword, false);

  const refused = await call("/api/admin/force-password-change", viaApp.cookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB }),
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "forbidden");
  assert.match(refused.body.message, /app password/i);
});

test("the admin endpoints refuse a bad target with a clear error", async () => {
  const res = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: "nobody@example.com" }),
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "target_not_found");
});

test("a target whose name contains '%' or ':' is refused at the boundary", async () => {
  for (const target of ["bob%evil@example.com", "bob:port@example.com"]) {
    const res = await call("/api/admin/force-password-change", adminCookie, {
      method: "POST",
      body: JSON.stringify({ target }),
    });
    assert.equal(res.status, 400, `${target} must be refused with 400`);
    assert.equal(res.body.error, "bad_request");
  }
});

test("an account with two-factor authentication cannot be forced", async () => {
  // The guard reads the target's security state as the target would see it;
  // give the target a TOTP URL the way switching 2FA on would, then restore.
  const mockAny = mock as unknown as {
    targetAccount: { otpUrl: string | null };
  };
  mockAny.targetAccount.otpUrl =
    "otpauth://totp/bob@example.com?secret=JBSWY3DPEHPK3PXP&issuer=gilbert";
  try {
    const res = await call("/api/admin/force-password-change", adminCookie, {
      method: "POST",
      body: JSON.stringify({ target: BOB }),
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "account_has_two_factor");
  } finally {
    mockAny.targetAccount.otpUrl = null;
  }
  // With 2FA off again the same admin action succeeds, and clearing still
  // works regardless of the guard (clearing never reads security state).
  const set = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB }),
  });
  assert.equal(set.status, 200);
  const clear = await call("/api/admin/force-password-change", adminCookie, {
    method: "POST",
    body: JSON.stringify({ target: BOB, clear: true }),
  });
  assert.equal(clear.status, 200);
});
