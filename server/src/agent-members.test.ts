import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * A group's roster, as the member door answers it (ADR 0005).
 *
 * The `@` picker beside the group chat offers the group's members and the
 * transcript greys a mention of somebody who is no longer one, so the chat asks
 * this door once per conversation. Two answers are pinned here: the roster when
 * the registry opens, and the `null` when it does not — a fallback the chat
 * reads, never a failure of it.
 *
 * The Master is configured in this file, which `agent-member.test.ts`
 * deliberately leaves unset: the roster is read as the installation, because a
 * member's own credential can never open `x:Account` (live on 0.16.21,
 * 2026-09-13 — `sysAccountGet` is not in the built-in user role).
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_ADMIN = "0";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-agent-members";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

const DEMO = "demo@example.com";
const TEAM = "team@example.org";
const BASE = `http://127.0.0.1:${PORT}`;

const mock = await import("./mock/index.js");
const { groupMembers } = await import("./agentAdmin.js");
const { createApp, useDurableSessions } = await import("./app.js");
const { fetchUpstreamSession } = await import("./upstream.js");

/*
 * This deployment names a Master, so sessions live in that account's own
 * document: an app is not built out of in-memory sessions for one (the guard
 * `createApp` applies). The store here is the smallest one that satisfies it —
 * what this file is about is the roster, not session durability.
 */
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

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: "demo-password" }),
  });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the roster is the group's members, and the reader is one of them", async () => {
  const res = await call(`/api/agent/group/${TEAM}/members`);
  assert.equal(res.status, 200, "a member may ask who is in their own group");
  const view = res.body as { group: string; members: string[] | null };
  assert.equal(view.group, TEAM, "the group is named the way every door names it");
  // The registry's own answer for this group: the member reading it, and the
  // agent granted on it. Nobody the registry does not list is a member — the
  // account that only shared something with the reader is not one.
  assert.deepEqual(view.members, [DEMO, mock.AGENT_ADDRESS].sort());
});

test("a registry that refuses is a null, not a failure", async () => {
  const agentAuth = `Basic ${Buffer.from(
    `${mock.AGENT_ADDRESS}:${mock.AGENT_PASS}`,
  ).toString("base64")}`;
  const ctx = {
    authorization: agentAuth,
    session: await fetchUpstreamSession(agentAuth, BASE),
    username: mock.AGENT_ADDRESS,
  };
  mock.accountRegistryGate.open = false;
  try {
    // Read straight from the door with a group id no other test asks about, so
    // the answer is this read's and not a cache's: the refused branch is
    // exercised without a second process carrying a second mock flag.
    assert.equal(
      await groupMembers(ctx, "a5"),
      null,
      "a method-level `forbidden` inside an HTTP 200 is the null the chat falls back from",
    );
  } finally {
    mock.accountRegistryGate.open = true;
  }
});
