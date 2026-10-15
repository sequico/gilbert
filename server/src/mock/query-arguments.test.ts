import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort, jsonCall, postWith } from "../testkit.js";

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

const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

type Body = ReturnType<typeof JSON.parse>;
type MethodCall = [string, Record<string, unknown>, string];

const call = jsonCall<Body>(app, HEADERS);

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

for (const name of ["Email/query", "FileNode/query", "ContactCard/query"]) {
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

/**
 * A `/query` honours the filter and the page it was asked for.
 *
 * `ContactCard/query` answered every id in the account whatever was asked — no
 * filter, no paging, `position: 0` always. The client's `limit` was a fiction
 * against the mock, so paging was never exercised here; and the store lists one
 * address book at a time by `inAddressBook`, so a filter that a real server
 * applies was silently ignored and every book's cards came back together. Both
 * are the class this mock exists to catch: a client bug that passes in dev and
 * fails in production.
 */
test("ContactCard/query applies inAddressBook and returns a real page", async () => {
  const all = await query("ContactCard/query", { calculateTotal: true });
  const total = (all[1] as { total: number }).total;
  assert.ok(total > 1, "the demo account holds more than one card");

  const first = await query("ContactCard/query", { position: 0, limit: 1 });
  assert.equal((first[1] as { ids: string[] }).ids.length, 1);

  const second = await query("ContactCard/query", { position: 1, limit: 1 });
  assert.notDeepEqual(
    (second[1] as { ids: string[] }).ids,
    (first[1] as { ids: string[] }).ids,
    "a second page is a different page, not the same one again",
  );
  assert.equal(
    (second[1] as { position: number }).position,
    1,
    "and it says where it is",
  );

  /*
   * Everything the demo account holds is in one book, so `inAddressBook` cannot
   * narrow here — but it must still be consulted, and `text` is what shows the
   * difference: a filter a real server applies, which this handler used to
   * ignore while answering every card in the account.
   */
  const named = await query("ContactCard/query", {
    filter: { text: "Hopper" },
    calculateTotal: true,
  });
  const matched = (named[1] as { ids: string[] }).ids;
  assert.ok(matched.length > 0, "a name in the account is found");
  assert.ok(
    matched.length < total,
    "and the filter narrowed the answer rather than being ignored",
  );

  const empty = await query("ContactCard/query", {
    filter: { inAddressBook: "no-such-book" },
  });
  assert.deepEqual(
    (empty[1] as { ids: string[] }).ids,
    [],
    "a book nobody holds matches nothing",
  );
});
