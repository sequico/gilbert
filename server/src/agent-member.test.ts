import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The member's read of a group's agent, from a session that is not an
 * administrator (ADR 0003, "Members see, never change").
 *
 * Separate file on purpose — the mock reads MOCK_ADMIN at import, so the two
 * flag states need two processes — and this is the session every member of a
 * group actually has. The AI panel beside the group chat reads
 * `/api/agent/group/:name` with it, so the question this file answers is
 * whether that door opens for a member at all: the surfaces an administrator
 * edits are shut to this session, and reading the group's agent through one of
 * them would mean a member saw nothing.
 *
 * What this file does not do is write the group's documents. The member's route
 * is a read and has no write path, and the pen (the admin surface) is refused
 * for this session too. That a document's content reaches a member is exercised
 * in `agentAdmin.test.ts`, where the same `memberAgentView` runs on the same
 * membership rule with a session that is an administrator as well as a member —
 * the member route never asks which, so the two read the same thing.
 *
 * Mock port: must not collide with any other test file — the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 18847;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_ADMIN = "0";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-agent-member";
process.env.LOGIN_RATE_LIMIT = "10000";
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;
delete process.env.GILBERT_AGENTS_FILE;

const DEMO = "demo@example.com";
const TEAM = "team@example.org";
const LEGAL = "legal@example.org";

const mock = await import("./mock/index.js");
const { AGENT_INSTRUCTION_MAX } = await import("./agent/documents.js");
const { createApp } = await import("./app.js");

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

test("a member who is not an administrator reads the group's agent view", async () => {
  const res = await call(`/api/agent/group/${TEAM}`);
  assert.equal(
    res.status,
    200,
    "the member route needs a session on the group, not a role",
  );
  const view = res.body as {
    group: string;
    granted: boolean;
    agentAddress: string;
    rules: unknown[];
    instruction: unknown;
    jobs: unknown[];
    audit: unknown[];
  };
  assert.equal(view.group, TEAM);
  assert.equal(view.granted, false, "nothing has been written for this group yet");
  assert.equal(view.agentAddress, "", "no agent is registered in this installation");
  assert.deepEqual(view.rules, []);
  assert.deepEqual(view.jobs, []);
  assert.deepEqual(view.audit, []);
  // The instruction is on this path whatever the session's privileges are: an
  // empty text is the answer for a group that has none, not an absent field.
  assert.deepEqual(view.instruction, {
    text: "",
    updatedAt: null,
    updatedBy: null,
    max: AGENT_INSTRUCTION_MAX,
  });
  assert.ok(!("providers" in view), "no provider configuration reaches a member");
});

test("the agent surfaces an administrator edits are shut to this session", async () => {
  // Which is the whole reason the panel reads the member route: these answer a
  // member 403, and a panel wired to one of them would show nothing at all.
  for (const path of [
    "/api/admin/agents",
    `/api/admin/groups/${TEAM}/agent`,
    `/api/admin/groups/${TEAM}/agent/instruction`,
  ]) {
    const res = await call(path);
    assert.equal(res.status, 403, `${path} needs the admin marker`);
    assert.equal((res.body as { error: string }).error, "forbidden");
  }
});

test("a group this session is not a member of answers nothing", async () => {
  const res = await call(`/api/agent/group/${LEGAL}`);
  assert.equal(res.status, 403);
  const body = res.body as { error: string; need?: string; message?: unknown };
  assert.equal(body.error, "group_not_accessible");
  assert.equal(
    body.need,
    "agent documents",
    "the refusal names the section, not a sentence",
  );
  assert.ok(!("message" in body), "no sentence travels from the server");
  assert.ok(!("instruction" in body), "a refusal carries no document");
});

test("the member route still needs a session", async () => {
  const res = await app.request(`/api/agent/group/${TEAM}`, {
    headers: { "x-requested-with": "gilbert" },
  });
  assert.equal(res.status, 401);
});
