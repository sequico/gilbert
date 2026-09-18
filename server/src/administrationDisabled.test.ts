import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * An installation that offers no administration at all (ADR 0017).
 *
 * This is the operator's switch, and the point of it is that it holds against
 * the browser rather than against the drawing of a menu: `/api/jmap` forwards
 * whatever the browser sends, so a deployment that said no must refuse the
 * registry at the proxy, and the `/api/admin` routes must refuse too — the
 * version of the product that only hid the menu would leave both open to a
 * console.
 *
 * The own-device rule is deliberately *not* set here, so this file also pins
 * that the default installation is unrestricted in that respect: an
 * administrator on a session that did not ask to be remembered keeps working.
 */

const PORT = 18866;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-administration-off";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.ADMINISTRATION = "0";

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

const jmap = (cookie: string, ...methods: string[]) =>
  call("/api/jmap", cookie, {
    method: "POST",
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core"],
      methodCalls: methods.map((m, i) => [m, {}, `c${i}`]),
    }),
  });

let cookie = "";

before(async () => {
  const res = await call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: DEMO_PASS }),
  });
  assert.equal(res.status, 200, "sign-in itself is unaffected by the switch");
  cookie = res.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the registry is refused at the proxy, and named", async () => {
  const res = await jmap(cookie, "x:Account/query");
  assert.equal(res.status, 403);
  assert.equal((res.body as { error: string }).error, "administration_disabled");
  assert.match((res.body as { message: string }).message, /x:Account\/query/);
});

test("an administrative route is refused too, not only the proxy", async () => {
  // The second door: hiding the menu would leave this route answering.
  const res = await call("/api/admin/force-password-change", cookie, {
    method: "POST",
    body: JSON.stringify({ target: "bob@example.com", clear: false }),
  });
  assert.equal(res.status, 403);
  assert.equal((res.body as { error: string }).error, "administration_disabled");
});

test("mail and the account's own objects are untouched", async () => {
  // The switch is about administration, not about the product.
  assert.equal((await jmap(cookie, "Mailbox/get")).status, 200);
  assert.equal((await jmap(cookie, "x:AppPassword/get")).status, 200);
});

test("the session says administration is off, and does not blame the device", async () => {
  const res = await call("/api/auth/session", cookie);
  const gilbert = (res.body as { gilbert?: Record<string, unknown> }).gilbert ?? {};
  assert.equal(gilbert.administration, false);
  assert.equal(
    gilbert.administrationNeedsOwnDevice,
    false,
    "the installation turned it off; the own-device rule was never asked for",
  );
  assert.equal(
    gilbert.isAdmin,
    true,
    "the Stalwart fact is still reported; it is not a grant",
  );
});
