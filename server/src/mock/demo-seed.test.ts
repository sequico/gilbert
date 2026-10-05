import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The demo the mock ships (ADR 0024, 0028, 0030): the company knowledge base and
 * the workorders of an industrial manufacturer. What these pin is that the seed
 * is reachable through the **same routes a reader uses** — the tier really is
 * the Master's, a template's rules resolve the way a workorder reads them, and a
 * workorder's steps carry the states the seed preset. A seed that answered a
 * different account, or stored paths the resolution never produces, would leave
 * the demo empty while every unit test stayed green.
 *
 * Mock port: must not collide with any other test file.
 */

const PORT = 18879;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-demo-seed";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

const DEMO = "demo@example.com";
const TEAM_GROUP = "a3";

const mock = await import("./index.js");
const { createApp, useDurableSessions } = await import("../app.js");

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

const workorderOf = (body: Record<string, unknown> | null): Workorder => {
  const workorder = body?.workorder as Workorder | undefined;
  assert.ok(workorder, "the route answers with a workorder");
  return workorder;
};

interface Step {
  path: string;
  state: string;
  note: string;
}
interface Group {
  key: string;
  items: Array<{ key: string; steps: Step[] }>;
}
interface Part {
  scope: "global" | "group";
  accountId: string | null;
  group: string | null;
  groups: Group[];
}
interface Workorder {
  uid: string;
  name: string;
  state: string;
  parts: Part[];
}

const stepsOf = (part: Part): Step[] =>
  part.groups.flatMap((section) => section.items.flatMap((item) => item.steps));

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: "demo-password" }),
  });
  assert.equal(res.status, 200, "the demo administrator signs in against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the company KB the demo ships is the Master's and lists every seeded article", async () => {
  const res = await call("/api/knowledge/company/tree");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const articles = res.body?.articles as Array<{
    title: string;
    template: string | null;
    rev: number | null;
  }>;
  assert.ok(Array.isArray(articles), "the tree answers with articles");

  const titles = articles.map((article) => article.title);
  for (const title of [
    "Production planning",
    "Quality control",
    "Warehouse and inventory",
    "Health and safety",
    "Purchasing",
    "Shipping documents",
    "Non-conformance report",
    "Machine setup",
    "ISO 9001 — quality management system",
    "Document control",
    "Internal audit and management review",
    "Container shipment checklist",
    "Machine maintenance checklist",
  ])
    assert.ok(titles.includes(title), `the tree lists "${title}"`);

  // The two templates are marked as such and issued in force as revision 1.
  for (const title of ["Container shipment checklist", "Machine maintenance checklist"]) {
    const article = articles.find((one) => one.title === title)!;
    assert.equal(article.template, "checklist", `"${title}" is a checklist template`);
    assert.equal(article.rev, 1, `"${title}" is in force as revision 1`);
  }
  // Every article is in force: the demo is a knowledge base, not a pile of drafts.
  assert.ok(
    articles.every((article) => article.rev === 1),
    "every seeded article is issued in force",
  );
});

