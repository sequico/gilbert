import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * Stalwart's directory query, as the mock stands in for it: `Principal/query`
 * serves the page `position`/`limit` ask for, answers `total` when
 * `calculateTotal` asks for it, and the whole request is refused with 403 when
 * `allow_directory_query` is closed for the session.
 *
 * The published installation policy fans out over exactly this read, so the
 * three of them decide whether a publish reaches every account of an
 * installation larger than one page. Confirmed live on 0.16.23 (2026-09-24):
 * `position`/`limit` and `calculateTotal` are honoured, the walk reaches the
 * end with a `total` that names the population, and a `limit` above the
 * ceiling is served rather than refused
 * (`scripts/probe-directory-paging.mjs`). What the probe did not ask is a
 * credential outside the directory gate — whether a closed
 * `allow_directory_query` answers 400 or 403 and whether the refusal is the
 * whole request or one refused method call; the mock keeps modelling the 403
 * the code already reads.
 *
 * Mock port: must not collide with any other test file -- the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 18805;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_REFUSED_USER = "carol@example.com";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-directory-paging";
process.env.LOGIN_RATE_LIMIT = "10000";
// The installation under test names no agent, so the publish's fan-out
// consults the directory alone.
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
/** The principal the mock lists and will not seal a session onto. */
const REFUSED = "carol@example.com";
const ACCOUNT = "a1";

const mock = await import("./index.js");
const { fetchDirectoryUsers, fetchUpstreamSession } = await import("../upstream.js");
const { createApp } = await import("../app.js");
const { readAccountPolicy } = await import("../adminPolicy.js");
const { filesAccountId } = await import("../appFolder.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from(`${ADMIN}:${ADMIN_PASS}`).toString("base64")}`;

type Obj = Record<string, unknown>;
type MethodCall = [string, Obj, string];
type DirectoryRead = Awaited<ReturnType<typeof fetchDirectoryUsers>>;

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function jmap(
  authorization: string,
  methodCalls: unknown[],
): Promise<{ status: number; responses: MethodCall[] }> {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"],
      methodCalls,
    }),
  });
  const text = await res.text();
  return {
    status: res.status,
    responses: text ? (JSON.parse(text).methodResponses as MethodCall[]) : [],
  };
}

/** One Principal/query, as the client sends it. */
async function query(args: Obj): Promise<Obj> {
  const { responses } = await jmap(AUTH, [
    ["Principal/query", { accountId: ACCOUNT, ...args }, "q"],
  ]);
  const [name, body] = responses[0] ?? ["", {}];
  assert.equal(name, "Principal/query", "the mock answered the query");
  return body;
}

const idsOf = (body: Obj): string[] => (body.ids as string[] | undefined) ?? [];

/**
 * The users of a directory read, failing the test when the read was refused.
 * The cast is what the assertion above it has just established.
 */
function usersOf(read: DirectoryRead): Extract<DirectoryRead, { users: unknown }> {
  assert.ok(
    !("denied" in read),
    `the directory read was refused: ${JSON.stringify(read)}`,
  );
  return read as Extract<DirectoryRead, { users: unknown }>;
}

async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Obj | null; cookie: string }> {
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
    body: text ? (JSON.parse(text) as Obj) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

const session = await fetchUpstreamSession(AUTH, BASE);
let adminCookie = "";

before(async () => {
  const res = await call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username: ADMIN, password: ADMIN_PASS }),
  });
  assert.equal(res.status, 200, "the admin signs in against the mock");
  adminCookie = res.cookie;
});

after(() => {
  mock.server.close();
});

test("a query serves the page it was asked for, at the offset it was asked for", async () => {
  const all = idsOf(await query({}));
  assert.equal(all.length, 9, "five people, the refused account, two groups, the agent");

  assert.deepEqual(idsOf(await query({ limit: 2 })), all.slice(0, 2));
  const second = await query({ limit: 2, position: 2 });
  assert.deepEqual(idsOf(second), all.slice(2, 4));
  assert.equal(second.position, 2, "the page says which offset it began at");
  assert.equal(
    "total" in second,
    false,
    "the population is answered only when the caller asks for it",
  );
  // A limit above what the directory holds is not a refusal: the page is cut
  // at the ids there are, which is how a reader learns the end is reached.
  assert.deepEqual(idsOf(await query({ limit: 500 })), all);
});

test("calculateTotal reports the matched population, and the pages add up to it", async () => {
  const all = idsOf(await query({}));
  const counted = await query({ limit: 3, calculateTotal: true });
  assert.equal(counted.total, all.length);

  const walked: string[] = [];
  for (let position = 0; position <= all.length; position += 3) {
    const page = await query({ limit: 3, position });
    // The page past the end is empty: that is the termination rule a reader
    // that cannot ask for the population relies on.
    if (position === all.length) assert.deepEqual(idsOf(page), []);
    walked.push(...idsOf(page));
  }
  assert.deepEqual(walked, all, "the walk covers the directory once");

  assert.deepEqual(idsOf(await query({ position: 99 })), [], "past the end is empty");
  assert.deepEqual(idsOf(await query({ position: -2 })), all.slice(-2));
  assert.deepEqual(idsOf(await query({ limit: 3, position: 7 })), all.slice(7));
  const individuals = await query({
    filter: { type: "individual" },
    calculateTotal: true,
  });
  assert.equal(
    individuals.total,
    7,
    "the filter is applied before the population is counted",
  );
  assert.equal(idsOf(individuals).length, 7);
});

