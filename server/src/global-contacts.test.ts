import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort, postWith } from "./testkit.js";

/**
 * The Global contacts directory (ADR 0023), as an administrator writes it.
 *
 * The directory is written as the Master: the book is found or made, and the
 * card is created, checked against the book and destroyed.
 */

const PORT = await freePort();
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

test("clearing an organisation or a note on an update erases it", async () => {
  /*
   * The editor clears a field by sending it empty, and the `/set` idiom for
   * removing a property is `null`. A field that falls back to `undefined` is
   * omitted from the patch, so the old value survives a save that visibly
   * emptied it.
   */
  const created = await post("/api/admin/global-contacts", {
    id: null,
    card: {
      name: "Hedy Lamarr",
      emails: [],
      phones: [],
      organization: "MGM",
      notes: "frequency hopping",
    },
  });
  const id = (created.body as { id?: unknown }).id;
  assert.equal(typeof id, "string", "the card is written");

  const updated = await post("/api/admin/global-contacts", {
    id,
    card: { name: "Hedy Lamarr", emails: [], phones: [], organization: "", notes: "" },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const read = await call("/api/global-contacts");
  const row = (
    (read.body?.contacts as
      | Array<{
          id: string;
          organization: string;
          notes: string;
        }>
      | undefined) ?? []
  ).find((c) => c.id === id);
  assert.ok(row, "the card is still listed");
  assert.equal(row.organization, "", "a cleared organisation is gone");
  assert.equal(row.notes, "", "a cleared note is gone");
});

test("every account reads the directory through the route", async () => {
  /*
   * ADR 0023's read path: the directory is owned by the Master, so no session
   * reaches its book — a member (here the signed-in administrator, whose
   * session does not hold the agent's account) reads it through
   * `GET /api/global-contacts`. A route that read the caller's own account
   * instead would answer nothing, so the seeded cards are the assertion.
   */
  const read = await call("/api/global-contacts");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const names = ((read.body?.contacts as Array<{ name: string }> | undefined) ?? []).map(
    (c) => c.name,
  );
  assert.ok(names.includes("Katherine Johnson"), "the directory's seeded cards are read");
  assert.ok(names.includes("Barbara Liskov"));

  // A card written through the administration route is read back at once.
  const created = await post("/api/admin/global-contacts", {
    id: null,
    card: {
      name: "Katherine Johnson",
      emails: ["katherine@example.org"],
      phones: [],
      organization: "",
      notes: "",
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const later = await call("/api/global-contacts");
  const rows = (later.body?.contacts as Array<{ name: string }> | undefined) ?? [];
  assert.ok(
    rows.some((c) => c.name === "Katherine Johnson"),
    "a card added through the route appears in the next read",
  );
});
