import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort, jsonCall, postWith } from "./testkit.js";

/**
 * A group's knowledge base, written by its members (ADR 0020).
 *
 * The write is made with the member's own session, so the installation's agent
 * needs no grant on the group: here the Master is the mock's impersonation
 * target, a valid principal that holds no group at all, and a member still
 * creates a page, a folder and a draft in the group's KB. What must keep
 * failing is a write from outside the membership, and an approval from anybody
 * but an administrator. The suite runs with the caller a plain member
 * (`MOCK_ADMIN=0`), which is the case the rule exists for.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-knowledge-group";
process.env.LOGIN_RATE_LIMIT = "10000";
// The Master: a personal account, and no group in its session.
process.env.GILBERT_AGENT_ADDRESS = "bob@example.com";
process.env.GILBERT_AGENT_PASSWORD = "bob-password";
// A member first, an administrator nowhere.
process.env.MOCK_ADMIN = "0";

const DEMO = "demo@example.com";
/** A group the demo user is a member of (`server/src/mock`). */
const TEAM = "team@example.org";
/** A group the demo user is not a member of, and the Master neither. */
const DESIGN = "design@example.org";

const mock = await import("./mock/index.js");
const { createApp, useDurableSessions } = await import("./app.js");

await useDurableSessions(
  { read: async () => null, write: async () => {} },
  { ttlSeconds: 3600, rememberTtlSeconds: 86_400 },
);

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

const call = jsonCall(app, HEADERS);

const post = postWith(call);

/** A summary as the routes echo it. */
interface Summary {
  id: string;
  title: string;
  folder: string;
  nodeId: string;
  updated: { by: string; at: string } | null;
}

const summaryOf = (body: Record<string, unknown> | null): Summary => {
  const summary = body?.summary as Summary | undefined;
  assert.ok(summary, "the route answers with a summary");
  return summary;
};

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: "demo-password" }),
  });
  assert.equal(res.status, 200, "a member signs in against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a member creates a page and a folder in the group's KB, Master or not", async () => {
  const page = await post("/api/knowledge/create", {
    scope: "group",
    group: TEAM,
    title: "Loading rules",
  });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const created = summaryOf(page.body);
  assert.equal(created.title, "Loading rules");

  const folder = await post("/api/knowledge/folder", {
    scope: "group",
    group: TEAM,
    name: "Policies",
  });
  assert.equal(folder.status, 200, JSON.stringify(folder.body));
  assert.equal(summaryOf(folder.body).title, "Policies");
});

test("the draft records the member who last wrote it", async () => {
  const created = await post("/api/knowledge/create", {
    scope: "group",
    group: TEAM,
    title: "Draft ownership",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const folder = summaryOf(created.body).folder;

  const saved = await post("/api/knowledge/save", {
    scope: "group",
    group: TEAM,
    folder,
    input: { title: "Draft ownership", tags: [], blocks: [], text: "written by a member" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(summaryOf(saved.body).updated?.by, DEMO);
});

test("a member outside the group cannot write its KB", async () => {
  const refused = await post("/api/knowledge/folder", {
    scope: "group",
    group: DESIGN,
    name: "Not mine",
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body?.error, "group_not_accessible");
});

test("approval stays an administrator's", async () => {
  const created = await post("/api/knowledge/create", {
    scope: "group",
    group: TEAM,
    title: "Never approved",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const folder = summaryOf(created.body).folder;
  await post("/api/knowledge/save", {
    scope: "group",
    group: TEAM,
    folder,
    input: { title: "Never approved", tags: [], blocks: [], text: "waiting" },
  });
  const refused = await post("/api/knowledge/approve", {
    scope: "group",
    group: TEAM,
    folder,
    effectiveAt: new Date().toISOString(),
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});
