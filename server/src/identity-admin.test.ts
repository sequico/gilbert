import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * Identities an administrator sets (ADR 0007): a person's through impersonation,
 * a group's as the installation's agent, and the lock that is a fact about that
 * one account, written into its own app folder (ADR 0001).
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
 *    the server *permits*, which is ADR 0007 stated as a test rather than as
 *    a sentence;
 *  - the lock is answered in three states and not two: an account whose file
 *    this session cannot reach says "unknown" rather than passing for free,
 *    because the record lives inside that account and a guess here reads as a
 *    fact to the administrator who has to act on it.
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
const { readDefaultIdentity, writeDefaultIdentity } = await import("./identityAdmin.js");
const { fetchUpstreamSession } = await import("./upstream.js");
const { findAppFileAt, readAppJsonAt, writeAppBytesAt, writeAppFile } = await import(
  "./appFolder.js"
);
const { JMAP_SUBMISSION } = await import("./jmap.js");

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

/**
 * Two principals' own JMAP sessions, for the default-identity tests below.
 *
 * The default is one key of the client's settings document, keyed by account
 * id, so the tests need the account id a session actually resolves — not a
 * literal that goes stale the day the mock renumbers.
 */
const BASE = `http://127.0.0.1:${PORT}`;
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const ADMIN_AUTH = basic(ADMIN, ADMIN_PASS);
const BOB_AUTH = basic(BOB, BOB_PASS);
const adminCtx = {
  authorization: ADMIN_AUTH,
  session: await fetchUpstreamSession(ADMIN_AUTH, BASE),
  username: ADMIN,
};
const bobCtx = {
  authorization: BOB_AUTH,
  session: await fetchUpstreamSession(BOB_AUTH, BASE),
  username: BOB,
};
const ADMIN_ACCOUNT = adminCtx.session.primaryAccounts?.[JMAP_SUBMISSION] ?? "";
const BOB_ACCOUNT = bobCtx.session.primaryAccounts?.[JMAP_SUBMISSION] ?? "";

