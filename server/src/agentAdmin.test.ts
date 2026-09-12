import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

/**
 * The agent fleet's admin and member surfaces (ADR 0003), end to end against
 * the mock.
 *
 * The group surfaces have one door: they are reached **as the installation's
 * agent**, the principal that holds a group's documents and executes them, so
 * what they require is the agent's grant and not the administrator's own
 * membership. Three fixtures carry the file. `team@example.org` is a group both
 * the demo administrator and the agent hold; `design@example.org` is the
 * agent's own group, which the demo is not a member of and still administers
 * through the agent's grant; `legal@example.org` is a group neither holds, and
 * the mock refuses impersonating a group mailbox the way a real 0.16 server
 * does — which is why the documents are reached as the agent and never by
 * acting as the group.
 *
 * The mock holds an agent principal (`AGENT_ADDRESS`, default
 * `gilbert@example.com`) that an administrator may impersonate, which is what
 * puts the fleet's happy path in reach: a credential provisioned under
 * impersonation, and a sign-in as the agent proving it works. The surfaces that
 * have to answer without one are exercised too: a deployment whose agent cannot
 * be reached, and one that names none at all, are reported rather than invented.
 */

const PORT = 18830;
process.env.MOCK_PORT = String(PORT);
// The stub model these suites call lives on loopback: the deployment says so,
// which is the operator's statement and never a document's.
process.env.GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER = "1";
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

const DEMO = "demo@example.com";
const TEAM = "team@example.org";
const DESIGN = "design@example.org";
const LEGAL = "legal@example.org";
const BASE = `http://127.0.0.1:${PORT}`;

const mock = await import("./mock/index.js");
const { config } = await import("./config.js");
const { AGENT_INSTRUCTION_MAX, AGENT_NOTES_MAX } = await import("./agent/documents.js");
const { AGENT_CHAIN_HOPS_CEILING, AGENT_PAGES_CEILING } = await import(
  "./agent/documents.js"
);
const { createApp } = await import("./app.js");
const { fetchUpstreamSession } = await import("./upstream.js");
const { filesAccountId, writeAppFile } = await import("./appFolder.js");
const { AgentStore } = await import("./agent/store.js");
const { monthOf } = await import("./agent/documents.js");

/**
 * The stub model the reading is asked of: a loopback address is exactly what
 * the admin route refuses, so a reading's own call is exercised against this.
 */
const READING_PORT = 18839;
let readingAnswer = "";
const readingStub = createServer((req, res) => {
  void (async () => {
    for await (const _ of req) {
      /* the request body is read and dropped: what this stub answers is fixed */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: readingAnswer } }] }));
  })();
});
const { EMPTY_METER } = await import("./agent/documents.js");

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

/**
 * Stage the deployment's agent for one test (ADR 0003).
 *
 * The address and the credential are the installation's, not a document's: both
 * are read from the environment once, at boot, so a test that needs a different
 * pair sets the same two fields. The pair is also what decides whether the agent
 * can be reached at all — a password means signing in as the agent, no password
 * means the administrator's own session is used to reach it.
 */
function configureAgent(address: string, password = ""): void {
  config.agent.address = address;
  config.agent.password = password;
}

/**
 * Fail the agent's own sign-in, and hand back the way to put the real `fetch`
 * back.
 *
 * Signing in is the one call the agent makes that carries no JMAP body — it is
 * a GET on the well-known URL — so no request-body match can reach it. The
 * request is recognised by the credential it carries, and only the agent's own
 * pair is failed, so a session fetched for anybody else goes through untouched.
 */
function failAgentSignIn(status: number): () => void {
  const credential = `Basic ${Buffer.from(
    `${mock.AGENT_ADDRESS}:${mock.AGENT_PASS}`,
  ).toString("base64")}`;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (url.includes("/.well-known/") && headers.get("authorization") === credential) {
      return new Response("{}", { status });
    }
    return real(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** The rule the tests save and read back. */
function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: "r1",
    version: 1,
    name: "Label processed mail",
    enabled: true,
    trigger: { on: "email" },
    capabilities: ["keyword.add"],
    instruction: "Label the messages this automation was written for.",
    review: { mode: "threshold", threshold: 0.8 },
    ...overrides,
  };
}

before(async () => {
  await new Promise<void>((resolve) =>
    readingStub.listen(READING_PORT, "127.0.0.1", resolve),
  );
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: "demo-password" }),
  });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  readingStub.close();
  (mock as { server?: { close(): void } }).server?.close();
});

/**
 * The two halves of one defect: an administrative write into the agent's own
 * account carries a compare-and-set token, and that token is the account's
 * **whole** FileNode state, not the document's (ADR 0003 §6).
 *
 * It is therefore stale for two reasons that have nothing to do with the
 * document being written. The first save creates the folder tree, and creating
 * a folder moves the state — so the first save of all loses its own
 * compare-and-set. And the agent's own worker writes its heartbeat and its
 * audit in that same account every 30 s, so on a running installation the state
 * moves from under a save that happens to overlap. Either way the administrator
 * is shown Stalwart's raw refusal — `stateMismatch`, "An ifInState argument was
 * supplied, but it does not match the current state" — instead of a saved
 * provider.
 *
 * These are the file's first tests because the account has to be untouched for
 * the first of them to exercise the create path.
 */