test("a seeded article carries a structured body, not one line", async () => {
  const res = await call(
    "/api/knowledge/company/article?folder=" +
      encodeURIComponent("ISO 9001 — quality management system"),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const article = res.body?.article as {
    effective: { blocks: Array<{ type: string }> } | null;
  };
  const types = article.effective!.blocks.map((block) => block.type);
  assert.ok(types.includes("heading"), "the article has section headings");
  assert.ok(types.includes("bulletListItem"), "the article has bullet lists");
  assert.ok(
    types.filter((type) => type === "paragraph").length >= 2,
    "the article has more than one paragraph",
  );
});

test("a seeded template carries its branching rules, resolved from the KB", async () => {
  const res = await call(
    "/api/knowledge/company/article?folder=Container%20shipment%20checklist",
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const article = res.body?.article as {
    effective: { checklist: Record<string, unknown> | null } | null;
  };
  const checklist = article?.effective?.checklist as {
    variants: Array<{ key: string }>;
    sections: Array<{
      key: string;
      group?: string;
      repeat?: { item: string };
      steps: Array<{ key: string; condition?: { variant: string; equals: string } }>;
    }>;
  };
  assert.ok(checklist, "the in-force revision carries the template's rules");

  assert.deepEqual(
    checklist.variants.map((variant) => variant.key),
    ["line"],
  );
  assert.deepEqual(
    checklist.sections.map((section) => section.key),
    ["booking", "loading", "customs", "final"],
  );
  const loading = checklist.sections.find((section) => section.key === "loading")!;
  assert.equal(
    loading.repeat?.item,
    "Container",
    "the loading section repeats per container",
  );
  const customs = checklist.sections.find((section) => section.key === "customs")!;
  assert.equal(
    customs.group,
    TEAM_GROUP,
    "the customs section is assigned to the team group",
  );
  const reference = checklist.sections
    .find((section) => section.key === "booking")!
    .steps.find((step) => step.key === "reference")!;
  assert.deepEqual(reference.condition, { variant: "line", equals: "maersk" });
});

test("the demo's workorders are running and completed, with their steps' states", async () => {
  const res = await call("/api/workorders");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const workorders = res.body?.workorders as Workorder[];
  const byUid = new Map(workorders.map((workorder) => [workorder.uid, workorder]));

  assert.equal(byUid.get("container-northwind")?.state, "running");
  assert.equal(byUid.get("maintenance-line2")?.state, "running");
  assert.equal(
    byUid.get("maintenance-line1")?.state,
    "completed",
    "a closed workorder is kept and listed",
  );

  // The running container: its global part drops the group-assigned section, and
  // the states the seed preset are stored.
  const detail = await call("/api/workorders/container-northwind");
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const container = workorderOf(detail.body);
  const global = container.parts.find((part) => part.scope === "global")!;
  assert.deepEqual(
    global.groups.map((section) => section.key),
    ["booking", "loading", "final"],
    "the global part carries every section the group does not own",
  );
  const globalSteps = new Map(stepsOf(global).map((step) => [step.path, step]));
  assert.equal(globalSteps.get("booking.confirm")?.state, "done");
  assert.equal(globalSteps.get("booking.reference")?.state, "skipped");
  assert.equal(globalSteps.get("loading[CONT-2].seal")?.state, "not-applicable");
  assert.equal(
    globalSteps.get("loading[CONT-1].label")?.state,
    "done",
    "a step conditioned on the chosen line materialises inside each container",
  );
  assert.equal(globalSteps.get("loading[CONT-2].label")?.state, "open");
  assert.equal(globalSteps.get("final.handover")?.state, "open");
  assert.equal(
    globalSteps.get("booking.reference")?.note,
    "Booked through the forwarder.",
    "a skipped step keeps the reason it was skipped",
  );

  // The group's part holds the section the template assigned to it, and only that.
  const part = container.parts.find((each) => each.scope === "group")!;
  assert.equal(part.group, "team@example.org");
  assert.equal(part.accountId, TEAM_GROUP, "the part lives in the group's own account");
  assert.deepEqual(
    part.groups.map((section) => section.key),
    ["customs"],
  );
  assert.equal(stepsOf(part)[0]?.state, "done");

  // The weekly run does not carry the monthly-only section; the completed
  // monthly one does.
  const weekly = await call("/api/workorders/maintenance-line2");
  const weeklyGroups = workorderOf(weekly.body).parts[0]!.groups.map(
    (section) => section.key,
  );
  assert.deepEqual(
    weeklyGroups,
    ["visual", "signoff"],
    "a weekly run has no lubrication",
  );
  const monthly = await call("/api/workorders/maintenance-line1");
  const monthlyGroups = workorderOf(monthly.body).parts[0]!.groups.map(
    (section) => section.key,
  );
  assert.deepEqual(monthlyGroups, ["visual", "lubrication", "signoff"]);
});
