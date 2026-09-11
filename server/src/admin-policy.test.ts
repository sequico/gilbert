import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The installation-wide policy document (ADR 0001 §4, ADR 0004), end to end
 * against the mock: only admins read or publish it; an invalid document is
 * refused; a valid publish replaces the running copy at once (GET /api/config
 * answers it immediately) and kicks every other session so the next sign-in
 * applies the new policy at boot.
 */

const PORT = 18799;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-policy";
process.env.LOGIN_RATE_LIMIT = "10000";
// The installation under test names no agent: the tests that need one set
// `config.agent` directly, because a module's configuration is read once and
// one test process has one of them.
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";
const BOB_PASS = "bob-password";

type Body = Record<string, unknown>;

interface PolicyOnConfig {
  settingsPolicy: {
    defaults: Record<string, unknown>;
    enforced: Record<string, unknown>;
    changes: Array<{ version: string; settings: Record<string, unknown> }>;
  };
}

const mock = await import("./mock/index.js");
const { config } = await import("./config.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Body | null; cookie: string }> {
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
    body: text ? (JSON.parse(text) as Body) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

async function login(
  username: string,
  password: string,
): Promise<{ status: number; body: Body | null; cookie: string }> {
  return call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

let adminCookie = "";

before(async () => {
  const res = await login(ADMIN, ADMIN_PASS);
  assert.equal(res.status, 200, "admin login should succeed against the mock");
  adminCookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

const DOC = JSON.stringify(
  {
    defaults: { density: "cozy" },
    enforced: { readingPane: false },
    changes: [{ version: "v1", settings: { autoAdvance: false } }],
  },
  null,
  2,
);

/**
 * The agent record as the installation holds it.
 *
 * Parsed out of the policy document, which is the durable copy a restart
 * reloads. `GET /api/admin/agents` answers a different question — the agent's
 * live membership as Stalwart reports it — which is empty whenever no agent can
 * be opened, so it is the wrong witness for what was *saved*.
 */
function agentRecord(body: Body | null): Record<string, { areas?: string[] }> {
  const parsed = JSON.parse(String(body?.policy ?? "{}")) as {
    agent?: { groups?: Record<string, { areas?: string[] }> };
  };
  return parsed.agent?.groups ?? {};
}

test("a non-admin cannot read or publish the policy", async () => {
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200, "bob should be able to sign in");
  const read = await call("/api/admin/policy", bob.cookie);
  assert.equal(read.status, 403, "only an admin reads the policy");
  const write = await call("/api/admin/policy", bob.cookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(write.status, 403, "only an admin publishes the policy");
});

test("an admin reads the current policy as the editor document", async () => {
  const res = await call("/api/admin/policy", adminCookie);
  assert.equal(res.status, 200);
  const policy = JSON.parse((res.body as { policy: string }).policy) as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    Object.keys(policy).sort(),
    ["changes", "defaults", "enforced"],
    "the editor document has the three upstream sections",
  );
});

test("an invalid document is refused with a message that says what is wrong", async () => {
  const cases: Array<[string, string]> = [
    ["not json at all", "Not valid JSON"],
    [JSON.stringify([1, 2]), "must be a JSON object"],
    [JSON.stringify({ defaults: 3 }), '"defaults" must be an object'],
    [JSON.stringify({ enforced: "x" }), '"enforced" must be an object'],
    [
      JSON.stringify({
        changes: [
          { version: "v1", settings: { a: 1 } },
          { version: "v1", settings: { a: 2 } },
        ],
      }),
      'share the version "v1"',
    ],
    [JSON.stringify({ changes: [{ version: "", settings: {} }] }), 'has no "version"'],
    [JSON.stringify({ changes: "nope" }), '"changes" must be an array'],
  ];
  for (const [bad, expected] of cases) {
    const res = await call("/api/admin/policy", adminCookie, {
      method: "POST",
      body: bad,
    });
    assert.equal(res.status, 400, `should refuse: ${bad.slice(0, 60)}`);
    const message = (res.body as { message: string }).message;
    assert.ok(
      message.includes(expected),
      `message should say: ${expected} — got: ${message}`,
    );
  }
  const config = await call("/api/config", "");
  const enforced = (config.body as unknown as PolicyOnConfig).settingsPolicy.enforced;
  assert.equal(
    Object.keys(enforced).length,
    0,
    "no invalid publish reached the running policy",
  );
});

test("a valid publish replaces the running policy at once", async () => {
  const res = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(res.status, 200);
  assert.equal((res.body as { ok: boolean }).ok, true);
  // Unauthenticated /api/config answers the new policy immediately.
  const config = await call("/api/config", "");
  const sp = (config.body as unknown as PolicyOnConfig).settingsPolicy;
  assert.equal(sp.enforced.readingPane, false);
  assert.equal(sp.defaults.density, "cozy");
  assert.equal(sp.changes[0]!.version, "v1");
});

test("publishing kicks every session except the caller's", async () => {
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200);
  const alive = await call("/api/auth/session", bob.cookie);
  assert.equal(alive.status, 200, "bob's session is alive before the publish");
  const res = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(res.status, 200);
  assert.ok((res.body as { kicked: number }).kicked >= 1, "other sessions were kicked");
  const dead = await call("/api/auth/session", bob.cookie);
  assert.equal(dead.status, 401, "the kicked session lands on sign-in");
  const stillAdmin = await call("/api/admin/policy", adminCookie);
  assert.equal(stillAdmin.status, 200, "the publishing admin's session survives");
});

/**
 * What the document still owns about the agent (ADR 0009): the areas each group
 * is narrowed to, and nothing about who the agent is. Its address and its
 * credential are the deployment's — `GILBERT_AGENT_ADDRESS` beside
 * `GILBERT_AGENT_PASSWORD`, in the environment that starts the process — so
 * there is no address here to disagree with them and none to clear.
 */
test("a group name that is not an address is refused, and nothing is written", async () => {
  config.agent.address = "aider@example.com";
  const before = await call("/api/admin/policy", adminCookie);
  const refused = await call("/api/admin/agent/groups", adminCookie, {
    method: "POST",
    body: JSON.stringify({ groups: { "not-a-group": { areas: ["mail"] } } }),
  });
  assert.equal(refused.status, 400);
  assert.equal((refused.body as { error?: string }).error, "bad_request");
  const after = await call("/api/admin/policy", adminCookie);
  assert.equal(after.body?.policy, before.body?.policy, "the document is unchanged");
});

test("a non-admin cannot narrow a group either", async () => {
  const bob = await login(BOB, BOB_PASS);
  const res = await call("/api/admin/agent/groups", bob.cookie, {
    method: "POST",
    body: JSON.stringify({ groups: { "team@example.org": { areas: ["mail"] } } }),
  });
  assert.notEqual(res.status, 200);
});

/**
 * What the worker does in each group (ADR 0009): areas, several groups at a
 * time, and only downward — the record can take work away from a group, never
 * hand it work the deployment did not open.
 */
test("groups are narrowed several at a time, and nothing can widen the deployment", async () => {
  config.agent.address = "aider@example.com";
  const saved = await call("/api/admin/agent/groups", adminCookie, {
    method: "POST",
    body: JSON.stringify({
      groups: {
        "team@example.org": { areas: ["mail"] },
        "legal@example.org": { areas: ["mail", "files"] },
      },
    }),
  });
  assert.equal(saved.status, 200, "two groups in one request");

  const status = await call("/api/admin/policy", adminCookie);
  const groups = agentRecord(status.body);
  assert.deepEqual(groups["team@example.org"]?.areas, ["mail"], "one group narrowed to mail");
  assert.deepEqual(
    groups["legal@example.org"]?.areas,
    ["mail", "files"],
    "and another to two areas, in the same call",
  );

  // An area this build does not know is refused, and the record is unchanged.
  const refused = await call("/api/admin/agent/groups", adminCookie, {
    method: "POST",
    body: JSON.stringify({ groups: { "team@example.org": { areas: ["nope"] } } }),
  });
  assert.equal(refused.status, 400);
  const after = await call("/api/admin/policy", adminCookie);
  assert.deepEqual(
    agentRecord(after.body)["team@example.org"]?.areas,
    ["mail"],
    "a refused save changes nothing",
  );

  // An empty list is how "as the deployment serves it" is written down.
  await call("/api/admin/agent/groups", adminCookie, {
    method: "POST",
    body: JSON.stringify({ groups: { "team@example.org": { areas: [] } } }),
  });
  const cleared = await call("/api/admin/policy", adminCookie);
  assert.equal(
    agentRecord(cleared.body)["team@example.org"]?.areas,
    undefined,
    "cleared means the deployment speaks again",
  );

  // The narrowing is a durable fact about the installation, not a process's
  // memory: it sits in the policy document the editor reads, and survives a
  // restart with it.
  const policy = await call("/api/admin/policy", adminCookie);
  assert.match(String(policy.body?.policy ?? ""), /legal@example\.org/);
});

test("there is nothing to narrow before an agent is named", async () => {
  config.agent.address = "";
  const refused = await call("/api/admin/agent/groups", adminCookie, {
    method: "POST",
    body: JSON.stringify({ groups: { "team@example.org": { areas: ["mail"] } } }),
  });
  assert.equal(refused.status, 409);
  assert.equal((refused.body as { error?: string }).error, "agent_not_configured");
});

/**
 * The ceiling, at the door where a widening would be written down (ADR 0009).
 *
 * `servedAreasFor` is what *enforces* narrowing in the worker, but a record
 * could still have been written claiming an area the deployment does not serve
 * — and a record that says something nobody serves is a lie an operator would
 * read as a setting. It is refused where it would be saved, in the deployment's
 * own words.
 */
test("a group can be narrowed inside what the deployment serves, never outside it", async () => {
  config.agent.address = "aider@example.com";
  const served = [...config.agent.areas];
  config.agent.areas = ["mail"];
  try {
    const refused = await call("/api/admin/agent/groups", adminCookie, {
      method: "POST",
      body: JSON.stringify({
        groups: { "team@example.org": { areas: ["mail", "files"] } },
      }),
    });
    assert.equal(refused.status, 400);
    assert.match(
      String((refused.body as { message?: string }).message ?? ""),
      /does not serve files/,
      "the refusal names what the deployment serves",
    );
    const reached = await call("/api/admin/policy", adminCookie);
    assert.equal(
      agentRecord(reached.body)["team@example.org"]?.areas,
      undefined,
      "and nothing was written",
    );

    const narrowed = await call("/api/admin/agent/groups", adminCookie, {
      method: "POST",
      body: JSON.stringify({ groups: { "team@example.org": { areas: ["mail"] } } }),
    });
    assert.equal(narrowed.status, 200, "inside the deployment is accepted");
  } finally {
    config.agent.areas = served;
  }
  // Left as it was found, for whatever the process does next.
  config.agent.address = "";
});