test("a group's memory is read, written, and bounded where the document says", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  const empty = await call(`/api/admin/groups/${TEAM}/agent/notebook`);
  assert.equal(empty.status, 200);
  assert.deepEqual((empty.body as { facts: unknown[] }).facts, []);

  const saved = await call(`/api/admin/groups/${TEAM}/agent/notebook`, {
    method: "POST",
    body: JSON.stringify({ facts: [{ text: "The group works in Italian." }] }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const view = saved.body as {
    facts: Array<{ id: string; text: string; addedBy?: string }>;
    updatedBy: string | null;
  };
  assert.equal(view.facts.length, 1);
  assert.ok(view.facts[0]?.id, "the server gives a fact that arrives without one its id");
  assert.equal(view.facts[0]?.text, "The group works in Italian.");
  assert.equal(view.updatedBy, "demo@example.com");

  const tooLong = await call(`/api/admin/groups/${TEAM}/agent/notebook`, {
    method: "POST",
    body: JSON.stringify({ facts: [{ text: "x".repeat(600) }] }),
  });
  assert.equal(tooLong.status, 400);
  assert.equal((tooLong.body as { error: string }).error, "notebook_fact_too_long");
});

test("the ceiling on an answer is the installation's to set, and a bad one is refused", async () => {
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);
  const saved = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({ maxOutputTokens: 512 }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = await call("/api/admin/agent/providers");
  assert.equal((read.body as { maxOutputTokens: number }).maxOutputTokens, 512);

  const tooHigh = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({ maxOutputTokens: 999_999 }),
  });
  assert.equal(tooHigh.status, 400);
  assert.equal((tooHigh.body as { error: string }).error, "max_output_tokens_invalid");
});

test("the first save of the model creates the folders and the document in one go", async () => {
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);
  const saved = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({
      provider: {
        provider: "openai",
        model: "gpt-mini",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
      },
    }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const read = await call("/api/admin/agent/providers");
  assert.equal(read.status, 200);
  const provider = (
    read.body as { provider: { model?: string; hasKey?: boolean } | null }
  ).provider;
  assert.equal(provider?.model, "gpt-mini");
  assert.equal(provider?.hasKey, true, "the key was stored, and is not handed back");
});

test("a save that loses the account-wide compare-and-set is retried, not shown", async () => {
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);

  const agentAuth = `Basic ${Buffer.from(
    `${mock.AGENT_ADDRESS}:${mock.AGENT_PASS}`,
  ).toString("base64")}`;
  const agentCtx = {
    authorization: agentAuth,
    session: await fetchUpstreamSession(agentAuth, BASE),
    username: mock.AGENT_ADDRESS,
  };
  const agentAccount = filesAccountId(agentCtx);

  /*
   * A foreign write into the same account, landed between the read of the state
   * and the conditional write: exactly what the worker's heartbeat does to a
   * running installation. It is injected once, so the retry the fix owes has a
   * clear account to write into.
   */
  let injected = false;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (!injected && body.includes("FileNode/query")) {
      injected = true;
      const res = await real(input, init);
      await writeAppFile(agentCtx, agentAccount, "probe.json", { v: 1 });
      return res;
    }
    return real(input, init);
  }) as typeof fetch;

  let saved: Awaited<ReturnType<typeof call>>;
  try {
    saved = await call("/api/admin/agent/providers", {
      method: "POST",
      body: JSON.stringify({
        provider: {
          provider: "anthropic",
          model: "claude-small",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "sk-ant-test",
        },
      }),
    });
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(injected, "the foreign write landed after the state was read");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const read = await call("/api/admin/agent/providers");
  const provider = (read.body as { provider: { model?: string } | null }).provider;
  assert.equal(provider?.model, "claude-small", "the model this save named landed");
});

test("an installation with no agent says so plainly, and never 500s", async () => {
  configureAgent("");
  const res = await call("/api/admin/agents");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    operational: false,
    address: "",
    groups: [],
    // No group was walked, so there is no use to report: the reason below says
    // why, and a fleet that is not running spent nothing.
    meter: { total: EMPTY_METER, byAgent: [], unreadable: [] },
    workers: [],
    // No worker has reported a grant lost, because no worker is serving this
    // installation (ADR 0003 resolution 21).
    withdrawals: [],
    // A code, not a sentence: the surface composes the sentence in the
    // reader's language (the same rule the membership refusal follows). Both
    // halves of the pair belong to the deployment — no address and no password
    // — and they are one state an operator fixes, so they are one code.
    reason: { code: "agent_not_configured" },
  });
});

