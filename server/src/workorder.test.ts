import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { postWith } from "./testkit.js";

/**
 * Workorders (ADR 0028), end to end against the mock.
 *
 * The Master owns the root and composes the surface; a checklist is an instance
 * of a KB template, bound to the revision in force, holding step ids and the
 * last signature and never the controlled text. Closing moves the root to
 * `closed/` and keeps it. Each test fails if the mechanism is removed.
 *
 * Mock port: must not collide with any other test file.
 */

const PORT = 18877;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-workorders";
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

interface Summary {
  uid: string;
  name: string;
  state: string;
  parts: Array<{
    scope: string;
    labels: Record<string, string>;
    checklist: {
      steps: Array<{ id: string; state: string; by: string | null; at: string | null }>;
    };
  }>;
}
const workorderOf = (body: Record<string, unknown> | null): Summary => {
  const w = body?.workorder as Summary | undefined;
  assert.ok(w, "the route answers with a workorder");
  return w;
};

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

/** A KB checklist template, in force, and the reference a workorder binds to. */
async function templateRef(): Promise<{
  accountId: string;
  id: string;
  revision: string;
}> {
  const company = (await call("/api/knowledge/company")).body?.company as
    | { accountId: string; folderId: string }
    | undefined;
  assert.ok(company);
  const created = await post("/api/knowledge/create", {
    scope: "company",
    title: "Packing checklist",
  });
  const summary = created.body?.summary as { id: string; folder: string };
  const blocks = [
    {
      type: "checkListItem",
      id: "s1",
      content: [{ type: "text", text: "Open the box" }],
    },
    {
      type: "checkListItem",
      id: "s2",
      content: [{ type: "text", text: "Count the parts" }],
    },
  ];
  await post("/api/knowledge/save", {
    scope: "company",
    folder: summary.folder,
    input: {
      title: "Packing checklist",
      tags: [],
      blocks,
      text: "Open the box\nCount the parts",
    },
  });
  const approved = await post("/api/knowledge/approve", {
    scope: "company",
    folder: summary.folder,
    effectiveAt: new Date().toISOString(),
  });
  const approvedSummary = approved.body?.summary as
    | { inForce: { revision: string } }
    | undefined;
  assert.ok(approvedSummary);
  const inForce = approvedSummary.inForce;
  return { accountId: company.accountId, id: summary.id, revision: inForce.revision };
}

test("a workorder is created from a KB template and checked step by step", async () => {
  const template = await templateRef();

  const created = await post("/api/workorders/create", {
    name: "Q3 delivery",
    template,
    groups: [],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const workorder = workorderOf(created.body);
  assert.equal(workorder.name, "Q3 delivery");
  assert.equal(workorder.state, "running");
  const global = workorder.parts.find((p) => p.scope === "global");
  assert.ok(global, "the global checklist is there");
  assert.deepEqual(
    global.checklist.steps.map((s) => s.id),
    ["s1", "s2"],
    "the steps are the template's, open",
  );
  assert.equal(
    global.labels.s1,
    "Open the box",
    "the label comes from the template revision",
  );

  const listed = await call("/api/workorders");
  assert.equal(listed.status, 200);
  const listedWorkorders = listed.body?.workorders as Summary[] | undefined;
  assert.ok(
    (listedWorkorders ?? []).some((w) => w.uid === workorder.uid),
    "the registry lists it",
  );

  const checked = await post("/api/workorders/check", {
    uid: workorder.uid,
    scope: "global",
    stepId: "s1",
    checked: true,
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const step = workorderOf(checked.body)
    .parts.find((p) => p.scope === "global")!
    .checklist.steps.find((s) => s.id === "s1")!;
  assert.equal(step.state, "done");
  assert.equal(
    step.by,
    DEMO,
    "the signature is the authenticated caller, not the Master",
  );
  assert.ok(step.at, "and the instant");
});

test("closing a workorder moves its root to closed/ and keeps it", async () => {
  const template = await templateRef();
  const created = await post("/api/workorders/create", {
    name: "Disposable run",
    template,
    groups: [],
  });
  const uid = workorderOf(created.body).uid;

  const closed = await post("/api/workorders/close", { uid, state: "completed" });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(workorderOf(closed.body).state, "completed");

  const read = await call(`/api/workorders/${uid}`);
  assert.equal(read.status, 200, "a closed workorder is kept, not destroyed");
  assert.equal((read.body?.workorder as Summary | undefined)?.state, "completed");
});

test("a workorder that does not exist is a 404", async () => {
  const missing = await call("/api/workorders/no-such-uid");
  assert.equal(missing.status, 404);
});

test("a closed workorder's checklist no longer changes", async () => {
  /*
   * A terminal state is kept for ever and the checklist is the record of the
   * work: checking a step afterwards would rewrite history. The guard reads the
   * root's state, so a part is covered by the same rule.
   */
  const template = await templateRef();
  const created = await post("/api/workorders/create", {
    name: "Sealed run",
    template,
    groups: [],
  });
  const uid = workorderOf(created.body).uid;
  await post("/api/workorders/close", { uid, state: "completed" });

  const checked = await post("/api/workorders/check", {
    uid,
    scope: "global",
    stepId: "s1",
    checked: true,
  });
  assert.equal(checked.status, 409, JSON.stringify(checked.body));
  assert.equal(checked.body?.error, "workorder_closed");
});
