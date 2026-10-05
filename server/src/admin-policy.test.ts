import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PublishJob, PublishOutcome } from "./app.js";
import { freePort } from "./testkit.js";

/**
 * The installation-wide policy document (ADR 0001, ADR 0001, ADR 0001):
 * only admins read or publish it; an invalid document is refused; a valid
 * publish writes into every individual account the directory lists — the
 * publisher's own account included — and each account's own authenticated
 * `GET /api/account/policy` answers with what the publish just wrote there.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-policy";
process.env.LOGIN_RATE_LIMIT = "10000";
// The installation under test names no agent, so the policy tests exercise the
// document with none in the environment.
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";
const BOB_PASS = "bob-password";

type Body = Record<string, unknown>;

interface AccountPolicy {
  policy: {
    defaults: Record<string, unknown>;
    enforced: Record<string, unknown>;
    changes: Array<{ version: string; settings: Record<string, unknown> }>;
  };
}

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");
const { readAccountPolicy, readPublishJob, PUBLISH_JOB_FILE } = await import(
  "./adminPolicy.js"
);
const { filesAccountId, readAppJsonAt } = await import("./appFolder.js");
const { fetchUpstreamSession } = await import("./upstream.js");

const BASE = `http://127.0.0.1:${PORT}`;
const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

/** One directory account, reached the way the publish reaches it: impersonation. */
async function impersonatedAs(
  address: string,
): Promise<{ ctx: import("./appFolder.js").Ctx; accountId: string }> {
  const authorization = `Basic ${Buffer.from(
    `${address}%${ADMIN}:${ADMIN_PASS}`,
  ).toString("base64")}`;
  const session = await fetchUpstreamSession(authorization, BASE);
  const ctx = { authorization, session, username: address };
  const accountId = filesAccountId(ctx);
  assert.ok(accountId, `${address}'s impersonated session has a Files account`);
  return { ctx, accountId };
}

/** The publishing administrator's own account, reached as themselves. */
async function ownAccount(): Promise<{
  ctx: import("./appFolder.js").Ctx;
  accountId: string;
}> {
  const authorization = `Basic ${Buffer.from(`${ADMIN}:${ADMIN_PASS}`).toString(
    "base64",
  )}`;
  const session = await fetchUpstreamSession(authorization, BASE);
  const ctx = { authorization, session, username: ADMIN };
  const accountId = filesAccountId(ctx);
  assert.ok(accountId, "the admin's own session has a Files account");
  return { ctx, accountId };
}

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
 * A second document, distinguishable from `DOC` field by field.
 *
 * The race below has to be able to say which of the two an account holds: a
 * refused write that left the policy readable is only visible against a
 * document a later publish would have replaced it with.
 */
const DOC2 = JSON.stringify(
  {
    defaults: { density: "compact" },
    enforced: { readingPane: true },
    changes: [{ version: "v2", settings: { autoAdvance: true } }],
  },
  null,
  2,
);

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
    "the editor document has the three sections",
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
  // No invalid publish reached the admin's own account either.
  const read = await call("/api/admin/policy", adminCookie);
  const policy = JSON.parse((read.body as { policy: string }).policy) as {
    enforced: Record<string, unknown>;
  };
  assert.equal(
    Object.keys(policy.enforced).length,
    0,
    "no invalid publish reached the running policy",
  );
});

test("a valid publish writes into the publisher's own account and every other one the directory lists", async () => {
  const res = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(res.status, 200);
  const outcome = (res.body as { outcome: PublishOutcome }).outcome;
  // The mock directory lists five people plus the agent principal, besides
  // the publishing admin itself: every one of them is reached, none refused,
  // and the count is set against the population the directory reported.
  assert.ok(
    outcome.reached.length >= 6,
    `expected at least 6 accounts reached, got ${outcome.reached.length}`,
  );
  assert.deepEqual(
    outcome.unreached,
    [],
    "nothing in the mock directory refused the write",
  );
  assert.ok(
    outcome.reached.length >= outcome.population.read,
    "every account the directory listed was written to",
  );
  assert.equal(
    outcome.complete,
    true,
    "the installation carries the policy, and the outcome says so",
  );

  // The publisher's own next read of the editor shows exactly what it wrote.
  const admin = await call("/api/admin/policy", adminCookie);
  const adminDoc = JSON.parse((admin.body as { policy: string }).policy) as {
    defaults: Record<string, unknown>;
    enforced: Record<string, unknown>;
  };
  assert.equal(adminDoc.enforced.readingPane, false);
  assert.equal(adminDoc.defaults.density, "cozy");

  // A directory account that never signs in (it has no password in this
  // mock) still has the publish in its own account -- verified the way the
  // administrator reaches it, by impersonation, rather than by signing in.
  const ada = await impersonatedAs("ada@example.org");
  const adaPolicy = await readAccountPolicy(ada.ctx, ada.accountId);
  assert.ok(adaPolicy, "the publish reached ada's own account");
  assert.equal(adaPolicy!.enforced.readingPane, false);
  assert.equal(adaPolicy!.defaults.density, "cozy");
  assert.equal(adaPolicy!.changes[0]!.version, "v1");

  // Bob is not part of this mock's enumerable directory (he exists only as a
  // separate impersonation-test target), so the publish does not reach him —
  // his own read falls back to the environment's bootstrap, unchanged.
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200);
  const bobPolicy = await call("/api/account/policy", bob.cookie);
  assert.equal(bobPolicy.status, 200);
  const sp = (bobPolicy.body as unknown as AccountPolicy).policy;
  assert.equal(
    sp.enforced.readingPane,
    undefined,
    "bob was never reached by this publish",
  );
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

test("a signed-in account with no publish yet reads the environment's bootstrap", async () => {
  // Bob has been reached by every publish above, so this only pins the shape
  // of the authenticated door itself: any signed-in account, not just an
  // admin, may read its own policy.
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200);
  const res = await call("/api/account/policy", bob.cookie);
  assert.equal(res.status, 200);
  const policy = (res.body as unknown as AccountPolicy).policy;
  assert.ok("defaults" in policy && "enforced" in policy && "changes" in policy);
});