test("an agent that cannot be reached is reported, never guessed at", async () => {
  // The pair is present and the server will not answer it. That is neither the
  // deployment's missing pair nor a refusal of the key — those are separate
  // states, named separately — but a door that does not open. The fleet says
  // so, instead of handing back the empty membership as if it were the truth
  // about who the agent is.
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);
  const broken = failAgentSignIn(500);
  let res: Awaited<ReturnType<typeof call>>;
  try {
    res = await call("/api/admin/agents");
  } finally {
    broken();
  }
  assert.equal(res.status, 200, "an unreachable agent is not a server failure");
  const body = res.body as {
    operational: boolean;
    address: string;
    groups: unknown[];
    workers: unknown[];
    reason?: { code?: string; detail?: string };
  };
  assert.equal(body.operational, false);
  assert.equal(body.address, mock.AGENT_ADDRESS);
  assert.deepEqual(body.workers, []);
  assert.deepEqual(
    body.groups,
    [],
    "membership is the agent's own witness: with no session there is nothing to report",
  );
  // The reason travels as a code and whatever the server that refused said:
  // the sentence a person reads is composed where it is read.
  assert.equal(body.reason?.code, "agent_unreachable");
  assert.ok(
    typeof body.reason?.detail === "string" && body.reason.detail.length > 0,
    "the upstream diagnostic travels beside the code",
  );
  assert.ok(
    !("message" in (body.reason ?? {})),
    "the reason is a code, never a sentence of the server's",
  );
});

test("a credential the server refuses is its own state, named as one", async () => {
  // The password is the account's own (ADR 0003). A deployment carrying the
  // wrong one is refused when it signs in, and that is a different thing to fix
  // from an account that cannot be opened at all: one is a bad copy, the other
  // is a door that does not open.
  configureAgent(mock.AGENT_ADDRESS, "not-the-password");
  const res = await call("/api/admin/agents");
  assert.equal(res.status, 200);
  const body = res.body as {
    operational: boolean;
    groups: unknown[];
    reason?: { code?: string; detail?: string };
  };
  assert.equal(body.operational, false, "a refused key is not a working fleet");
  assert.deepEqual(body.groups, []);
  assert.equal(body.reason?.code, "agent_credentials_rejected");
  assert.match(
    String(body.reason?.detail ?? ""),
    /refused/,
    "and the deployment's own words say what was refused",
  );
});

test("a deployment carrying the account's own password is operational", async () => {
  // The happy path, and the only one that shows membership at all: the agent
  // signs in as itself, and the groups it is in are the ones its session hands
  // it (ADR 0003 §2). No record of ours is consulted, so there is nothing to
  // keep in step.
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);
  const res = await call("/api/admin/agents");
  assert.equal(res.status, 200);
  const body = res.body as {
    operational: boolean;
    address: string;
    groups: Array<{ name: string }>;
  };
  assert.equal(body.operational, true);
  assert.equal(body.address, mock.AGENT_ADDRESS);
  assert.deepEqual(
    body.groups.map((group) => group.name),
    ["design@example.org", "team@example.org"],
    "the groups the agent's own session shows it holds",
  );
});

test("the fleet's meter is the installation's use, split per agent", async () => {
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);
  // One run, written by the canonical writer into the group's own audit
  // document — the only place a run's record lives, which is why the fleet's
  // total is read group by group (ADR 0010).
  const agentAuth = `Basic ${Buffer.from(
    `${mock.AGENT_ADDRESS}:${mock.AGENT_PASS}`,
  ).toString("base64")}`;
  const agentCtx = {
    authorization: agentAuth,
    session: await fetchUpstreamSession(agentAuth, BASE),
    username: mock.AGENT_ADDRESS,
  };
  const accounts = (agentCtx.session.accounts ?? {}) as Record<string, { name?: string }>;
  const team = Object.entries(accounts).find(([, a]) => a.name === DESIGN)?.[0];
  assert.ok(team, "the agent's session holds the group's account");
  await new AgentStore(agentCtx, team).appendAudit({
    at: new Date().toISOString(),
    jobId: "j1",
    ruleId: "r1",
    ruleVersion: 1,
    outcome: "done",
    actions: [],
    agent: mock.AGENT_ADDRESS,
    usage: { inputHitTokens: 40, inputMissTokens: 160, outputTokens: 25 },
  });

  const body = (await call("/api/admin/agents")).body as {
    meter: {
      total: Record<string, number | null>;
      byAgent: Array<{ agent: string; meter: Record<string, number | null> }>;
      unreadable: string[];
    };
  };
  assert.deepEqual(
    body.meter.total,
    { inputHitTokens: 40, inputMissTokens: 160, outputTokens: 25, runs: 1, uncounted: 0 },
    "the installation's total is the sum of what its groups spent",
  );
  assert.deepEqual(
    body.meter.byAgent,
    [
      {
        agent: mock.AGENT_ADDRESS,
        meter: {
          inputHitTokens: 40,
          inputMissTokens: 160,
          outputTokens: 25,
          runs: 1,
          uncounted: 0,
        },
      },
    ],
    "and the split names the agent each entry credits",
  );
  assert.deepEqual(body.meter.unreadable, [], "every group's audit was readable");
});

test("providers: empty without an agent, refused when the agent is out of reach", async () => {
  configureAgent("");
  const none = await call("/api/admin/agent/providers");
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, {
    address: "",
    provider: null,
    maxOutputTokens: 2048,
    // The two bounds an installation sets for itself keep their defaults when
    // there is no agent to hold them (ADR 0010).
    maxChainHops: config.agent.maxChainHops,
    maxPages: config.agent.maxPages,
  });

  configureAgent(TEAM);
  const unreachable = await call("/api/admin/agent/providers");
  assert.equal(unreachable.status, 409);
  assert.equal((unreachable.body as { error: string }).error, "agent_unreachable");
  const posted = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({
      provider: { provider: "openai", model: "gpt-mini", baseUrl: "https://x" },
    }),
  });
  assert.equal(posted.status, 409);
  assert.equal((posted.body as { error: string }).error, "agent_unreachable");
});

