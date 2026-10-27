import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * Stalwart 1.0's FileNode shape, and the older one refused.
 *
 * 1.0 names a node's kind `@type` (`File`/`Directory`/`SymLink`) and its MIME
 * `mediaType`, and a create or update that still carries `nodeType` or `type`
 * is refused `invalidProperties` naming them. That refusal is what stopped the
 * deployment on 1.0, so the mock reproduces it rather than repairing the call:
 * a mock that accepted both would let a tree that speaks 0.16 pass every test
 * here and fail on the server.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

const jmap = (methodCalls: unknown[]) => jmapCall(BASE, AUTH, USING, methodCalls);

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a create in 0.16's words is refused, naming the properties", async () => {
  const responses = await jmap([
    [
      "FileNode/set",
      { accountId: ACCOUNT, create: { d: { name: "old-shape", nodeType: "directory" } } },
      "s",
    ],
  ]);
  const refused = responseOf(responses, "s")[1] as {
    notCreated?: Record<string, { type: string; properties?: string[] }>;
  };
  assert.equal(refused.notCreated?.d?.type, "invalidProperties");
  assert.deepEqual(refused.notCreated?.d?.properties, ["nodeType"]);
});

test("a create in 1.0's words is written, and the read answers in them", async () => {
  const responses = await jmap([
    [
      "FileNode/set",
      {
        accountId: ACCOUNT,
        create: {
          n: { name: "new-shape.json", "@type": "File", mediaType: "application/json" },
        },
      },
      "s",
    ],
  ]);
  const created = responseOf(responses, "s")[1] as {
    created?: Record<string, { id: string }>;
    notCreated?: unknown;
  };
  assert.ok(!created.notCreated, "a 1.0 create is accepted");
  const id = created.created!.n!.id;

  const read = await jmap([
    [
      "FileNode/get",
      {
        accountId: ACCOUNT,
        ids: [id],
        properties: ["id", "name", "@type", "mediaType"],
      },
      "g",
    ],
  ]);
  const node = (responseOf(read, "g")[1].list as Array<Record<string, unknown>>)[0]!;
  assert.equal(node["@type"], "File");
  assert.equal(node.mediaType, "application/json");
  assert.ok(
    !("nodeType" in node) && !("type" in node),
    "the wire carries 1.0's names only",
  );
});

test("the filter's value is case-sensitive, as 1.0 matches it", async () => {
  const asked = async (value: string) => {
    const responses = await jmap([
      ["FileNode/query", { accountId: ACCOUNT, filter: { nodeType: value } }, "q"],
    ]);
    return (responseOf(responses, "q")[1].ids as string[]).length;
  };
  assert.ok((await asked("Directory")) > 0, "the wire's value finds the folders");
  assert.equal(await asked("directory"), 0, "the old lower-case value finds nothing");
});
