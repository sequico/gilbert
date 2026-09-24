import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { postWith } from "./testkit.js";

/**
 * The administrator's two phone surfaces (ADR 0023): an identity's SIP
 * credential, and the Global contacts directory.
 *
 * The credential is written into that account's own `sip.json` by impersonation
 * and read back keyed by the identity's email — the key both tiers assume. The
 * directory is written as the Master: the book is found or made, the universal
 * read share is re-applied from the principal enumeration, and the card is
 * created, checked against the book and destroyed. A write returning at all
 * proves the enumeration ran — it is the first thing that would refuse.
 *
 * Mock port: must not collide with any other test file — the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 19934;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-global-contacts";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

const DEMO = "demo@example.com";

const mock = await import("./mock/index.js");
const { createApp, useDurableSessions } = await import("./app.js");

await useDurableSessions(
  { read: async () => null, write: async () => {} },
  { ttlSeconds: 3600, rememberTtlSeconds: 86_400 },
);

const app = createApp();
let cookie = "";
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(path: string, init: RequestInit = {}) {
  const res = await app.request(path, {
    ...init,
    headers: {
      ...HEADERS,
      ...(init.headers as Record<string, string>),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

const post = postWith(call);

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: "demo-password" }),
  });
  assert.equal(res.status, 200, "the administrator signs in against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("an identity's SIP credential is written as them, and read back by email", async () => {
  const saved = await post("/api/admin/identities/user/sip", {
    address: DEMO,
    email: DEMO,
    sip: { address: "sip:1001@pbx.example.com", password: "a-secret" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const read = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(DEMO)}`,
  );
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const sip = (read.body as { sip?: Record<string, unknown> }).sip ?? {};
  assert.deepEqual(sip[DEMO], {
    address: "sip:1001@pbx.example.com",
    password: "a-secret",
  });

  // A credential for an address the account does not send as is refused: it
  // would be a key the phone never looks up.
  const orphan = await post("/api/admin/identities/user/sip", {
    address: DEMO,
    email: "nobody@example.com",
    sip: { address: "sip:9@pbx.example.com", password: "p" },
  });
  assert.equal(orphan.status, 404, JSON.stringify(orphan.body));

  // And a credential that is not a pair of strings is a bad request.
  const malformed = await post("/api/admin/identities/user/sip", {
    address: DEMO,
    email: DEMO,
    sip: { address: 42, password: "p" },
  });
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));

  // Clearing is allowed even for an address the account no longer holds.
  const cleared = await post("/api/admin/identities/user/sip", {
    address: DEMO,
    email: DEMO,
    sip: null,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const after = await call(
    `/api/admin/identities/user?address=${encodeURIComponent(DEMO)}`,
  );
  assert.equal(
    (after.body as { sip?: Record<string, unknown> }).sip?.[DEMO] ?? null,
    null,
    "the credential is gone",
  );
});

test("a Global contacts card is created, checked, and destroyed", async () => {
  const created = await post("/api/admin/global-contacts", {
    id: null,
    card: {
      name: "Grace Hopper",
      emails: ["grace@example.org"],
      phones: ["+1 555 0100"],
      organization: "US Navy",
      notes: "",
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = (created.body as { id?: unknown }).id;
  assert.equal(typeof id, "string", "the write answers the card's id");

  const gone = await post("/api/admin/global-contacts/delete", { id });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));

  const again = await post("/api/admin/global-contacts/delete", { id });
  assert.equal(again.status, 404, "a card that is not in the directory is a 404");

  const empty = await post("/api/admin/global-contacts", { id: null, card: {} });
  assert.equal(empty.status, 400, "a card that says nothing is refused");

  const noId = await post("/api/admin/global-contacts/delete", {});
  assert.equal(noId.status, 400, "which card is a question the caller must answer");
});