test("an administrator reads and saves a group's rules", async () => {
  configureAgent(mock.AGENT_ADDRESS);
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

test("a rule that could never run is refused with its code and its parameters", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  const notARule = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [{ v: 1, id: "half" }] }),
  });
  assert.equal(notARule.status, 400);
  // A code and its parameters, never a sentence: the surface composes the
  // sentence in the reader's language (ADR 0003 resolution 21). A rule with no
  // name to be named by is named by its position, and the position is a
  // parameter too.
  const nothing = notARule.body as { error: string; name: string; problems: string };
  assert.equal(nothing.error, "rule_cannot_run");
  assert.equal(nothing.name, "#1");
  assert.ok(nothing.problems.length > 0, "and the problems are the validator's own");

  const unrunnable = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({
      rules: [
        rule({
          id: "r2",
          name: "Move invoices",
          capabilities: [],
        }),
      ],
    }),
  });
  assert.equal(unrunnable.status, 400);
  const body = unrunnable.body as { error: string; name: string; problems: string };
  assert.equal(body.error, "rule_cannot_run");
  assert.equal(body.name, "Move invoices");
  assert.match(body.problems, /capabilities/, "in the validator's own words");

  const duplicate = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ id: "dup" }), rule({ id: "dup" })] }),
  });
  assert.equal(duplicate.status, 400);
  assert.equal((duplicate.body as { error: string }).error, "duplicate_rule");
});

test("a group the agent is not granted on answers with the refusal", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  // The meter is a reading of the trail the same answer carries, in the shape
  // the document declares (ADR 0010): no runs yet, and nothing unknown.
  const metered = await call(`/api/admin/groups/${TEAM}/agent`);
  assert.equal(metered.status, 200);
  assert.deepEqual((metered.body as { meter: unknown }).meter, {
    inputHitTokens: null,
    inputMissTokens: null,
    outputTokens: null,
    runs: 0,
    uncounted: 0,
  });

  const view = await call(`/api/admin/groups/${LEGAL}/agent`);
  assert.equal(
    view.status,
    200,
    "a group the agent does not hold is a state, not a failure",
  );
  const body = view.body as {
    group: string;
    granted: boolean;
    error?: string;
    need?: string;
    agentAddress: string;
    rules: unknown[];
    jobs: unknown[];
    decisions: unknown[];
    audit: unknown[];
    schedule: unknown[];
  };
  assert.equal(body.granted, false);
  assert.equal(body.group, LEGAL);
  assert.equal(body.agentAddress, mock.AGENT_ADDRESS);
  assert.equal(body.error, "group_not_accessible");
  assert.equal(
    body.need,
    "agent documents",
    "the section the surface asked for travels as its own name",
  );
  assert.ok(
    !("message" in body),
    "the refusal is a code and its parameter; the sentence is composed where it is read",
  );
  assert.deepEqual(
    [body.rules, body.jobs, body.decisions, body.audit, body.schedule],
    [[], [], [], [], []],
    "the surface answers one shape, empty when there is nothing to show",
  );

  for (const surface of [
    { path: `/api/admin/groups/${LEGAL}/agent/rules`, need: "automations" },
    { path: `/api/admin/groups/${LEGAL}/agent/labels`, need: "labels" },
  ]) {
    const res = await call(
      surface.path,
      surface.path.endsWith("/rules") ? undefined : { method: "POST" },
    );
    assert.equal(res.status, 403);
    const denied = res.body as { error: string; need?: string; message?: unknown };
    assert.equal(denied.error, "group_not_accessible");
    assert.equal(denied.need, surface.need, `${surface.path} names its own section`);
    assert.ok(!("message" in denied), `${surface.path} ships a code, not a sentence`);
  }
  const save = await call(`/api/admin/groups/${LEGAL}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [] }),
  });
  assert.equal(save.status, 403);
});

test("a group the agent holds is administered without the administrator's membership", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  // `design@example.org` is the agent's group and not the demo user's: the door
  // is the agent's grant, so this administers it where a membership rule would
  // have refused.
  const view = await call(`/api/admin/groups/${DESIGN}/agent`);
  assert.equal(view.status, 200);
  const body = view.body as { granted: boolean; error?: string; rules: unknown[] };
  assert.ok(!body.error, "no refusal: the agent is granted here");
  assert.equal(body.granted, true, "the agent reaches it, so the surface is open");

  const saved = await call(`/api/admin/groups/${DESIGN}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule()] }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stored = await call(`/api/admin/groups/${DESIGN}/agent/rules`);
  assert.equal(stored.status, 200);
  assert.deepEqual(
    (stored.body as { rules: Array<{ id: string }> }).rules.map((r) => r.id),
    ["r1"],
    "the automation lands in a group the administrator is not a member of",
  );
});

