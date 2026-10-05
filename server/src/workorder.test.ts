import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isStepComplete } from "./shared/workorder.js";
import { postWith } from "./testkit.js";

/**
 * Workorders (ADR 0028), end to end against the mock.
 *
 * The Master owns the root and composes the surface; a checklist is an instance
 * of a KB template's **process** (ADR 0030), bound to the revision in force,
 * holding the chosen variant values and repeated items, each applicable step's
 * path and its last signature — never a copy of the controlled text. Closing
 * moves the root to `closed/` and keeps it. Each test fails if the mechanism is
 * removed.
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

/** The process a template carries: a variant, a plain, a repeated, a final section. */
const PROCESS = {
  variants: [
    {
      key: "company",
      label: "Company",
      values: [
        { value: "north", label: "North" },
        { value: "south", label: "South" },
      ],
    },
  ],
  sections: [
    {
      key: "paperwork",
      label: "Paperwork",
      steps: [
        { key: "ref", label: "Record the reference" },
        {
          key: "sign",
          label: "Sign the form",
          condition: { variant: "company", equals: "north" },
        },
      ],
    },
    {
      key: "loading",
      label: "Loading",
      repeat: { item: "Container", fields: [{ key: "seal", label: "Seal" }] },
      steps: [
        { key: "load", label: "Load the container" },
        { key: "seal", label: "Seal the container" },
      ],
    },
    {
      key: "final",
      label: "Final",
      steps: [{ key: "dispatch", label: "Dispatch" }],
    },
  ],
};

interface StepView {
  path: string;
  label: string;
  state: string;
  by: string | null;
  at: string | null;
  note: string;
}

interface PartView {
  scope: string;
  groups: Array<{
    key: string;
    label: string;
    repeat: string | null;
    items: Array<{
      key: string;
      label: string;
      fields: Array<{ key: string; label: string; value: string }>;
      steps: StepView[];
    }>;
  }>;
  checklist: {
    variants: Record<string, string>;
    items: Record<string, Array<{ key: string; data: Record<string, string> }>>;
    steps: Array<{ path: string; state: string; by: string | null; at: string | null }>;
  };
  templateTitle: string | null;
}

interface Summary {
  uid: string;
  name: string;
  state: string;
  parts: PartView[];
}

const workorderOf = (body: Record<string, unknown> | null): Summary => {
  const w = body?.workorder as Summary | undefined;
  assert.ok(w, "the route answers with a workorder");
  return w;
};

const partOf = (workorder: Summary, scope: string): PartView => {
  const part = workorder.parts.find((p) => p.scope === scope);
  assert.ok(part, `the ${scope} part is there`);
  return part;
};

const stepAt = (workorder: Summary, scope: string, path: string): StepView => {
  const step = partOf(workorder, scope).checklist.steps.find((s) => s.path === path);
  assert.ok(step, `the ${scope} checklist has a step "${path}"`);
  return step as StepView;
};

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

