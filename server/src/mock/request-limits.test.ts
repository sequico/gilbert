import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "../testkit.js";

/**
 * The request limits the session advertises.
 *
 * A client sizes what it sends by them -- `maxCallsInRequest` is what the web
 * client chunks a batch by (`flush` in `web/src/jmap/client.ts`) -- so a server
 * that accepts more than it advertises leaves that chunking untested, and meets
 * a client with a request a real server refuses whole. The refusal is RFC 8620
 * §3.6.1's request-level `limit` error, naming the limit it applied, because
 * the limit is a property of the request and not of one call inside it.
 *
 * Each test reads the limit off the session first, so what this file pins is
 * that the number advertised and the number enforced are the same one.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const HEADERS = { authorization: AUTH, "content-type": "application/json" };
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

type CoreLimits = { maxCallsInRequest: number; maxSizeRequest: number };

/** The core limits the session advertises, read rather than assumed. */
async function coreLimits(): Promise<CoreLimits> {
  const res = await fetch(`${BASE}/.well-known/jmap`, {
    headers: { authorization: AUTH },
  });
  const session = (await res.json()) as {
    capabilities: { "urn:ietf:params:jmap:core": CoreLimits };
  };
  return session.capabilities["urn:ietf:params:jmap:core"];
}

/** A call that answers trivially, so a batch is only about its length. */
const call = (i: number) => ["Email/get", { accountId: ACCOUNT, ids: [] }, `c${i}`];

const post = (methodCalls: unknown[]) =>
  fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ using: USING, methodCalls }),
  });

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a batch longer than the server advertises is refused whole", async () => {
  const { maxCallsInRequest } = await coreLimits();
  const res = await post(
    Array.from({ length: maxCallsInRequest + 1 }, (_, i) => call(i)),
  );
  assert.equal(res.status, 400, "the request, not a method in it, is refused");
  const problem = (await res.json()) as { type: string; limit: string; status: number };
  assert.equal(problem.type, "urn:ietf:params:jmap:error:limit");
  assert.equal(problem.limit, "maxCallsInRequest");
  assert.equal(problem.status, 400);
});

test("a batch at the advertised limit is served", async () => {
  const { maxCallsInRequest } = await coreLimits();
  const res = await post(Array.from({ length: maxCallsInRequest }, (_, i) => call(i)));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { methodResponses: unknown[] };
  assert.equal(body.methodResponses.length, maxCallsInRequest);
});

test("a request larger than maxSizeRequest is refused", async () => {
  const { maxSizeRequest } = await coreLimits();
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: HEADERS,
    body: "x".repeat(maxSizeRequest + 1),
  });
  assert.equal(res.status, 400);
  const problem = (await res.json()) as { type: string; limit: string };
  assert.equal(problem.type, "urn:ietf:params:jmap:error:limit");
  assert.equal(problem.limit, "maxSizeRequest");
});