test("the agent's reserved labels are added once, and existing labels survive", async () => {
  configureAgent(mock.AGENT_ADDRESS);
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
  configureAgent(mock.AGENT_ADDRESS);
  // Self-contained: the member view has something to show because the group's
  // own account holds a rule, saved here through the admin surface.
  const seeded = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({
      rules: [
        rule(),
        rule({
          id: "r2",
          name: "Triage incoming mail",
          instruction: "Decide what it is and act.",
        }),
      ],
    }),
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
    instruction: { text: string; updatedAt: string | null; updatedBy: string | null };
    jobs: unknown[];
    audit: unknown[];
  };
  assert.equal(view.group, TEAM);
  assert.equal(view.granted, true, "the group's own documents are the evidence");
  assert.equal(view.agentAddress, mock.AGENT_ADDRESS);
  assert.deepEqual(view.jobs, []);
  assert.deepEqual(view.audit, []);
  assert.equal(view.rules.length, 2);
  // The shape is pinned field by field rather than by its key set: the optional
  // halves of a rule are absent from the JSON when the document does not carry
  // them (`updatedAt`, before the rule has been edited), so a key list would
  // only ever describe the first fixture.
  const [memberRule] = view.rules;
  for (const key of ["id", "name", "enabled", "trigger", "review", "instruction"]) {
    assert.ok(key in (memberRule ?? {}), `a member reads the automation's ${key}`);
  }
  for (const key of ["v", "version", "capabilities", "updatedAt", "updatedBy"]) {
    assert.ok(!(key in (memberRule ?? {})), `${key} stays on the admin surface`);
  }
  assert.deepEqual(
    memberRule?.review,
    { mode: "threshold", threshold: 0.8 },
    "the review policy is part of what a member judges",
  );
  assert.equal(
    memberRule?.instruction,
    "Label the messages this automation was written for.",
    "and so is what the automation is asked to do",
  );
  const second = view.rules.find((r) => r.id === "r2");
  assert.equal(
    second?.instruction,
    "Decide what it is and act.",
    "and a second automation carries an instruction of its own",
  );
  assert.ok(!("providers" in view), "no provider configuration reaches a member");

  const stranger = await call(`/api/agent/group/${LEGAL}`);
  assert.equal(stranger.status, 403);
  const denied = stranger.body as { error: string; need?: string; message?: unknown };
  assert.equal(denied.error, "group_not_accessible");
  assert.equal(denied.need, "agent documents", "the member door asks for the documents");
  assert.ok(!("message" in denied), "the refusal travels with no sentence");

  const anonymous = await app.request(`/api/agent/group/${TEAM}`);
  assert.equal(anonymous.status, 401, "the member route still needs a session");
});

test("a member reads the group's standing instruction, and nobody else reads it", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  // A group with no instruction answers with the empty text rather than an
  // absent field: a panel has to be able to say "there is none" plainly.
  const none = await call(`/api/agent/group/${TEAM}`);
  assert.equal(none.status, 200);
  assert.deepEqual((none.body as { instruction: unknown }).instruction, {
    text: "",
    notes: "",
    updatedAt: null,
    updatedBy: null,
    max: AGENT_INSTRUCTION_MAX,
    notesMax: AGENT_NOTES_MAX,
  });

  // Written where it is written today: the admin surface, which reaches the
  // group's own files as the installation's agent.
  const written = await call(`/api/admin/groups/${TEAM}/agent/instruction`, {
    method: "POST",
    body: JSON.stringify({
      text: "Answer in Italian, and always cite the invoice number.",
    }),
  });
  assert.equal(written.status, 200);

  const member = await call(`/api/agent/group/${TEAM}`);
  assert.equal(member.status, 200);
  const instruction = (
    member.body as {
      instruction: { text: string; updatedAt: string | null; updatedBy: string | null };
    }
  ).instruction;
  assert.equal(
    instruction.text,
    "Answer in Italian, and always cite the invoice number.",
    "the member's own session reads the document the admin surface wrote",
  );
  assert.equal(instruction.updatedBy, DEMO, "and it says who last wrote it");
  assert.equal(typeof instruction.updatedAt, "string");

  // A member's route answers GET and has no write path: the pen is elsewhere.
  const attempted = await app.request(`/api/agent/group/${TEAM}`, {
    method: "POST",
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ text: "Rewrite me" }),
  });
  assert.ok(attempted.status >= 400, "the member route refuses anything but a read");
  const after = await call(`/api/agent/group/${TEAM}`);
  assert.equal(
    (after.body as { instruction: { text: string } }).instruction.text,
    instruction.text,
    "and the document it read is unchanged",
  );

  // The instruction alone is evidence that the agent was configured for this
  // group: a group whose only document is this one still reads as granted, with
  // no automation to show yet.
  const cleared = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [] }),
  });
  assert.equal(cleared.status, 200);
  const alone = await call(`/api/agent/group/${TEAM}`);
  const only = alone.body as { granted: boolean; rules: unknown[] };
  assert.deepEqual(only.rules, []);
  assert.equal(
    only.granted,
    true,
    "an instruction is one of the group's own documents, like a rule",
  );

  // A group this session is not a member of: the same door, and nothing behind
  // it — no instruction, and no document to leak one from.
  const stranger = await call(`/api/agent/group/${LEGAL}`);
  assert.equal(stranger.status, 403);
  assert.ok(!("instruction" in (stranger.body ?? {})), "a refusal carries no document");
});

