import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * The property pair a `CalendarEvent/get` may not name together.
 *
 * `recurrenceOverrides` is the series' and `utcStart`/`utcEnd` are one
 * expansion's, so a 1.0 server refuses a read asking for both with
 * `invalidArguments` — and the refusal takes the whole call, every calendar
 * window with it. The mock answers the same way, so a client that puts the two
 * in one property list fails here instead of on a live server.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"];

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

async function read(properties: string[]) {
  const responses = await jmapCall(BASE, AUTH, USING, [
    ["CalendarEvent/get", { accountId: "a1", ids: null, properties }, "g"],
  ]);
  const [name, args] = responseOf(responses, "g");
  return { name, args: args as Record<string, unknown> };
}

test("recurrenceOverrides beside utcStart is refused, and the whole call with it", async () => {
  const { name, args } = await read(["id", "recurrenceOverrides", "utcStart"]);
  assert.equal(name, "error");
  assert.equal(args.type, "invalidArguments");
});

test("recurrenceOverrides beside utcEnd is refused too", async () => {
  const { name, args } = await read(["id", "recurrenceOverrides", "utcEnd"]);
  assert.equal(name, "error");
  assert.equal(args.type, "invalidArguments");
});

test("either half alone is read", async () => {
  for (const properties of [
    ["id", "recurrenceOverrides"],
    ["id", "utcStart", "utcEnd"],
  ])
    assert.equal((await read(properties)).name, "CalendarEvent/get");
});