test("a directory larger than one page reads whole, and says so", async () => {
  const small = usersOf(await fetchDirectoryUsers(AUTH, session));
  assert.equal(small.complete, true);
  assert.equal(small.total, 9);
  assert.equal(small.users.length, 7, "five people, the refused account and the agent");

  // The session advertises maxObjectsInGet 500, so a reader that gathered
  // every id and asked for them in one get would be refused by the real
  // server; 1200 pads is a directory that is both past a thousand principals
  // and past what one get may carry.
  const pads = Array.from({ length: 1200 }, (_, i) => ({
    id: `pr-pad-${i}`,
    type: "individual",
    name: `Account ${i}`,
    description: null,
    email: `account${i}@example.org`,
    timeZone: "UTC",
  }));
  mock.principals.push(...pads);
  try {
    const big = usersOf(await fetchDirectoryUsers(AUTH, session));
    assert.equal(big.complete, true, "the read reached the end of the directory");
    assert.equal(big.total, 1209, "and the server's own population is what it reports");
    assert.equal(
      big.users.length,
      1207,
      "every individual principal, not one page of them",
    );
    assert.ok(
      big.users.some((u) => u.name === "account1199@example.org"),
      "including the last one the directory holds",
    );
    assert.ok(big.users.some((u) => u.name === REFUSED));
  } finally {
    mock.principals.splice(9, 1200);
  }
  const after = usersOf(await fetchDirectoryUsers(AUTH, session));
  assert.equal(after.users.length, 7, "the pads are gone again");
});

test("a closed directory gate is refused as a refused read, not as a failure", async () => {
  mock.directoryGate.open = false;
  try {
    const { status, responses } = await jmap(AUTH, [
      ["Principal/query", { accountId: ACCOUNT, limit: 2 }, "q"],
    ]);
    assert.equal(status, 403, "the request carrying the query is refused");
    /*
     * A refusal is a body with no method responses at all -- not one that
     * carries an empty list, which no real refusal does. What the test pins is
     * the guarantee: nothing answered.
     */
    assert.deepEqual(responses ?? [], [], "and no method answered inside it");

    const denied = await fetchDirectoryUsers(AUTH, session);
    assert.ok("denied" in denied, "the client's read degrades instead of throwing");
    assert.ok(!("users" in denied), "no partial list is claimed");
  } finally {
    mock.directoryGate.open = true;
  }
  const open = usersOf(await fetchDirectoryUsers(AUTH, session));
  assert.equal(open.users.length, 7, "the read answers again once the gate is open");
});

test("one account the server will not seal a session onto is named, the rest are written", async () => {
  // The refused principal sits before the agent principal in the directory, so
  // a fan-out that stopped at the refusal would leave the agent's own account
  // without the policy -- which is the difference this test reads.
  const directory = usersOf(await fetchDirectoryUsers(AUTH, session));
  assert.ok(
    directory.users.some((u) => u.name === REFUSED),
    "the directory lists the account the mock refuses to impersonate",
  );

  const doc = JSON.stringify({
    defaults: { density: "cozy" },
    enforced: { readingPane: false },
    changes: [{ version: "v1", settings: { autoAdvance: false } }],
  });
  const published = await call("/api/admin/policy", adminCookie, {
    method: "POST",
    body: doc,
  });
  assert.equal(published.status, 200);
  /*
   * The answer is the publish's outcome: the population the directory was read
   * as, the accounts the policy reached, and the ones it did not with the
   * reason for each -- never a count of successes that reads as a publish.
   */
  const body = published.body as unknown as {
    outcome: {
      population: { read: number; complete: boolean; total: number | null };
      reached: string[];
      unreached: Array<{ address: string; code: string; message: string }>;
      complete: boolean;
    };
  };
  assert.deepEqual(
    body.outcome.unreached.map((one) => one.address),
    [REFUSED],
    "the one refusal is named, and it is the account the mock would not seal",
  );
  assert.equal(
    body.outcome.unreached[0]?.code,
    "impersonation-refused",
    "and the reason travels as the code the client composes a sentence from",
  );
  assert.ok(
    (body.outcome.unreached[0]?.message.length ?? 0) > 0,
    "the refusal carries the message the administrator sees",
  );
  assert.equal(
    body.outcome.complete,
    false,
    "one account short of the directory is not an installation carrying the policy",
  );
  // Six of the seven listed accounts are not the refused one -- five people
  // and the agent -- and the publishing admin's own account makes seven.
  assert.equal(body.outcome.reached.length, 7, "every other account was reached");

  const agentAuth = `Basic ${Buffer.from(`gilbert@example.com%${ADMIN}:${ADMIN_PASS}`).toString("base64")}`;
  const agentSession = await fetchUpstreamSession(agentAuth, BASE);
  const agentCtx = {
    authorization: agentAuth,
    session: agentSession,
    username: "gilbert@example.com",
  };
  const agentAccount = filesAccountId(agentCtx);
  assert.ok(agentAccount, "the agent's impersonated session has a Files account");
  const agentPolicy = await readAccountPolicy(agentCtx, agentAccount);
  assert.ok(agentPolicy, "the account after the refusal holds the policy");
  assert.equal(agentPolicy!.enforced.readingPane, false);
  assert.equal(agentPolicy!.defaults.density, "cozy");

  const listed = await call("/api/admin/users", adminCookie);
  assert.equal(listed.status, 200);
  const names = (listed.body as unknown as { users: Array<{ name: string }> }).users.map(
    (u) => u.name,
  );
  assert.ok(names.includes(REFUSED), "the Users surface lists it too");
});
