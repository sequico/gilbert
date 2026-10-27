import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * A header property's form, checked the way Stalwart 1.0 checks it.
 *
 * `header:List-Unsubscribe:asText` is a 0.16-era property that 1.0 refuses with
 * `invalidArguments`, and the refusal takes the whole `Email/get` with it — a
 * property list that grew up on 0.16 broke every read on 1.0. The mock answers
 * the same way, so a client that asks for a form a header does not admit fails
 * here instead of on a live server.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

const jmap = (methodCalls: unknown[]) => jmapCall(BASE, AUTH, USING, methodCalls);

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

async function read(properties: string[]) {
  const responses = await jmap([
    ["Email/get", { accountId: "a1", ids: null, properties }, "g"],
  ]);
  const [name, args] = responseOf(responses, "g");
  return { name, args: args as Record<string, unknown> };
}

test("a List header asked for as text is refused, and the whole call with it", async () => {
  const { name, args } = await read(["id", "header:List-Unsubscribe:asText"]);
  assert.equal(name, "error");
  assert.equal(args.type, "invalidArguments");
});

test("Received and Return-Path admit raw alone", async () => {
  for (const header of ["Received", "Return-Path"]) {
    const asked = await read(["id", `header:${header}:asText`]);
    assert.equal(asked.name, "error", `${header} as text is refused`);
    const raw = await read(["id", `header:${header}:asRaw`]);
    assert.equal(raw.name, "Email/get", `${header} as raw is read`);
  }
});

test("a header with no rule of its own admits any form", async () => {
  const any = await read(["id", "header:X-Spam-Status:asText"]);
  assert.equal(any.name, "Email/get");
  const list = await read(["id", "header:List-Unsubscribe:asRaw"]);
  assert.equal(list.name, "Email/get");
});