test("the approvals queue walks the agent's own groups", async () => {
  configureAgent("");
  const noAgent = await call("/api/admin/agent/approvals");
  assert.equal(noAgent.status, 409, "a queue needs the agent it is the queue of");
  assert.equal((noAgent.body as { error: string }).error, "agent_not_configured");

  configureAgent(mock.AGENT_ADDRESS);
  const res = await call("/api/admin/agent/approvals");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { approvals: [] });
});

test("every refusal names the section the surface asked for", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  /*
   * One door — the agent's grant on the group — and every route that asks for a
   * group's documents: the refusal has to name what the person was standing at
   * (the label catalog is one section's document, and "labels" is the answer
   * to all of them if the section is not carried), and it has to travel as the
   * section's own name rather than as a sentence, because a sentence written
   * here is English no catalogue can translate.
   */
  const routes: ReadonlyArray<{
    path: string;
    method?: string;
    body?: unknown;
    status?: number;
    need: string;
  }> = [
    { path: `/api/admin/groups/${LEGAL}/labels`, need: "labels" },
    {
      path: `/api/admin/groups/${LEGAL}/labels`,
      method: "POST",
      body: { labels: [] },
      need: "labels",
    },
    { path: `/api/admin/groups/${LEGAL}/agent`, status: 200, need: "agent documents" },
    { path: `/api/admin/groups/${LEGAL}/agent/rules`, need: "automations" },
    {
      path: `/api/admin/groups/${LEGAL}/agent/rules`,
      method: "POST",
      body: { rules: [] },
      need: "automations",
    },
    {
      path: `/api/admin/groups/${LEGAL}/agent/labels`,
      method: "POST",
      need: "labels",
    },
    {
      path: `/api/admin/groups/${LEGAL}/agent/instruction`,
      need: "standing instruction",
    },
    {
      path: `/api/admin/groups/${LEGAL}/agent/instruction`,
      method: "POST",
      body: { text: "" },
      need: "standing instruction",
    },
    { path: `/api/agent/group/${LEGAL}`, need: "agent documents" },
  ];
  const needs: string[] = [];
  for (const route of routes) {
    const res = await call(route.path, {
      method: route.method ?? "GET",
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
    });
    const where = `${route.method ?? "GET"} ${route.path}`;
    assert.equal(res.status, route.status ?? 403, where);
    const body = res.body as { error?: string; need?: string; message?: unknown };
    assert.equal(body.error, "group_not_accessible", where);
    assert.equal(body.need, route.need, `${where} names its own section`);
    assert.ok(
      !("message" in body),
      `${where} ships the code and its parameter, never a sentence`,
    );
    needs.push(String(body.need));
  }
  assert.equal(
    new Set(needs).size,
    4,
    "the four sections these routes ask for, not one shared answer",
  );
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
    required: string[];
    "x-actions": Array<{ name: string }>;
  };
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(schema.required.includes("instruction"));
  assert.ok(schema.required.includes("capabilities"));
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
  // rejected, and one it refuses is refused here in the same words — which
  // travel as the refusal's `problems`, so the surface can read them out.
  configureAgent(mock.AGENT_ADDRESS);
  const bad = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ capabilities: [] })] }),
  });
  assert.equal(bad.status, 400);
  const refusal = bad.body as { error: string; name?: string; problems?: string };
  assert.equal(refusal.error, "rule_cannot_run", "the refusal names the automation");
  assert.equal(refusal.name, "Label processed mail", "by name, as a parameter");
  assert.match(
    String(refusal.problems),
    /capabilit/i,
    "and what the rule is missing, in the schema's own words",
  );

  // The cross-field half is in the same list: an action outside the allowlist.
  const outside = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ capabilities: [] })] }),
  });
  assert.equal(outside.status, 400);
  assert.match(String((outside.body as { problems?: string }).problems), /capabilities/);
});

/**
 * The copy of a group's audit trail (ADR 0003, audit retention).
 *
 * The retention is a window of whole months and the prune is what applies it,
 * so the export is the months that are still there and nothing else. The mock
 * writes no audit document, which is why the trail here is empty rather than
 * absent — and the refusal is the same pair, code and section, as everywhere
 * else a group's documents are out of reach.
 */
test("a group's audit trail is copied, and the copy dates itself", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  const res = await call(`/api/admin/groups/${TEAM}/agent/audit`);
  assert.equal(res.status, 200);
  const body = res.body as {
    group: string;
    agentAddress: string;
    exportedAt: string;
    months: unknown[];
  };
  assert.equal(body.group, TEAM);
  assert.equal(body.agentAddress, mock.AGENT_ADDRESS);
  assert.ok(
    Number.isFinite(Date.parse(body.exportedAt)),
    "the copy dates itself, so a reader knows the cut of the record",
  );
  assert.deepEqual(
    body.months,
    [],
    "nothing was ever written for this group, so the trail is empty and not absent",
  );
});

test("the audit copy is refused for a group the agent does not hold", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  const res = await call(`/api/admin/groups/${LEGAL}/agent/audit`);
  assert.equal(res.status, 403);
  const body = res.body as { error?: string; need?: string };
  assert.equal(body.error, "group_not_accessible");
  assert.equal(body.need, "agent documents");
  assert.ok(
    !("message" in body),
    "the refusal is a code and its parameter, never a sentence",
  );
});

