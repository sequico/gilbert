import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The agent worker fleet's admin and member surfaces (ADR 0003), end to end
 * against the mock.
 *
 * Two fixtures carry the whole file. `team@example.org` is a group the demo
 * administrator is a member of, and the group's own documents are reachable
 * through their own session — which is the grant, exactly as it is for the
 * label catalog (ADR 0005). `legal@example.org` is a group they are not a
 * member of, and a non-member administrator has no act-as-the-group path at
 * all: the mock refuses impersonating a group mailbox the way a real 0.16
 * server does.
 *
 * The mock holds an agent principal (`AGENT_ADDRESS`, default
 * `gilbert@example.com`) that an administrator may impersonate, which is what
 * puts the fleet's happy path in reach: a credential provisioned under
 * impersonation, and a sign-in as the agent proving it works. The surfaces that
 * have to answer without one are exercised too: a deployment whose agent cannot
 * be reached is reported rather than invented, and every group write goes
 * through membership.
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

const DEMO = "demo@example.com";
const TEAM = "team@example.org";
const LEGAL = "legal@example.org";

const mock = await import("./mock/index.js");
const { config } = await import("./config.js");
const { AGENT_INSTRUCTION_MAX, AGENT_TIERS } = await import("./agent/documents.js");
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
 * Fail one upstream request shape, and hand back the way to put the real
 * `fetch` back.
 *
 * The mock refuses no directory query (it has no `allow_directory_query` gate
 * to close), so a status an answer depends on has to be staged at the one seam
 * every upstream call crosses: the request body says which JMAP method is being
 * asked for, and this makes exactly that one fail.
 */
function failUpstream(contains: string, status: number): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes(contains)) return new Response("{}", { status });
    return real(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/**
 * Fail the agent's own sign-in, and hand back the way to put the real `fetch`
 * back.
 *
 * Signing in is the one call the agent makes that carries no JMAP body — it is
 * a GET on the well-known URL — so `failUpstream` cannot reach it. The request
 * is recognised by the credential it carries, and only the agent's own pair is
 * failed, so a session fetched for anybody else goes through untouched.
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
    operational: false,
    address: "",
    groups: [],
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

test("a rule that could never run is refused with its code and its parameters", async () => {
  configureAgent("");
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
          actions: [{ do: "mail.move", with: { mailbox: "work" } }],
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

test("a group the admin is not a member of answers with the refusal", async () => {
  configureAgent("");
  const view = await call(`/api/admin/groups/${LEGAL}/agent`);
  assert.equal(view.status, 200, "a missing membership is a state, not a failure");
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
  assert.equal(body.agentAddress, "", "no agent is registered in this installation");
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
    body: JSON.stringify({
      rules: [
        rule(),
        rule({
          id: "r2",
          name: "Triage incoming mail",
          tier: "T2",
          instruction: "Decide what it is and act.",
          actions: undefined,
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
  assert.equal(view.agentAddress, "", "no agent is registered in this installation");
  assert.deepEqual(view.jobs, []);
  assert.deepEqual(view.audit, []);
  assert.equal(view.rules.length, 2);
  // The shape is pinned field by field rather than by its key set: the optional
  // halves of a rule are absent from the JSON when the document does not carry
  // them (`instruction` on a T0 rule), so a key list would only ever describe
  // the first fixture.
  const [memberRule] = view.rules;
  for (const key of ["id", "name", "tier", "enabled", "trigger", "review", "actions"]) {
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
  assert.deepEqual(
    memberRule?.actions,
    [{ do: "keyword.add", with: { keyword: "G-processed" } }],
    "and so is what the automation then does",
  );
  const t2 = view.rules.find((r) => r.id === "r2");
  assert.equal(
    t2?.instruction,
    "Decide what it is and act.",
    "a tier that decides says what it was told to decide",
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
  configureAgent("");
  // A group with no instruction answers with the empty text rather than an
  // absent field: a panel has to be able to say "there is none" plainly.
  const none = await call(`/api/agent/group/${TEAM}`);
  assert.equal(none.status, 200);
  assert.deepEqual((none.body as { instruction: unknown }).instruction, {
    text: "",
    updatedAt: null,
    updatedBy: null,
    max: AGENT_INSTRUCTION_MAX,
  });

  // Written where it is written today: the admin surface, by a member
  // administrator, through the group's own files.
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

test("the approvals queue is empty and needs no agent", async () => {
  configureAgent("");
  const res = await call("/api/admin/agent/approvals");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    approvals: [],
    enumeration: true,
    enumerationMessage: null,
  });
});

test("a queue the directory could not be listed for says so", async () => {
  // The admin who is not also a Stalwart server administrator hits the
  // directory gate, and the queue then walks only the groups their own session
  // holds. The answer has to carry that, or a short queue and an empty one read
  // the same. The agent is deliberately not configured: the queue is built from
  // the admin's own reach, which is a different read from the fleet's.
  configureAgent("");
  const denied = failUpstream("Principal/query", 403);
  try {
    const queue = await call("/api/admin/agent/approvals");
    assert.equal(queue.status, 200);
    const body = queue.body as {
      approvals: unknown[];
      enumeration: boolean;
      enumerationMessage: string | null;
    };
    assert.deepEqual(body.approvals, []);
    assert.equal(body.enumeration, false, "the list is the membership fallback");
    assert.ok(body.enumerationMessage, "and the reason travels with it");
  } finally {
    denied();
  }

  // A directory that fails outright is the same answer, not a 500.
  const broken = failUpstream("Principal/query", 500);
  try {
    const queue = await call("/api/admin/agent/approvals");
    assert.equal(queue.status, 200);
    const body = queue.body as {
      enumeration: boolean;
      enumerationMessage: string | null;
    };
    assert.equal(body.enumeration, false);
    assert.match(body.enumerationMessage ?? "", /500/);
  } finally {
    broken();
  }
});

test("every refusal names the section the surface asked for", async () => {
  configureAgent("");
  /*
   * One door — membership of the group — and every route that asks for a
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
    properties: { tier: { enum: string[] } };
    "x-actions": Array<{ name: string }>;
  };
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
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
  // rejected, and one it refuses is refused here in the same words — which
  // travel as the refusal's `problems`, so the surface can read them out.
  configureAgent("");
  const bad = await call(`/api/admin/groups/${TEAM}/agent/rules`, {
    method: "POST",
    body: JSON.stringify({ rules: [rule({ tier: "T9" })] }),
  });
  assert.equal(bad.status, 400);
  const refusal = bad.body as { error: string; name?: string; problems?: string };
  assert.equal(refusal.error, "rule_cannot_run", "the refusal names the automation");
  assert.equal(refusal.name, "Label processed mail", "by name, as a parameter");
  assert.match(
    String(refusal.problems),
    /tier|T9/i,
    "and what the schema objected to, in its own words",
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
  configureAgent("");
  const res = await call(`/api/admin/groups/${TEAM}/agent/audit`);
  assert.equal(res.status, 200);
  const body = res.body as {
    group: string;
    agentAddress: string;
    exportedAt: string;
    months: unknown[];
  };
  assert.equal(body.group, TEAM);
  assert.equal(body.agentAddress, "", "no agent is registered in this installation");
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

test("the audit copy is refused for a group the admin is not a member of", async () => {
  configureAgent("");
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
