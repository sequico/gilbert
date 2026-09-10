import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The agent worker fleet's admin and member surfaces (ADR 0003), end to end
 * against the mock.
 *
 * Two fixtures carry the whole file. `team@example.org` is a group the demo
 * administrator is a member of, and the group's own documents are reachable
 * through their own session — which is the grant, exactly as it is for the
 * label catalog (ADR 0006). `legal@example.org` is a group they are not a
 * member of, and a non-member administrator has no act-as-the-group path at
 * all: the mock refuses impersonating a group mailbox the way a real 0.16
 * server does.
 *
 * The mock has no agent principal of its own, so the fleet's happy path (an
 * agent session that holds groups, workers that heartbeat, an app password
 * minted under impersonation) cannot be exercised here. What is exercised is
 * everything that must hold without one: the surfaces answer plainly instead
 * of guessing or failing, a deployment whose agent cannot be reached is
 * reported rather than invented, and every group write goes through
 * membership.
 */

const PORT = 18830;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-agent-admin";
process.env.LOGIN_RATE_LIMIT = "10000";
// The installation under test registers no agent: the tests that need an
// address set `config.agent` directly, because a module's configuration is
// read once and one test process has one of them.
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;
delete process.env.GILBERT_AGENTS_FILE;

const DEMO = "demo@example.com";
const TEAM = "team@example.org";
const LEGAL = "legal@example.org";

const mock = await import("./mock/index.js");
const { config } = await import("./config.js");
const { AGENT_AREAS, AGENT_TIERS } = await import("./agent/documents.js");
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

/** Register an agent address for one test; the password stays empty. */
function configureAgent(address: string): void {
  config.agent.address = address;
  config.agent.password = "";
}

/** The rule the tests save and read back. */
function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: "r1",
    version: 1,
    name: "Label processed mail",
    enabled: true,
    area: "mail",
    trigger: { on: "email" },
    tier: "T0",
    actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
    capabilities: ["keyword.add"],
    review: { mode: "threshold", threshold: 0.8 },
    ...overrides,
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

test("an installation with no agent says so plainly, and never 500s", async () => {
  configureAgent("");
  const res = await call("/api/admin/agents");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    configured: false,
    address: "",
    groups: [],
    workers: [],
    reason:
      "No agent is registered with this installation. Set GILBERT_AGENT_ADDRESS (and its app password) and restart to deploy one.",
  });
});

test("an agent that cannot be reached is reported, never guessed at", async () => {
  // The mock refuses to impersonate a group mailbox, exactly as a real 0.16
  // server does, so this is the unreachable-agent shape: an address that is
  // configured and cannot be opened.
  configureAgent(TEAM);
  const res = await call("/api/admin/agents");
  assert.equal(res.status, 200, "an unreachable agent is not a server failure");
  const body = res.body as {
    configured: boolean;
    address: string;
    groups: Array<{ name: string; granted: boolean }>;
    workers: unknown[];
    reason?: string;
  };
  assert.equal(body.configured, false);
  assert.equal(body.address, TEAM);
  assert.deepEqual(body.workers, []);
  const names = body.groups.map((g) => g.name);
  assert.ok(names.includes(TEAM), "the groups the directory lists are reported");
  assert.ok(names.includes(LEGAL));
  assert.ok(
    body.groups.every((g) => g.granted === false),
    "a grant is never asserted without the agent's own witness",
  );
  assert.match(body.reason ?? "", /could not be opened/);
});

test("providers: empty without an agent, refused when the agent is out of reach", async () => {
  configureAgent("");
  const none = await call("/api/admin/agent/providers");
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, { address: "", providers: {} });

  configureAgent(TEAM);
  const unreachable = await call("/api/admin/agent/providers");
  assert.equal(unreachable.status, 409);
  assert.equal((unreachable.body as { error: string }).error, "agent_unreachable");
  const posted = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({
      providers: { T1: { provider: "openai", model: "gpt-mini", baseUrl: "https://x" } },
    }),
  });
  assert.equal(posted.status, 409);
  assert.equal((posted.body as { error: string }).error, "agent_unreachable");
});

test("the app-password route refuses honestly and never invents a secret", async () => {
  configureAgent("");
  const none = await call("/api/admin/agent/app-password", { method: "POST" });
  assert.equal(none.status, 409);
  assert.equal((none.body as { error: string }).error, "agent_not_configured");
  assert.ok(!("secret" in (none.body ?? {})));

  configureAgent(TEAM);
  const unreachable = await call("/api/admin/agent/app-password", { method: "POST" });
  assert.equal(unreachable.status, 404);
  assert.equal((unreachable.body as { error: string }).error, "agent_not_found");
  assert.ok(!("secret" in (unreachable.body ?? {})));
});