test("a publish that could not read the directory says the installation does not carry the policy", async () => {
  /*
   * The directory is how a publish learns who exists. A server that refuses the
   * listing is not an error in the publish: it is an installation whose policy
   * reached only the publisher's own account, and the outcome has to say that
   * rather than count one success and call it a publish.
   */
  mock.directoryGate.open = false;
  try {
    const res = await call("/api/admin/policy", adminCookie, {
      method: "POST",
      body: DOC,
    });
    assert.equal(res.status, 200);
    const outcome = (res.body as { outcome: PublishOutcome }).outcome;
    assert.equal(outcome.population.read, 0, "no account was listed");
    assert.equal(outcome.population.complete, false);
    assert.equal(
      outcome.complete,
      false,
      "the installation carries the policy only when every listed account does",
    );
    assert.ok(
      outcome.directory,
      "what the server said when it refused the listing is carried, not swallowed",
    );
    assert.ok(
      outcome.reached.includes(ADMIN),
      "the publisher's own account was still written, and the outcome says which",
    );
  } finally {
    mock.directoryGate.open = true;
  }
});

test("a publish is a job: the account holds it, and the copies carry its id", async () => {
  /*
   * The answer and the record are one document. The publish mints an id, the
   * copies it writes into every account name it, and a later read of this
   * surface answers the job the account holds rather than anything this
   * process remembers -- which is what makes the answer survive a restart.
   */
  const before = await call("/api/admin/policy", adminCookie);
  const previous = (before.body as unknown as { job: PublishJob | null }).job;

  const res = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(res.status, 200);
  const answered = res.body as unknown as { outcome: PublishOutcome; job: PublishJob };
  const { outcome, job } = answered;
  assert.ok(job.id, "the publish minted an id");
  assert.notEqual(
    job.id,
    previous?.id ?? null,
    "a publish is a new job, not the last one's record with a new answer",
  );
  assert.equal(job.by, ADMIN, "the job names who published");
  assert.ok(!Number.isNaN(Date.parse(job.startedAt)), "and when it started, as a time");
  assert.deepEqual(outcome, job, "the response is that job");

  // One document, in the publisher's own app folder, under its own name.
  assert.equal(PUBLISH_JOB_FILE, "publish-job.json");
  const own = await ownAccount();
  assert.deepEqual(
    await readAppJsonAt(own.ctx, own.accountId, "publish-job.json"),
    job,
    "the app folder holds the job the publish answered with",
  );
  assert.deepEqual(
    await readPublishJob(own.ctx, own.accountId),
    job,
    "and the reader the surface uses finds that same one",
  );

  // Every copy says which publish put it there.
  const ada = await impersonatedAs("ada@example.org");
  const adaPolicy = await readAccountPolicy(ada.ctx, ada.accountId);
  assert.ok(adaPolicy, "the publish reached ada's own account");
  assert.equal(
    adaPolicy!.published?.id,
    job.id,
    "her copy names the publish that wrote it",
  );
  assert.equal(adaPolicy!.published?.at, job.startedAt, "…and when it started");

  // And a later read of the administration surface answers the same job.
  const read = await call("/api/admin/policy", adminCookie);
  const reread = (read.body as unknown as { job: PublishJob | null }).job;
  assert.ok(reread, "the surface reads the job back");
  assert.equal(reread!.id, job.id, "the same job, by id");
  assert.equal(reread!.startedAt, job.startedAt);
  assert.equal(reread!.by, job.by);
  assert.deepEqual(
    reread!.population,
    outcome.population,
    "population: outcome and job agree",
  );
  assert.deepEqual(reread!.reached, outcome.reached, "reached: outcome and job agree");
  assert.deepEqual(
    reread!.unreached,
    outcome.unreached,
    "unreached: outcome and job agree",
  );
  assert.equal(reread!.complete, outcome.complete, "complete: outcome and job agree");
});

