import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * Identities an administrator sets (ADR 0010): a person's through impersonation,
 * a group's as the installation's agent, and the lock that is the installation's
 * own record.
 *
 * Three invariants this file exists for, each of which fails if the mechanism
 * goes away:
 *
 *  - a person's identity list is the account's whole list, and the administrator
 *    can add to it, change it and take from it;
 *  - a group's identity is written as the **agent**, and a group the agent is not
 *    granted on is refused by name rather than written anyway;
 *  - the lock changes what the product *offers* — a session that reads it says
 *    so, and no session is ended to make it so — and it does not change what
 *    the server *permits*, which is ADR 0010 §5 stated as a test rather than as
 *    a sentence.
 */

const PORT = 18809;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-identity-admin";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";
const BOB_PASS = "bob-password";
const GROUP = "team@example.org";
const OTHER_GROUP = "sales@example.org";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");
const { parsePolicyDocumentDetailed, policyDocumentText } = await import(
  "./adminPolicy.js"
);
const { withIdentityLock } = await import("./identityAdmin.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

interface IdentityRow {
  id: string;
  name: string;
  email: string;
  replyTo: Array<{ name: string; email: string }> | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> | null; cookie: string }> {
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
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

async function login(username: string, password: string) {
  return call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

const post = (path: string, cookie: string, body: unknown) =>
  call(path, cookie, { method: "POST", body: JSON.stringify(body) });

let adminCookie = "";

before(async () => {
  const res = await login(ADMIN, ADMIN_PASS);
  assert.equal(res.status, 200, "admin login should succeed against the mock");
  adminCookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/* ------------------------------------------------------------------ */
/* The document                                                        */
/* ------------------------------------------------------------------ */

test("the lock list normalises, and an entry that is not an address is refused", () => {
  const ok = parsePolicyDocumentDetailed(
    JSON.stringify({ identities: { locked: [" Bob@Example.COM ", "bob@example.com"] } }),
  );
  assert.ok("doc" in ok, "a list of addresses is a valid document");
  assert.deepEqual(
    ok.doc.identities,
    { locked: ["bob@example.com"] },
    "lowercased, once",
  );

  const bad = parsePolicyDocumentDetailed(
    JSON.stringify({ identities: { locked: ["not-an-address"] } }),
  );
  assert.ok("problem" in bad, "a value that is not an address is refused at save time");
});

test("no locks and no identities key are the same document", () => {
  const empty = parsePolicyDocumentDetailed(
    JSON.stringify({ identities: { locked: [] } }),
  );
  assert.ok("doc" in empty);
  assert.equal(
    policyDocumentText(empty.doc).includes("identities"),
    false,
    "an empty list is written as no key at all",
  );
  const absent = parsePolicyDocumentDetailed("{}");
  assert.ok("doc" in absent);
  assert.equal(policyDocumentText(absent.doc), policyDocumentText(empty.doc));
});

test("the lock is added, kept single, and cleared to nothing", () => {
  const base = { defaults: {}, enforced: {}, changes: [] };
  const once = withIdentityLock(base, "Bob@Example.com", true);
  assert.deepEqual(once.identities, { locked: ["bob@example.com"] });
  const twice = withIdentityLock(once, "bob@example.com", true);
  assert.deepEqual(twice.identities, { locked: ["bob@example.com"] }, "named once, once");
  const other = withIdentityLock(twice, "amy@example.com", true);
  assert.deepEqual(other.identities, { locked: ["bob@example.com", "amy@example.com"] });
  const cleared = withIdentityLock(other, "bob@example.com", false);
  assert.deepEqual(cleared.identities, { locked: ["amy@example.com"] });
  assert.equal(
    "identities" in withIdentityLock(cleared, "amy@example.com", false),
    false,
    "clearing the last lock leaves no identities key",
  );
});

/* ------------------------------------------------------------------ */
/* A person's identities                                               */
/* ------------------------------------------------------------------ */

test("a person's identities are read, added to, changed and taken from", async () => {
  const read = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body?.impersonation, "ok", "the admin session may impersonate");
  assert.equal(read.body?.locked, false);
  const before = read.body?.identities as IdentityRow[];
  assert.ok(Array.isArray(before), "the account's whole list comes back");

  const created = await post("/api/admin/identities/user", adminCookie, {
    address: BOB,
    id: null,
    patch: { name: "Bob B", email: BOB, textSignature: "Bob" },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body?.id as string;
  assert.ok(id, "a created identity answers its id");

  const afterCreate = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  const rows = afterCreate.body?.identities as IdentityRow[];
  const mine = rows.find((r) => r.id === id);
  assert.ok(mine, "the new identity is in the account's list");
  assert.equal(mine.name, "Bob B");

  const updated = await post("/api/admin/identities/user", adminCookie, {
    address: BOB,
    id,
    patch: { name: "Robert B" },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const afterUpdate = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  const rowsAfter = (afterUpdate.body ?? {}) as { identities?: IdentityRow[] };
  const changed = (rowsAfter.identities ?? []).find((r) => r.id === id);
  assert.equal(changed?.name, "Robert B");
  assert.equal(changed?.email, BOB, "changing one field leaves the rest alone");

  const removed = await post("/api/admin/identities/user/delete", adminCookie, {
    address: BOB,
    id,
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const afterDelete = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  const rowsGone = (afterDelete.body ?? {}) as { identities?: IdentityRow[] };
  assert.equal(
    (rowsGone.identities ?? []).some((r) => r.id === id),
    false,
    "the identity is gone from the account's list",
  );
});

test("an identity longer than the server's cap is refused with the limit named", async () => {
  const res = await post("/api/admin/identities/user", adminCookie, {
    address: BOB,
    id: null,
    patch: { email: BOB, textSignature: "x".repeat(3000) },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, "signature_too_long");
  assert.match(String(res.body?.message), /2047/);
});

test("a non-admin reaches none of these surfaces", async () => {
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200);
  const read = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    bob.cookie,
  );
  assert.equal(read.status, 403);
});

/* ------------------------------------------------------------------ */
/* The lock                                                            */
/* ------------------------------------------------------------------ */

test("the lock reaches an open session, and ends none", async () => {
  // A session the account already holds, opened before the lock is written: the
  // invariant is that applying one ends nothing, so this cookie answers after.
  const before = await login(BOB, BOB_PASS);
  assert.equal(before.status, 200, JSON.stringify(before.body));

  const locked = await post("/api/admin/identities/user/lock", adminCookie, {
    address: BOB,
    locked: true,
  });
  assert.equal(locked.status, 200, JSON.stringify(locked.body));
  assert.equal(locked.body?.locked, true);

  const bob = await call("/api/auth/session?refresh=1", before.cookie);
  assert.equal(
    bob.status,
    200,
    "the lock does not end the account's session — no sign-out over a policy rule",
  );
  assert.equal(
    (bob.body?.gilbert as { identityLocked?: boolean } | undefined)?.identityLocked,
    true,
    "and the open session is what is told not to offer this account its Identities & signatures section",
  );

  // ADR 0010 §5, as a test: the lock is a rule about the surface. The account
  // can still write its own identity, and the administrator still can, because
  // Stalwart has no per-field permission here and this feature does not pretend
  // to be one.
  const write = await post("/api/admin/identities/user", adminCookie, {
    address: BOB,
    id: null,
    patch: { email: BOB, textSignature: "still writable" },
  });
  assert.equal(write.status, 200, "the lock does not refuse the write");

  const read = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  assert.equal(read.body?.locked, true, "and it is still recorded as locked");

  const released = await post("/api/admin/identities/user/lock", adminCookie, {
    address: BOB,
    locked: false,
  });
  assert.equal(released.status, 200);
  const after = await login(BOB, BOB_PASS);
  assert.equal(
    (after.body?.gilbert as { identityLocked?: boolean } | undefined)?.identityLocked,
    false,
  );
});

/* ------------------------------------------------------------------ */
/* A group's identity                                                  */
/* ------------------------------------------------------------------ */

test("a group's identity is read, and written as the installation's agent", async () => {
  const read = await call(
    `/api/admin/identities/group?name=${encodeURIComponent(GROUP)}`,
    adminCookie,
  );
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body?.granted, true, "the agent is granted on this group");
  const before = read.body?.identity as IdentityRow;
  assert.ok(before, "the group's own identity comes back");

  const saved = await post("/api/admin/identities/group", adminCookie, {
    name: GROUP,
    id: before.id,
    patch: { name: "Team", textSignature: "— Team" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(
    saved.body?.id,
    before.id,
    "a group holds one identity: this is an update",
  );

  const after = await call(
    `/api/admin/identities/group?name=${encodeURIComponent(GROUP)}`,
    adminCookie,
  );
  const rows = after.body?.identity as IdentityRow;
  assert.equal(rows.textSignature, "— Team");
  const listed = await call(
    `/api/admin/identities/group?name=${encodeURIComponent(GROUP)}`,
    adminCookie,
  );
  const listedAgain = (listed.body ?? {}) as { identity?: IdentityRow };
  assert.equal(
    listedAgain.identity?.id,
    before.id,
    "no second identity was created beside it",
  );
});

test("a group the agent is not granted on is refused by name", async () => {
  const read = await call(
    `/api/admin/identities/group?name=${encodeURIComponent(OTHER_GROUP)}`,
    adminCookie,
  );
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(
    read.body?.granted,
    false,
    "the surface is told, rather than shown an error",
  );
  assert.equal(read.body?.identity, null);

  const write = await post("/api/admin/identities/group", adminCookie, {
    name: OTHER_GROUP,
    id: null,
    patch: { email: OTHER_GROUP },
  });
  assert.equal(write.status, 409);
  assert.equal(write.body?.error, "group_not_granted");
  assert.match(String(write.body?.message), /agent is not a member/);
});

test("a malformed address is refused before any server is asked", async () => {
  const res = await call("/api/admin/identities/user?address=nonsense", adminCookie);
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, "invalid_address");
});
