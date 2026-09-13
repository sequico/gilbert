import assert from "node:assert/strict";
import { test } from "node:test";

process.env.APP_SECRET = "test-secret-for-sessions";

const { SESSION_DOCUMENT_VERSION, SessionStore } = await import("./sessions.js");

/**
 * Sessions outlive the process (ADR 0001, the installation's own document).
 *
 * A deployment is a container that may be replaced at any moment, so the one
 * durable thing a session can be is a document in the Master account's own
 * Stalwart storage — and this is the check that it really is: a session
 * created before a "restart" is resolved after it, the document holds no token
 * anybody could present, and an account's sessions end when they are told to.
 */

const TTLS = { ttlSeconds: 3600, rememberTtlSeconds: 86_400 };

/**
 * The account's own document, in memory: one read and one write, which is
 * exactly what the store is given in `app.ts` — `readAppFileAt` and
 * `writeAppFileAt` over the Master's app folder.
 */
function documentIo() {
  let text: string | null = null;
  return {
    read: async (): Promise<unknown | null> => (text === null ? null : JSON.parse(text)),
    write: async (value: unknown): Promise<void> => {
      text = JSON.stringify(value);
    },
    /** What a later boot over the same account would find. */
    stored: (): { version?: number; sessions?: unknown[] } | null =>
      text === null ? null : JSON.parse(text),
    /** Rewrite it by hand, the way another client of the account could. */
    replace: (value: unknown): void => {
      text = JSON.stringify(value);
    },
  };
}

const params = (username: string, remember = false) => ({
  username,
  password: `${username}-password`,
  remember,
  userAgent: "a test",
  ip: "127.0.0.1",
});

test("a session survives a restart: a new store over the same document resolves it", async () => {
  const io = documentIo();
  const before = new SessionStore(io, TTLS);
  await before.init();
  const { cookie, session } = before.create(params("ada@example.org"));
  await before.close();

  const after = new SessionStore(io, TTLS);
  await after.init();
  const resolved = after.resolve(cookie);
  assert.ok(resolved, "the session is there after the process it was created in is gone");
  assert.equal(resolved.username, "ada@example.org");
  assert.equal(
    resolved.id,
    session.id,
    "and it is the same session, by the same identity",
  );
  assert.equal(io.stored()?.version, SESSION_DOCUMENT_VERSION);
  await after.close();
});

test("a session with no document to live in is lost on a restart, and says so", async () => {
  const before = new SessionStore(undefined, TTLS);
  await before.init();
  const { cookie } = before.create(params("ada@example.org"));
  assert.ok(before.resolve(cookie), "in this process it resolves");
  await before.close();

  const after = new SessionStore(undefined, TTLS);
  await after.init();
  assert.equal(
    after.resolve(cookie),
    null,
    "and in the next one there is nothing to resolve",
  );
  await after.close();
});

test("a record past its expiry does not resolve", async () => {
  const io = documentIo();
  const before = new SessionStore(io, TTLS);
  await before.init();
  const { cookie } = before.create(params("ada@example.org", true));
  await before.close();

  // The clock moves past the record's own expiry, which is the only thing that
  // decides: nothing about the cookie changes.
  const stored = io.stored();
  assert.ok(stored?.sessions);
  io.replace({
    version: SESSION_DOCUMENT_VERSION,
    sessions: (stored.sessions as Array<Record<string, unknown>>).map((record) => ({
      ...record,
      expiresAt: Date.now() - 1000,
    })),
  });

  const after = new SessionStore(io, TTLS);
  await after.init();
  assert.equal(after.resolve(cookie), null, "an expired record is not a session");
  await after.close();
});

test("the document holds no token anybody could present", async () => {
  const io = documentIo();
  const store = new SessionStore(io, TTLS);
  await store.init();
  const first = store.create(params("ada@example.org"));
  /* A second session, so the document has two records to tell apart. */
  store.create(params("bob@example.org"));
  await store.close();

  const text = JSON.stringify(io.stored());
  const [id, secret] = first.cookie.split(".");
  assert.ok(
    !text.includes(id as string),
    "the id half of the cookie is not written down",
  );
  assert.ok(!text.includes(secret as string), "nor is the secret half");
  const records = io.stored()?.sessions as Array<{ idHash: string }>;
  assert.equal(records.length, 2);
  assert.notEqual(records[0]!.idHash, records[1]!.idHash, "two sessions are two records");
});

test("destroy ends one session, and destroyAllForUser leaves another account's alone", async () => {
  const io = documentIo();
  const store = new SessionStore(io, TTLS);
  await store.init();
  const ada = store.create(params("ada@example.org"));
  const bob = store.create(params("Bob@Example.org"));
  const bobElsewhere = store.create(params("bob@example.org"));

  store.destroy(ada.session.id);
  assert.equal(store.resolve(ada.cookie), null, "the destroyed one is gone");
  assert.ok(store.resolve(bob.cookie), "and the others are not");

  const ended = store.destroyAllForUser("BOB@example.org");
  assert.equal(ended, 2, "every session of that account, whoever typed the address how");
  assert.equal(store.resolve(bob.cookie), null);
  assert.equal(store.resolve(bobElsewhere.cookie), null);
  await store.close();

  const after = new SessionStore(io, TTLS);
  await after.init();
  assert.equal(
    after.resolve(bob.cookie),
    null,
    "and the ending is what the document holds",
  );
  await after.close();
});

test("reseal keeps the session and moves the credential behind it", async () => {
  const io = documentIo();
  const store = new SessionStore(io, TTLS);
  await store.init();
  const { cookie } = store.create(params("ada@example.org"));

  assert.equal(
    store.reseal(`${cookie}x`, "another-password"),
    false,
    "a wrong cookie is refused",
  );
  assert.equal(store.reseal(cookie, "another-password"), true);

  const resolved = store.resolve(cookie);
  assert.ok(resolved, "the same cookie is still the same session");
  const header = Buffer.from(
    resolved.authorization.slice("Basic ".length),
    "base64",
  ).toString("utf8");
  assert.ok(
    header.endsWith(":another-password"),
    "and it now carries the new credential",
  );
  await store.close();
});

test("a document that cannot be read is not overwritten by an empty store", async () => {
  const io = documentIo();
  const first = new SessionStore(io, TTLS);
  await first.init();
  const { cookie } = first.create(params("ada@example.org"));
  await first.close();

  let refuse = true;
  const unreadable = {
    read: async (): Promise<unknown | null> => {
      if (refuse) throw new Error("the account could not be read");
      return io.stored();
    },
    write: io.write,
  };
  const store = new SessionStore(unreadable, TTLS);
  await store.init();
  store.create(params("bob@example.org"));
  await store.close();
  assert.ok(io.stored()?.sessions, "the document is still what it was");

  refuse = false;
  const after = new SessionStore(io, TTLS);
  await after.init();
  assert.ok(after.resolve(cookie), "the session that was there is still there");
  await after.close();
});