test("a member administrator reads and saves a group's rules", async () => {
  configureAgent("");
  const before = await call(`/api/admin/groups/${TEAM}/agent`);
  assert.equal(before.status, 200);
  const initial = before.body as { granted: boolean; rules: unknown[]; audit: unknown[] };
  assert.equal(initial.granted, true);
  assert.deepEqual(initial.rules, []);
  assert.deepEqual(initial.audit, []);

  const empty = await call(`/api/admin/groups/${TEAM}/agent/rules`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { rules: [] });

  const saved = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule()] }),
  });
  assert.equal(saved.status, 200);
  const first = (saved.body as { rules: Array<Record<string, unknown>> }).rules[0]!;
  assert.equal(first.version, 1, "a new rule keeps the version it arrived with");
  assert.equal(first.updatedBy, DEMO, "the save names who made it");
  assert.equal(typeof first.updatedAt, "string");

  // The same content again: nothing changed, so no in-flight job is invalidated.
  const again = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule()] }),
  });
  assert.equal(again.status, 200);
  assert.equal(
    (again.body as { rules: Array<{ version: number }> }).rules[0]!.version,
    1,
  );

  // A real edit bumps it, which is what pins the running jobs' version.
  const edited = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ enabled: false })] }),
  });
  assert.equal(edited.status, 200);
  assert.equal(
    (edited.body as { rules: Array<{ version: number }> }).rules[0]!.version,
    2,
  );

  const stored = await call(`/api/admin/groups/${TEAM}/agent`);
  assert.equal(stored.status, 200);
  const view = stored.body as { rules: Array<{ id: string }>; schedule: unknown[] };
  assert.deepEqual(
    view.rules.map((r) => r.id),
    ["r1"],
    "the rule persisted in the group's own files",
  );
  assert.deepEqual(view.schedule, []);
});

test("a rule that could never run is refused with a readable message", async () => {
  configureAgent("");
  const notARule = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [{ v: 1, id: "half" }] }),
  });
  assert.equal(notARule.status, 400);
  assert.equal((notARule.body as { error: string }).error, "invalid_rule");
  assert.match((notARule.body as { message: string }).message, /#1/);

  const unrunnable = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({
      rules: [
        rule({
          id: "r2",
          name: "Move invoices",
          actions: [{ do: "mail.move", with: { mailbox: "work" } }],
          capabilities: [],
        }),
      ],
    }),
  });
  assert.equal(unrunnable.status, 400);
  const body = unrunnable.body as { error: string; message: string };
  assert.equal(body.error, "invalid_rule");
  assert.match(body.message, /capabilities/);
  assert.match(body.message, /Move invoices/);

  const duplicate = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ id: "dup" }), rule({ id: "dup" })] }),
  });
  assert.equal(duplicate.status, 400);
  assert.equal((duplicate.body as { error: string }).error, "duplicate_rule");
});

test("a group the admin is not a member of answers with the reason", async () => {
  configureAgent("");
  const view = await call(`/api/admin/groups/${LEGAL}/agent`);
  assert.equal(view.status, 200, "a missing membership is a state, not a failure");
  const body = view.body as {
    group: string;
    granted: boolean;
    reason: string;
    agentAddress: string;
    rules: unknown[];
    jobs: unknown[];
    decisions: unknown[];
    audit: unknown[];
    schedule: unknown[];
  };
  assert.equal(body.granted, false);
  assert.equal(body.group, LEGAL);
  assert.equal(body.agentAddress, "", "no agent is registered in this installation");
  assert.match(body.reason, /membership/);
  assert.deepEqual(
    [body.rules, body.jobs, body.decisions, body.audit, body.schedule],
    [[], [], [], [], []],
    "the surface answers one shape, empty when there is nothing to show",
  );

  for (const path of [
    `/api/admin/groups/${LEGAL}/agent/rules`,
    `/api/admin/groups/${LEGAL}/agent/labels`,
  ]) {
    const res = await call(
      path,
      path.endsWith("/rules") ? undefined : { method: "POST" },
    );
    assert.equal(res.status, 403);
    assert.equal((res.body as { error: string }).error, "group_not_accessible");
  }
  const save = await call(`/api/admin/groups/${LEGAL}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [] }),
  });
  assert.equal(save.status, 403);
});

test("the agent's reserved labels are added once, and existing labels survive", async () => {
  configureAgent("");
  const existing = { keyword: "urgent", name: "Urgent", color: "#d94f4f" };
  const seeded = await call(`/api/admin/groups/${TEAM}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [existing] }),
  });
  assert.equal(seeded.status, 200);

  const added = await call(`/api/admin/groups/${TEAM}/agent/labels`, { method: "POST" });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body, {
    ok: true,
    added: ["G-needattention", "G-processed", "G-awaiting", "G-rejected"],
  });

  const again = await call(`/api/admin/groups/${TEAM}/agent/labels`, { method: "POST" });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, added: [] }, "adding twice adds nothing");

  const catalog = await call(`/api/admin/groups/${TEAM}/labels`);
  assert.equal(catalog.status, 200);
  const keywords = (
    (catalog.body as { labels: Array<{ keyword: string }> }).labels ?? []
  ).map((l) => l.keyword);
  assert.equal(keywords[0], "urgent", "the group's own label was left alone");
  assert.equal(keywords.length, 5);
});