/* ------------------------------------------------------------------ */
/* Run now (ADR 0010)                                                  */
/* ------------------------------------------------------------------ */

/**
 * The ask writes a job and nothing else, and it refuses in words a person can
 * act on.
 *
 * The two halves worth pinning are the ones a surface cannot fake: an ask that
 * can run leaves a `pending` job in the group's own account whose provenance
 * says a person asked for it — the worker's sweep is what runs it, and that is
 * a different process — and an ask that cannot run is answered without writing
 * anything into the group's trail, because no run happened.
 */
test("an automation can be asked for, and the ask is a job", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ id: "manual-1" })] }),
  });

  const asked = await call(`/api/admin/groups/${TEAM}/agent/run`, {
    method: "POST",
    body: JSON.stringify({ ruleId: "manual-1" }),
  });
  assert.equal(asked.status, 200);
  const job = (asked.body as { job: Record<string, unknown> }).job;
  assert.equal(job.state, "pending", "the worker runs it, not the request");
  assert.equal(job.ruleId, "manual-1");
  const trigger = job.trigger as Record<string, unknown>;
  assert.equal(trigger.on, "manual", "the record says a person asked for it");
  assert.equal(trigger.by, DEMO, "and which person");
  assert.equal(typeof trigger.emailId, "string", "on the newest message it found");

  const view = (await call(`/api/admin/groups/${TEAM}/agent`)).body as {
    jobs: Array<{ id: string }>;
    audit: unknown[];
  };
  assert.deepEqual(
    view.jobs.map((j) => j.id),
    [job.id],
    "the job is in the group's own account, which is where the sweep reads it",
  );
  assert.deepEqual(view.audit, [], "and the ask itself is not a run in the trail");
});

test("an ask that cannot run is answered, and writes nothing", async () => {
  configureAgent(mock.AGENT_ADDRESS);
  await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({
      rules: [
        rule({ id: "manual-off", enabled: false }),
        rule({ id: "manual-chat", trigger: { on: "chat" } }),
      ],
    }),
  });

  const before = (await call(`/api/admin/groups/${TEAM}/agent`)).body as {
    jobs: unknown[];
    audit: unknown[];
  };

  const unarmed = await call(`/api/admin/groups/${TEAM}/agent/run`, {
    method: "POST",
    body: JSON.stringify({ ruleId: "manual-off" }),
  });
  assert.equal(unarmed.status, 409);
  assert.deepEqual(unarmed.body, {
    error: "manual_run_refused",
    why: "rule_not_armed",
    rule: "Label processed mail",
  });

  const chat = await call(`/api/admin/groups/${TEAM}/agent/run`, {
    method: "POST",
    body: JSON.stringify({ ruleId: "manual-chat" }),
  });
  assert.equal(chat.status, 409);
  assert.equal((chat.body as { why?: string }).why, "rule_not_email");

  const missing = await call(`/api/admin/groups/${TEAM}/agent/run`, {
    method: "POST",
    body: JSON.stringify({ ruleId: "nobody" }),
  });
  assert.equal(missing.status, 404);
  assert.equal((missing.body as { why?: string }).why, "rule_not_found");

  const after = (await call(`/api/admin/groups/${TEAM}/agent`)).body as {
    jobs: unknown[];
    audit: unknown[];
  };
  assert.deepEqual(
    after,
    before,
    "a refusal is answered to whoever asked, and the group's trail is untouched",
  );
});

/**
 * The author's notes, and the author's reading (ADR 0010).
 *
 * A note is carried in the same document as the prose it belongs to — so it
 * survives a container and the next editor reads why the prose is written the
 * way it is — and it never reaches a model: what a run sends is the instruction
 * and nothing beside it (the prompt itself is pinned in `agent/llm.test.ts`).
 *
 * The reading is the one call that answers in words. It is not a run: nothing
 * is compiled, no job is written, and its tokens are counted in the Master's
 * own account as authoring, because an administrator reading a draft is the
 * installation's own work and belongs to no group's ledger.
 */