/** A KB checklist template, in force, and the reference a workorder binds to. */
async function templateRef(
  process: unknown = PROCESS,
  title = "Packing checklist",
): Promise<{
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
    title,
    checklist: process,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const summary = created.body?.summary as { id: string; folder: string };
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

/** A workorder created with the choices the process needs. */
async function createWorkorder(
  name: string,
  template: { accountId: string; id: string; revision: string },
): Promise<Summary> {
  const created = await post("/api/workorders/create", {
    name,
    template,
    groups: [],
    variants: { company: "north" },
    items: { loading: [{ key: "CONT-1", data: { seal: "S-1" } }] },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return workorderOf(created.body);
}

test("a repeat whose section condition is false needs no items", async () => {
  /*
   * A section the chosen value excludes does not materialise (ADR 0030), so its
   * repeat names no items and none are required — only a section that will
   * appear needs at least one. The create succeeds and the excluded repeat
   * contributes no item and no step.
   */
  const conditional = {
    variants: [
      {
        key: "company",
        label: "Company",
        values: [
          { value: "north", label: "North" },
          { value: "south", label: "South" },
        ],
      },
    ],
    sections: [
      {
        key: "loading",
        label: "Loading",
        condition: { variant: "company", equals: "north" },
        repeat: { item: "Container", fields: [] },
        steps: [{ key: "load", label: "Load" }],
      },
      {
        key: "final",
        label: "Final",
        steps: [{ key: "dispatch", label: "Dispatch" }],
      },
    ],
  };
  const template = await templateRef(conditional, "Conditional repeat");
  const created = await post("/api/workorders/create", {
    name: "South sea",
    template,
    groups: [],
    variants: { company: "south" },
    items: {},
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const global = partOf(workorderOf(created.body), "global");
  assert.deepEqual(
    global.checklist.steps.map((s) => s.path),
    ["final.dispatch"],
    "the excluded repeat contributed no items and no steps",
  );
});

test("a workorder instantiates a template's process and checks steps by path", async () => {
  const template = await templateRef();
  const workorder = await createWorkorder("Q3 delivery", template);

  assert.equal(workorder.name, "Q3 delivery");
  assert.equal(workorder.state, "running");
  const global = partOf(workorder, "global");
  assert.deepEqual(
    global.checklist.steps.map((s) => s.path),
    [
      "paperwork.ref",
      "paperwork.sign",
      "loading[CONT-1].load",
      "loading[CONT-1].seal",
      "final.dispatch",
    ],
    "the applicable steps are materialised from the process, repeats expanded",
  );
  assert.ok(
    global.checklist.steps.every(
      (s) => s.state === "open" && s.by === null && s.at === null,
    ),
    "every step starts open and unsigned",
  );
  assert.deepEqual(global.checklist.variants, { company: "north" });
  assert.deepEqual(global.checklist.items.loading, [
    { key: "CONT-1", data: { seal: "S-1" } },
  ]);

  // The groups are the template's rules resolved with the instance's choices.
  assert.deepEqual(
    global.groups.map((group) => group.key),
    ["paperwork", "loading", "final"],
  );
  const loading = global.groups.find((group) => group.key === "loading")!;
  assert.equal(loading.repeat, "Container", "a repeated section names what one item is");
  assert.equal(loading.items[0]!.key, "CONT-1");
  assert.deepEqual(
    loading.items[0]!.fields,
    [{ key: "seal", label: "Seal", value: "S-1" }],
    "the item's declared fields carry the data it was created with",
  );
  assert.deepEqual(
    loading.items[0]!.steps.map((s) => [s.path, s.label, s.state]),
    [
      ["loading[CONT-1].load", "Load the container", "open"],
      ["loading[CONT-1].seal", "Seal the container", "open"],
    ],
    "the label is read from the template revision, never copied onto the workorder",
  );
  assert.equal(global.templateTitle, "Packing checklist");

  const listed = await call("/api/workorders");
  assert.equal(listed.status, 200);
  assert.ok(
    ((listed.body?.workorders as Summary[] | undefined) ?? []).some(
      (w) => w.uid === workorder.uid,
    ),
    "the registry lists it",
  );

  const checked = await post("/api/workorders/check", {
    uid: workorder.uid,
    scope: "global",
    path: "paperwork.ref",
    state: "done",
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const step = stepAt(workorderOf(checked.body), "global", "paperwork.ref");
  assert.equal(step.state, "done");
  assert.equal(
    step.by,
    DEMO,
    "the signature is the authenticated caller, not the Master",
  );
  assert.ok(step.at, "and the instant");
});

test("a step is skipped or set not-applicable, with a note, by path", async () => {
  /*
   * `skipped` counts as complete (`isStepComplete`) — the job moves on with a
   * stated reason — while `not-applicable` is a step the case does not need,
   * dimmed and out of progress. Both carry the caller's note.
   */
  const template = await templateRef();
  const workorder = await createWorkorder("Disposable run", template);

  const skipped = await post("/api/workorders/check", {
    uid: workorder.uid,
    scope: "global",
    path: "loading[CONT-1].load",
    state: "skipped",
    note: "  pre-loaded by the supplier  ",
  });
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  const skippedStep = stepAt(workorderOf(skipped.body), "global", "loading[CONT-1].load");
  assert.equal(skippedStep.state, "skipped");
  assert.equal(isStepComplete("skipped"), true, "a skipped step counts as complete");
  assert.equal(skippedStep.note, "pre-loaded by the supplier", "the note is trimmed");

  const na = await post("/api/workorders/check", {
    uid: workorder.uid,
    scope: "global",
    path: "loading[CONT-1].seal",
    state: "not-applicable",
    note: "sealed upstream",
  });
  assert.equal(na.status, 200, JSON.stringify(na.body));
  const naStep = stepAt(workorderOf(na.body), "global", "loading[CONT-1].seal");
  assert.equal(naStep.state, "not-applicable");
  assert.equal(
    isStepComplete("not-applicable"),
    false,
    "a not-applicable step is out of progress",
  );
  assert.equal(naStep.note, "sealed upstream");
});

test("a condition on a variant drops its step from the instance", async () => {
  const template = await templateRef();
  const created = await post("/api/workorders/create", {
    name: "South run",
    template,
    groups: [],
    variants: { company: "south" },
    items: { loading: [{ key: "CONT-7" }] },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const global = partOf(workorderOf(created.body), "global");
  assert.deepEqual(
    global.checklist.steps.map((s) => s.path),
    ["paperwork.ref", "loading[CONT-7].load", "loading[CONT-7].seal", "final.dispatch"],
    "the step whose condition does not hold is never instantiated",
  );
});

test("a create that leaves a variant or a repeat undecided is refused", async () => {
  const template = await templateRef();

  const noVariant = await post("/api/workorders/create", {
    name: "Undecided",
    template,
    groups: [],
    items: { loading: [{ key: "CONT-1" }] },
  });
  assert.equal(noVariant.status, 400, JSON.stringify(noVariant.body));
  assert.equal(noVariant.body?.error, "workorder_choices_missing");

  const noItem = await post("/api/workorders/create", {
    name: "Undecided",
    template,
    groups: [],
    variants: { company: "north" },
  });
  assert.equal(noItem.status, 400, JSON.stringify(noItem.body));
  assert.equal(noItem.body?.error, "workorder_choices_missing");
});

test("checking a path the checklist does not hold is a 404", async () => {
  const template = await templateRef();
  const workorder = await createWorkorder("Bogus path", template);
  const checked = await post("/api/workorders/check", {
    uid: workorder.uid,
    scope: "global",
    path: "paperwork.nope",
    state: "done",
  });
  assert.equal(checked.status, 404, JSON.stringify(checked.body));
  assert.equal(checked.body?.error, "step_not_found");
});

test("closing a workorder moves its root to closed/ and keeps it", async () => {
  const template = await templateRef();
  const workorder = await createWorkorder("Closing run", template);

  const closed = await post("/api/workorders/close", {
    uid: workorder.uid,
    state: "completed",
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(workorderOf(closed.body).state, "completed");

  const read = await call(`/api/workorders/${workorder.uid}`);
  assert.equal(read.status, 200, "a closed workorder is kept, not destroyed");
  assert.equal((read.body?.workorder as Summary | undefined)?.state, "completed");
});

test("a workorder that does not exist is a 404", async () => {
  const missing = await call("/api/workorders/no-such-uid");
  assert.equal(missing.status, 404);
});

test("a check that keeps losing the compare-and-set reports its own failure", async () => {
  /*
   * `writeRootUnderCas` retries a lost compare-and-set once, then throws
   * `workorder_check_failed`. Before the fix the second attempt re-threw the
   * raw JMAP refusal, so the surface saw an upstream error rather than the
   * workorder's own code — the post-loop throw was unreachable.
   */
  const template = await templateRef();
  const workorder = await createWorkorder("Raced run", template);

  // The mock loses the next two conditional FileNode writes for the Master.
  mock.casLoses.forAddress = "gilbert@example.com";
  mock.casLoses.count = 2;
  try {
    const checked = await post("/api/workorders/check", {
      uid: workorder.uid,
      scope: "global",
      path: "paperwork.ref",
      state: "done",
    });
    assert.equal(checked.status, 502, JSON.stringify(checked.body));
    assert.equal(checked.body?.error, "workorder_check_failed");
  } finally {
    mock.casLoses.forAddress = "";
    mock.casLoses.count = 0;
  }
});

test("a closed workorder's checklist no longer changes", async () => {
  /*
   * A terminal state is kept for ever and the checklist is the record of the
   * work: checking a step afterwards would rewrite history. The guard reads the
   * root's state, so a part is covered by the same rule.
   */
  const template = await templateRef();
  const workorder = await createWorkorder("Sealed run", template);
  await post("/api/workorders/close", { uid: workorder.uid, state: "completed" });

  const checked = await post("/api/workorders/check", {
    uid: workorder.uid,
    scope: "global",
    path: "paperwork.ref",
    state: "done",
  });
  assert.equal(checked.status, 409, JSON.stringify(checked.body));
  assert.equal(checked.body?.error, "workorder_closed");
});
