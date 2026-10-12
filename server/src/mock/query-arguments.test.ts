import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort, postWith } from "../testkit.js";

/**
 * The paging arguments a `/query` accepts.
 *
 * RFC 8620 §5.5 types `position` and `limit` as `UnsignedInt`, so a negative one
 * is not "a page from the end" — it is `invalidArguments`, which a real 0.16
 * server answers. The mock's `Email/query` and `FileNode/query` refused nothing
 * and let `Array.slice` read backwards, so a client developing against the mock
 * could ship a negative offset no server accepts. Pinned here, next to the
 * simulation that stands in for Stalwart.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-query-arguments";

const mock = await import("./index.js");
const { createApp } = await import("../app.js");

const app = createApp();
let cookie = "";

const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

type Body = ReturnType<typeof JSON.parse>;
type MethodCall = [string, Record<string, unknown>, string];

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Body }> {
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = postWith(call);

before(async () => {
  const res = await post("/api/auth/login", {
    username: "demo@example.com",
    password: "demo-password",
  });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** One query, returning the method response the batch carries for it. */
async function query(name: string, args: Record<string, unknown>): Promise<MethodCall> {
  const res = await post("/api/jmap", {
    using: [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:filenode",
    ],
    methodCalls: [[name, { accountId: "a1", ...args }, "q"]],
  });
  assert.equal(res.status, 200, `${name} should answer the batch`);
  const answered = ((res.body?.methodResponses ?? []) as MethodCall[]).find(
    (r) => r[2] === "q",
  );
  assert.ok(answered, `${name} should answer`);
  return answered;
}

for (const name of ["Email/query", "FileNode/query"]) {
  test(`${name} refuses a negative position, as RFC 8620 and Stalwart do`, async () => {
    const [method, body] = await query(name, { position: -1, limit: 10 });
    assert.equal(
      method,
      "error",
      "a negative position is refused, not sliced from the end",
    );
    assert.equal((body as { type?: string }).type, "invalidArguments");
  });

  test(`${name} refuses a negative limit`, async () => {
    const [method, body] = await query(name, { limit: -2 });
    assert.equal(method, "error");
    assert.equal((body as { type?: string }).type, "invalidArguments");
  });

  test(`${name} still serves a non-negative page`, async () => {
    const [method, body] = await query(name, { position: 0, limit: 1 });
    assert.equal(method, name);
    assert.ok(
      Array.isArray((body as { ids?: unknown }).ids),
      "the page carries an id list",
    );
  });
}