test("an author's notes ride the document, and a reading answers in words", async () => {
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);
  const agentAuth = `Basic ${Buffer.from(
    `${mock.AGENT_ADDRESS}:${mock.AGENT_PASS}`,
  ).toString("base64")}`;
  const agentCtx = {
    authorization: agentAuth,
    session: await fetchUpstreamSession(agentAuth, BASE),
    username: mock.AGENT_ADDRESS,
  };
  const agentAccount = filesAccountId(agentCtx);
  // The installation's model, written through the store: the admin route
  // refuses a plaintext address on purpose, and a stub on loopback is exactly
  // that.
  const master = new AgentStore(agentCtx, agentAccount);
  await master.writeConfig({
    v: 1,
    address: mock.AGENT_ADDRESS,
    provider: {
      provider: "stub",
      model: "stub",
      baseUrl: `http://127.0.0.1:${READING_PORT}/v1`,
      apiKey: "stub-key",
    },
  });

  const written = await call(`/api/admin/groups/${TEAM}/agent/instruction`, {
    method: "POST",
    body: JSON.stringify({
      text: "Answer in Italian, and always cite the invoice number.",
      notes: "Italian is what the group speaks; the citation is for the auditor.",
    }),
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(
    (written.body as { notes?: string }).notes,
    "Italian is what the group speaks; the citation is for the auditor.",
  );
  const read = await call(`/api/admin/groups/${TEAM}/agent/instruction`);
  assert.equal(
    (read.body as { notes?: string }).notes,
    "Italian is what the group speaks; the citation is for the auditor.",
    "the note is in the document the group holds",
  );

  // A rule carries its own, and a save that does not name one keeps the one it
  // has: the notes are part of what the document already is.
  const withNotes = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({
      rules: [{ ...rule(), notes: "Written for the 2026 audit; revisit in January." }],
    }),
  });
  assert.equal(withNotes.status, 200);
  assert.equal(
    (withNotes.body as { rules: Array<{ notes?: string }> }).rules[0]?.notes,
    "Written for the 2026 audit; revisit in January.",
  );

  // The reading: the draft goes out, the model's words come back, and the call
  // is counted where the ADR says — in the Master's account, as authoring.
  readingAnswer =
    "It says which language to answer in. It never says who reads the reply.";
  const reading = await call(`/api/admin/groups/${TEAM}/agent/reading`, {
    method: "POST",
    body: JSON.stringify({
      about: "the group's standing instruction",
      draft: "Answer in Italian, and always cite the invoice number.",
    }),
  });
  assert.equal(reading.status, 200, JSON.stringify(reading.body));
  assert.equal(
    (reading.body as { text?: string }).text,
    "It says which language to answer in. It never says who reads the reply.",
    "the answer is the model's prose, shown as prose",
  );

  const counted = await master.readAuthoring(monthOf(new Date()));
  assert.equal(counted?.entries.length, 1, "the reading is counted");
  assert.equal(counted?.entries[0]?.about, "the group's standing instruction");
  assert.equal(counted?.entries[0]?.by, DEMO, "and it names who asked");
  assert.equal(counted?.entries[0]?.group, TEAM);
  assert.ok(counted?.entries[0]?.usage, "with what the provider reported it cost");
});

test("a reading with no usable model says so, and never calls upstream", async () => {
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);
  const agentAuth = `Basic ${Buffer.from(
    `${mock.AGENT_ADDRESS}:${mock.AGENT_PASS}`,
  ).toString("base64")}`;
  const agentCtx = {
    authorization: agentAuth,
    session: await fetchUpstreamSession(agentAuth, BASE),
    username: mock.AGENT_ADDRESS,
  };
  // An installation whose provider has no key cannot call anything, which is
  // the state `providerFor` refuses: the reading answers with its own code
  // rather than pretending an upstream failed.
  await new AgentStore(agentCtx, filesAccountId(agentCtx)).writeConfig({
    v: 1,
    address: mock.AGENT_ADDRESS,
    provider: {
      provider: "stub",
      model: "stub",
      baseUrl: "https://example.invalid/v1",
      apiKey: "",
    },
  });
  const reading = await call(`/api/admin/groups/${TEAM}/agent/reading`, {
    method: "POST",
    body: JSON.stringify({ about: "a draft", draft: "File the invoices." }),
  });
  assert.equal(reading.status, 409);
  assert.deepEqual(reading.body, { error: "no_provider" });
});

/**
 * The bounds an installation sets for itself (ADR 0010).
 *
 * They live where the model lives — one document, one write — so the surface
 * that states what the fleet runs on is the surface that states how far a chain
 * may run and how many pages a run may hand the model. A value the bound
 * forbids is refused where an administrator reads a sentence, and `null` clears
 * one back to what the deployment's environment declares.
 */
test("the installation's bounds are written where it states its model", async () => {
  configureAgent(mock.AGENT_ADDRESS, mock.AGENT_PASS);
  const saved = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({ maxChainHops: 7, maxPages: 12 }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = await call("/api/admin/agent/providers");
  const view = read.body as { maxChainHops: number; maxPages: number };
  assert.equal(
    view.maxChainHops,
    7,
    "the bound the installation set is the one in force",
  );
  assert.equal(view.maxPages, 12);

  const bad = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({ maxChainHops: 0 }),
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, {
    error: "max_chain_hops_invalid",
    max: AGENT_CHAIN_HOPS_CEILING,
  });
  const tooMany = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({ maxPages: AGENT_PAGES_CEILING + 1 }),
  });
  assert.equal(tooMany.status, 400);
  assert.deepEqual(tooMany.body, {
    error: "max_pages_invalid",
    max: AGENT_PAGES_CEILING,
  });

  // The write that clears one leaves the other, and the model, exactly as they
  // were: one field, one statement.
  const cleared = await call("/api/admin/agent/providers", {
    method: "POST",
    body: JSON.stringify({ maxChainHops: null }),
  });
  assert.equal(cleared.status, 200);
  const after = await call("/api/admin/agent/providers");
  const restored = after.body as { maxChainHops: number; maxPages: number };
  assert.equal(restored.maxChainHops, config.agent.maxChainHops);
  assert.equal(restored.maxPages, 12, "and the other bound is untouched");
});
