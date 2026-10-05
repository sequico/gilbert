import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * A `/set` that names an id the account does not hold.
 *
 * RFC 8620 §5.3 answers `notUpdated`/`notDestroyed` with `notFound` for an id
 * the account does not have -- it is not a silent success. The mock's generic
 * `/set` used to skip a missing id without a word for both update and destroy,
 * so a client acting on a stale id looked correct here and would be refused on
 * a real server. Pinned here so a mock that stops modelling it fails this file.
 *
 * Mock port: must not collide with any other test file.
 */

const PORT = 18907;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const HEADERS = { authorization: AUTH, "content-type": "application/json" };
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"];

type MethodCall = [string, Record<string, unknown>, string];

async function jmap(methodCalls: unknown[]): Promise<MethodCall[]> {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ using: USING, methodCalls }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { methodResponses: MethodCall[] };
  return body.methodResponses;
}

const responseOf = (responses: MethodCall[], id: string): MethodCall => {
  const found = responses.find((r) => r[2] === id);
  assert.ok(found, `${id} should answer`);
  return found;
};

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("an update naming an id the account does not hold reports notFound", async () => {
  const responses = await jmap([
    [
      "FileNode/set",
      { accountId: ACCOUNT, update: { "missing-node": { name: "x" } } },
      "u",
    ],
  ]);
  const body = responseOf(responses, "u")[1] as {
    updated: Record<string, unknown>;
    notUpdated?: Record<string, { type: string }>;
  };
  assert.deepEqual(body.updated, {});
  assert.equal(body.notUpdated?.["missing-node"]?.type, "notFound");
});

test("a destroy naming an id the account does not hold reports notFound", async () => {
  const responses = await jmap([
    ["FileNode/set", { accountId: ACCOUNT, destroy: ["missing-node"] }, "d"],
  ]);
  const body = responseOf(responses, "d")[1] as {
    destroyed: string[];
    notDestroyed?: Record<string, { type: string }>;
  };
  assert.deepEqual(body.destroyed, []);
  assert.equal(body.notDestroyed?.["missing-node"]?.type, "notFound");
});