test("a member reads the group's agent surface, and never a provider", async () => {
  configureAgent("");
  // Self-contained: the member view has something to show because the group's
  // own account holds a rule, saved here through the admin surface.
  const seeded = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule()] }),
  });
  assert.equal(seeded.status, 200);
  // The member route is `requireSession` only: a member is not an administrator.
  const res = await call(`/api/agent/group/${TEAM}`);
  assert.equal(res.status, 200);
  const view = res.body as {
    group: string;
    granted: boolean;
    agentAddress: string;
    rules: Array<Record<string, unknown>>;
    jobs: unknown[];
    audit: unknown[];
  };
  assert.equal(view.group, TEAM);
  assert.equal(view.granted, true, "the group's own documents are the evidence");
  assert.equal(view.agentAddress, "", "no agent is registered in this installation");
  assert.deepEqual(view.jobs, []);
  assert.deepEqual(view.audit, []);
  assert.equal(view.rules.length, 1);
  assert.deepEqual(
    Object.keys(view.rules[0]!).sort(),
    ["area", "enabled", "id", "name", "tier", "trigger"],
    "the member view carries the rule's summary and nothing else",
  );
  assert.ok(!("providers" in view), "no provider configuration reaches a member");

  const stranger = await call(`/api/agent/group/${LEGAL}`);
  assert.equal(stranger.status, 403);
  assert.equal((stranger.body as { error: string }).error, "group_not_accessible");

  const anonymous = await app.request(`/api/agent/group/${TEAM}`);
  assert.equal(anonymous.status, 401, "the member route still needs a session");
});

test("the approvals queue is empty and needs no agent", async () => {
  configureAgent("");
  const res = await call("/api/admin/agent/approvals");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { approvals: [] });
});

test("the rule schema is published, and it is the catalogue the runtime reads", async () => {
  // ADR 0003 resolution 2: an automation is a JSON document validated against
  // a standard schema. This is that schema, reachable by the admin surface and
  // built from the same constants the executor enforces.
  configureAgent("");
  const res = await call("/api/admin/agent/rule-schema");
  assert.equal(res.status, 200);
  const schema = res.body as {
    $schema: string;
    properties: { area: { enum: string[] }; tier: { enum: string[] } };
    "x-actions": Array<{ name: string }>;
  };
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.properties.area.enum, [...AGENT_AREAS]);
  assert.deepEqual(schema.properties.tier.enum, [...AGENT_TIERS]);
  assert.ok(schema["x-actions"].some((action) => action.name === "mail.send"));
});

test("the rule schema needs the admin shield", async () => {
  const anonymous = await fetch(`http://127.0.0.1:${PORT}/api/admin/agent/rule-schema`, {
    headers: { "x-requested-with": "gilbert" },
  });
  assert.equal(anonymous.status, 401);
});

test("the save path refuses against the published schema, in the schema's words", async () => {
  // The editor and the server validate with the same document and the same
  // validator (resolution 16): a rule the form accepts cannot come back
  // rejected, and one it refuses is refused here in the same words.
  configureAgent("");
  const bad = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ area: "gardening" })] }),
  });
  assert.equal(bad.status, 400);
  const message = String((bad.body as { message?: string }).message ?? "");
  assert.match(message, /cannot run/, "the refusal names the automation");
  assert.match(message, /area|gardening/i, "and what the schema objected to");

  // The cross-field half is in the same list: an action outside the allowlist.
  const outside = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ capabilities: [] })] }),
  });
  assert.equal(outside.status, 400);
  assert.match(
    String((outside.body as { message?: string }).message ?? ""),
    /capabilities/,
  );
});
