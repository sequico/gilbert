import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The administration gate on the JMAP proxy (ADR 0014), end to end.
 *
 * Hiding the menu is not turning it off: `/api/jmap` forwards whatever the
 * browser sends, and Stalwart's registry answers whatever the credential's role
 * allows. So the two refusals a session which may not administer must meet are
 * made here — the installation turned administration off (`ADMINISTRATION=0`),
 * and a session signed in without "This is my own device".
 *
 * The control is the same request from a session that may administer: it must
 * still reach the registry, or the gate would be a wall in front of the product
 * rather than a door in front of the operator's decision.
 */

const PORT = 18821;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-admin-gate";
process.env.LOGIN_RATE_LIMIT = "10000";

const DEMO = "demo@example.com";
const DEMO_PASS = "demo-password";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> | null; cookie: string }> {
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
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

function login(remember: boolean) {
  return call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: DEMO_PASS, remember }),
  });
}

const jmap = (cookie: string, ...methods: string[]) =>
  call("/api/jmap", cookie, {
    method: "POST",
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core"],
      methodCalls: methods.map((m, i) => [m, {}, `c${i}`]),
    }),
  });

let ownDevice = "";

before(async () => {
  const res = await login(true);
  assert.equal(
    res.status,
    200,
    "sign-in on an own device should succeed against the mock",
  );
  ownDevice = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a session that may administer reaches the registry", async () => {
  const res = await jmap(ownDevice, "x:Account/query");
  assert.equal(
    res.status,
    200,
    "the gate must not stand in the way of a session that may administer",
  );
  const responses = (res.body as { methodResponses?: unknown[][] }).methodResponses ?? [];
  assert.notEqual(responses[0]?.[0], "error");
});

test("a session on a device that is not the person's own is refused, by name", async () => {
  const device = (await login(false)).cookie;
  const refused = await jmap(device, "x:Account/query");
  assert.equal(refused.status, 403);
  assert.equal(
    (refused.body as { error: string }).error,
    "administration_needs_own_device",
    "the refusal names the rule that stopped it",
  );
  assert.match((refused.body as { message: string }).message, /x:Account\/query/);
});

test("that session's ordinary mail still goes through", async () => {
  // The gate is about the registry, not about the product: a borrowed laptop
  // reads its mail.
  const device = (await login(false)).cookie;
  const res = await jmap(device, "Mailbox/get");
  assert.equal(res.status, 200);
});

test("that session's own account objects still go through", async () => {
  const device = (await login(false)).cookie;
  const res = await jmap(device, "x:AppPassword/get");
  assert.equal(res.status, 200);
});

test("a body that is not a JMAP request is a bad request, not a refusal about devices", async () => {
  const device = (await login(false)).cookie;
  const res = await call("/api/jmap", device, {
    method: "POST",
    body: '{"methodCalls": [{"x:',
  });
  assert.equal(res.status, 400);
});

test("the session says which of the two rules applies, so the menu can say why", async () => {
  const device = (await login(false)).cookie;
  const res = await call("/api/auth/session", device);
  const gilbert = (res.body as { gilbert?: Record<string, unknown> }).gilbert ?? {};
  assert.equal(gilbert.administration, false);
  assert.equal(gilbert.administrationNeedsOwnDevice, true);
  assert.equal(
    gilbert.isAdmin,
    true,
    "the Stalwart fact is still reported; it is not a grant",
  );
  const own = await call("/api/auth/session", ownDevice);
  const ownGilbert = (own.body as { gilbert?: Record<string, unknown> }).gilbert ?? {};
  assert.equal(ownGilbert.administration, true);
  assert.equal(ownGilbert.administrationNeedsOwnDevice, false);
});