test("a fresh read of the administration surface still finds the job", async () => {
  /*
   * Nothing about the job is in the process that made it. A second app
   * instance -- a restart, another replica behind the same name -- signs in and
   * reads back the very job the publish answered with, because the account
   * holds it.
   */
  const res = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(res.status, 200);
  const job = (res.body as unknown as { job: PublishJob }).job;

  const restarted = createApp();
  const signedIn = await restarted.request("/api/auth/login", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ username: ADMIN, password: ADMIN_PASS }),
  });
  assert.equal(signedIn.status, 200, "the fresh instance can sign the admin in");
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const reread = await restarted.request("/api/admin/policy", {
    headers: { ...HEADERS, cookie },
  });
  assert.equal(reread.status, 200);
  const body = (await reread.json()) as { policy: string; job: PublishJob | null };
  assert.ok(body.job, "the restarted instance finds the job");
  assert.equal(body.job!.id, job.id);
  assert.equal(body.job!.startedAt, job.startedAt);
  assert.equal(body.job!.by, job.by);
  assert.deepEqual(body.job!.population, job.population);
  assert.deepEqual(body.job!.reached, job.reached);
  assert.deepEqual(body.job!.unreached, job.unreached);
  assert.equal(body.job!.complete, job.complete);
  // The editor's own reader is untouched by the job riding beside it.
  const editor = JSON.parse(body.policy) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(editor).sort(),
    ["changes", "defaults", "enforced"],
    "the editor document is still the three sections",
  );
});

test("an account whose folder moves under the publish is named, and keeps the copy it had", async () => {
  /*
   * A conditional write that loses its race is not a write. The account keeps
   * the document the publish before it installed, the publish does not claim an
   * account it did not write, and it does not call itself complete -- which is
   * the claim an administrator is being asked to believe.
   *
   * The race is the mock's (`casLoses`): the folder moves as the conditional
   * write arrives, exactly as a real folder somebody else wrote to moves. The
   * account is the agent principal's own, because the mock sends that one to a
   * Files account of its own: every other directory account shares the demo's
   * account in this fixture, where a later write in the same publish would
   * rewrite the very document the assertion below is about.
   */
  const first = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: DOC,
  });
  assert.equal(first.status, 200);
  const firstJob = (first.body as unknown as { job: PublishJob }).job;
  assert.equal(firstJob.complete, true, "the publish before the race reached everybody");

  const agent = await impersonatedAs(mock.AGENT_ADDRESS);
  const installed = await readAccountPolicy(agent.ctx, agent.accountId);
  assert.ok(installed, "the agent's own account carries that publish");
  assert.equal(installed!.published?.id, firstJob.id);
  assert.equal(installed!.enforced.readingPane, false);

  const raced = await (async () => {
    mock.casLoses.forAddress = mock.AGENT_ADDRESS;
    mock.casLoses.count = 1;
    try {
      return await call("/api/admin/policy", adminCookie, {
        method: "POST",
        body: DOC2,
      });
    } finally {
      mock.casLoses.forAddress = "";
      mock.casLoses.count = 0;
    }
  })();
  assert.equal(raced.status, 200, "a write that lost its race is not a failed publish");
  const answered = raced.body as unknown as { outcome: PublishOutcome; job: PublishJob };
  const moved = answered.outcome.unreached.find(
    (one) => one.address === mock.AGENT_ADDRESS,
  );
  assert.ok(moved, "the account is named rather than left out of the answer");
  assert.equal(
    moved!.code,
    "policy-moved",
    "with its own code: the folder moved and nothing was written",
  );
  assert.ok(moved!.message.length > 0, "and the server's own words come with it");
  assert.ok(
    !answered.outcome.reached.includes(mock.AGENT_ADDRESS),
    "the publish claims no account it did not write",
  );
  assert.equal(
    answered.outcome.complete,
    false,
    "one account short of the directory is not an installation that carries the policy",
  );
  assert.equal(answered.job.complete, false, "and the job it recorded says the same");

  // The record agrees with the answer, read back from the account.
  const read = await call("/api/admin/policy", adminCookie);
  const job = (read.body as unknown as { job: PublishJob | null }).job;
  assert.ok(job, "the surface reads the job back");
  assert.deepEqual(job!.unreached, answered.outcome.unreached);
  assert.equal(job!.complete, false);

  // The refused write left the account with the copy it really came from.
  const after = await readAccountPolicy(agent.ctx, agent.accountId);
  assert.ok(after, "the account is still readable after the refused write");
  assert.equal(
    after!.published?.id,
    firstJob.id,
    "…holding the publish that did reach it, not the one that lost",
  );
  assert.equal(
    after!.enforced.readingPane,
    false,
    "…and not the document the lost race was writing",
  );
  assert.deepEqual(after!.defaults, { density: "cozy" });
  assert.deepEqual(
    after!.changes.map((change) => change.version),
    ["v1"],
  );
});