before(async () => {
  const res = await login(ADMIN, ADMIN_PASS);
  assert.equal(res.status, 200, "admin login should succeed against the mock");
  adminCookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
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

  // ADR 0007, as a test: the lock is a rule about the surface. The account
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

/**
 * The lock answered as a fact about the account, and as "unknown" when the
 * account cannot be read.
 *
 * The two are different answers with different consequences — one tells an
 * administrator the account is free to send as itself, the other tells them
 * nothing has been read — and reading the second as the first is how an
 * account that *is* taken over is shown as one that is not.
 */
test("an account this session can read answers the lock, both ways", async () => {
  const free = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.equal(free.body?.impersonation, "ok");
  assert.equal(free.body?.locked, false, "no lock file is an answer, not a gap");
  assert.equal(
    free.body?.lockUnknownReason,
    null,
    "and nothing is said to have stopped a read that happened",
  );

  const applied = await post("/api/admin/identities/user/lock", adminCookie, {
    address: BOB,
    locked: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  const taken = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  assert.equal(taken.body?.locked, true, "the file says so, and so does the read");
  assert.equal(taken.body?.lockUnknownReason, null);

  const off = await post("/api/admin/identities/user/lock", adminCookie, {
    address: BOB,
    locked: false,
  });
  assert.equal(off.status, 200, JSON.stringify(off.body));
});

test("an account this session cannot impersonate answers unknown, never false", async () => {
  /*
   * An app-password session is the way Stalwart refuses impersonation, which is
   * exactly the state the lock file cannot be read from: the file is inside the
   * account's own app folder (ADR 0001).
   */
  const created = await call("/api/account/app-passwords", adminCookie, {
    method: "POST",
    body: JSON.stringify({ description: "identity-lock-read", current: ADMIN_PASS }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const viaApp = await login(ADMIN, created.body?.secret as string);
  assert.equal(viaApp.status, 200);

  const read = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    viaApp.cookie,
  );
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body?.impersonation, "denied");
  assert.equal(
    read.body?.locked,
    "unknown",
    "not false: an unreadable lock file is not an unlocked account",
  );
  assert.equal(
    read.body?.lockUnknownReason,
    "impersonation_denied",
    "and the reason is carried, not left for the reader to infer",
  );
});

test("releasing a lock that was never taken writes nothing", async () => {
  // BOB holds no lock file at this point: the release has nothing to remove, so
  // it answers the state the account is in rather than failing -- which is what
  // lets the surface offer Release to every account it can read.
  const { file } = await findAppFileAt(bobCtx, BOB_ACCOUNT, "identity-lock.json");
  assert.equal(file ?? null, null, "the test starts with no lock file to remove");

  const released = await post("/api/admin/identities/user/lock", adminCookie, {
    address: BOB,
    locked: false,
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body?.locked, false);

  const after = await findAppFileAt(bobCtx, BOB_ACCOUNT, "identity-lock.json");
  assert.equal(
    after.file ?? null,
    null,
    "and a release with nothing to release creates no file either",
  );
  const read = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  assert.equal(read.body?.locked, false, "the account is still free");
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

/* ------------------------------------------------------------------ */
/* The default sending identity (ADR 0007)                          */
/* ------------------------------------------------------------------ */

/**
 * The default is not a Stalwart property: it is one key of the client's own
 * settings document, `settings.json` in the account's app folder. These pin the
 * three facts that makes true — the document is the client's, the key is the
 * account's own, and a write leaves the rest of the document where it was —
 * plus the route that reaches them, so an administration that stops writing the
 * value the account reads fails here.
 */

test("an absent, unreadable or shapeless document is no default, not an error", async () => {
  assert.equal(
    await readDefaultIdentity(bobCtx, BOB_ACCOUNT),
    null,
    "a missing document is no default",
  );

  await writeAppBytesAt(
    bobCtx,
    BOB_ACCOUNT,
    "settings.json",
    new TextEncoder().encode("{not json"),
    "application/json",
  );
  assert.equal(
    await readDefaultIdentity(bobCtx, BOB_ACCOUNT),
    null,
    "a document that will not parse is no default",
  );

  await writeAppFile(bobCtx, BOB_ACCOUNT, "settings.json", {
    defaultIdentityByAccount: "i1",
  });
  assert.equal(
    await readDefaultIdentity(bobCtx, BOB_ACCOUNT),
    null,
    "a key that is not a map of accounts is no default",
  );

  await writeAppFile(bobCtx, BOB_ACCOUNT, "settings.json", ["not", "an", "object"]);
  assert.equal(
    await readDefaultIdentity(bobCtx, BOB_ACCOUNT),
    null,
    "a document that is not an object is no default",
  );

  await writeAppFile(bobCtx, BOB_ACCOUNT, "settings.json", {
    defaultIdentityByAccount: { [BOB_ACCOUNT]: "" },
  });
  assert.equal(
    await readDefaultIdentity(bobCtx, BOB_ACCOUNT),
    null,
    "an entry that names nothing is no default",
  );
});

test("the key is the account's own, and a write leaves the client's other keys alone", async () => {
  await writeAppFile(bobCtx, BOB_ACCOUNT, "settings.json", {
    theme: "dark",
    defaultIdentityByAccount: { [ADMIN_ACCOUNT]: "admin-identity" },
  });

  assert.equal(
    await readDefaultIdentity(bobCtx, BOB_ACCOUNT),
    null,
    "an entry for another account is not this account's default",
  );

  await writeDefaultIdentity(bobCtx, BOB_ACCOUNT, "bob-identity");

  const doc = (await readAppJsonAt(bobCtx, BOB_ACCOUNT, "settings.json")) as Record<
    string,
    unknown
  >;
  assert.equal(
    doc.theme,
    "dark",
    "the write is a read-modify-write: the client's own keys survive it",
  );
  assert.deepEqual(
    doc.defaultIdentityByAccount,
    { [ADMIN_ACCOUNT]: "admin-identity", [BOB_ACCOUNT]: "bob-identity" },
    "one document, one entry per account",
  );
  assert.equal(
    await readDefaultIdentity(bobCtx, BOB_ACCOUNT),
    "bob-identity",
    "the entry keyed by this account, not the one beside it",
  );
});

test("clearing the default removes that account's entry and leaves the others", async () => {
  await writeAppFile(bobCtx, BOB_ACCOUNT, "settings.json", {
    defaultIdentityByAccount: {
      [ADMIN_ACCOUNT]: "admin-identity",
      [BOB_ACCOUNT]: "bob-identity",
    },
  });

  await writeDefaultIdentity(bobCtx, BOB_ACCOUNT, null);

  assert.equal(await readDefaultIdentity(bobCtx, BOB_ACCOUNT), null);
  const doc = (await readAppJsonAt(bobCtx, BOB_ACCOUNT, "settings.json")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    doc.defaultIdentityByAccount,
    { [ADMIN_ACCOUNT]: "admin-identity" },
    "the account's entry is gone, which is the state the client falls back from",
  );
});

test("the administration sets and clears the default the account's own section reads", async () => {
  const created = await post("/api/admin/identities/user", adminCookie, {
    address: BOB,
    id: null,
    patch: { email: BOB, textSignature: "Default" },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body?.id as string;
  assert.ok(id, "a created identity answers its id");

  const set = await post("/api/admin/identities/user/default", adminCookie, {
    address: BOB,
    identityId: id,
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body?.identityId, id);

  const read = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  assert.equal(
    read.body?.defaultIdentityId,
    id,
    "the surface reads back the value it set",
  );

  const cleared = await post("/api/admin/identities/user/default", adminCookie, {
    address: BOB,
    identityId: null,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body?.identityId, null);
  const after = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(BOB)}`,
    adminCookie,
  );
  assert.equal(after.body?.defaultIdentityId, null, "and clearing it is a real state");
});

test("an app-password session cannot set a default: the refusal is impersonation_denied", async () => {
  // The same limit the other impersonating surfaces have: Stalwart refuses an
  // app-password session as an impersonator (ADR 0007), and the refusal
  // keeps its own code instead of reading as a failed write.
  const created = await call("/api/account/app-passwords", adminCookie, {
    method: "POST",
    body: JSON.stringify({ description: "identity-default", current: ADMIN_PASS }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const viaApp = await login(ADMIN, created.body?.secret as string);
  assert.equal(viaApp.status, 200);

  const refused = await post("/api/admin/identities/user/default", viaApp.cookie, {
    address: BOB,
    identityId: "anything",
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error, "impersonation_denied");
  assert.match(String(refused.body?.message), /app password/i);
});
