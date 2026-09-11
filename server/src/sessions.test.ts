import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { deriveKey, open, seal, sha256 } from "./crypto.js";
import { RateLimiter } from "./ratelimit.js";
import { SessionStore } from "./sessions.js";
import { normalizeLocale } from "./upstream.js";

test("seal/open round-trips and rejects wrong key", () => {
  const salt = randomBytes(16);
  const k1 = deriveKey("cookie-secret", "app-secret", salt);
  const k2 = deriveKey("other", "app-secret", salt);
  const ct = seal("hello", k1);
  assert.equal(open(ct, k1), "hello");
  assert.equal(open(ct, k2), null);
  assert.equal(sha256("a"), sha256("a"));
});

test("session store creates, resolves, and refuses tampered cookies", () => {
  const store = new SessionStore("");
  const { cookie, session } = store.create({
    username: "u@example.com",
    password: "p4ss",
    remember: false,
    userAgent: "ua",
    ip: "127.0.0.1",
  });
  assert.equal(session.username, "u@example.com");
  const live = store.resolve(cookie);
  assert.ok(live);
  assert.equal(
    live!.authorization,
    `Basic ${Buffer.from("u@example.com:p4ss").toString("base64")}`,
  );
  assert.equal(store.resolve(`${cookie}x`), null);
  assert.equal(store.resolve("nope"), null);
  assert.equal(store.listForUser("u@example.com").length, 1);
  store.destroy(live!.id);
  assert.equal(store.resolve(cookie), null);
});

test("ending an account's sessions reaches the ones that typed the name differently", () => {
  /*
   * An account name is an address, and an address does not differ by case. The
   * lock an administrator applies (ADR 0007 §4) ends the account's sessions by
   * naming its address, and a session whose owner signed in as
   * `Bob@Example.com` holds the same account — an exact comparison would leave
   * exactly that session signed in, which is the one the lock was for.
   */
  const store = new SessionStore("");
  const first = store.create({
    username: "Bob@Example.com",
    password: "p4ss",
    remember: false,
    userAgent: "ua",
    ip: "127.0.0.1",
  });
  const second = store.create({
    username: "bob@example.com",
    password: "p4ss",
    remember: false,
    userAgent: "ua",
    ip: "127.0.0.1",
  });
  assert.equal(store.destroyAllForUser(" BOB@example.com ", first.session.id), 1);
  assert.equal(store.resolve(second.cookie), null, "the differently-cased one went");
  assert.ok(store.resolve(first.cookie), "the one that was excepted stayed");
});

test("persisted session data does not contain the password", () => {
  const store = new SessionStore("");
  store.create({
    username: "u",
    password: "super-secret-pw",
    remember: true,
    userAgent: "",
    ip: "",
  });
  const json = JSON.stringify(store.listForUser("u"));
  assert.ok(!json.includes("super-secret-pw"));
});

test("rate limiter blocks after max hits in window", () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), false);
  assert.ok(rl.retryAfterSeconds("k") > 0);
  rl.reset("k");
  assert.equal(rl.check("k"), true);
});

test("normalizes Stalwart account locales to BCP-47 tags", () => {
  assert.equal(normalizeLocale("de_DE"), "de-DE");
  assert.equal(normalizeLocale("de_DE.UTF-8"), "de-DE");
  assert.equal(normalizeLocale("ca_ES@valencia"), "ca-ES");
  assert.equal(normalizeLocale("sr_RS@latin"), "sr-Latn-RS");
  assert.equal(normalizeLocale("uz_UZ@cyrillic"), "uz-Cyrl-UZ");
  assert.equal(normalizeLocale("ru_RU@cyrillic"), "ru-RU");
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("POSIX"), null);
  assert.equal(normalizeLocale("C"), null);
  assert.equal(normalizeLocale(""), null);
  assert.equal(normalizeLocale(undefined), null);
  assert.equal(normalizeLocale({ locale: "de_DE" }), null);
  assert.equal(normalizeLocale("../etc/passwd"), null);
});
