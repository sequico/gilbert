import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "../testkit.js";

/**
 * A sibling's name, refused on both write paths.
 *
 * A real 0.16 runs `find_sibling_collision` on FileNode **create** and on
 * **update** alike (`crates/jmap/src/file/set.rs`, v0.16.21): a name a sibling
 * under the same parent already carries is refused `alreadyExists`, and the
 * node holding it is named in `existingId`. `onExists` defaults to `Reject`,
 * and the comparison is case-sensitive; `compareCaseInsensitively` is the
 * argument that widens it and nothing in Gilbert sends it.
 *
 * The client's rename and move are updates, so a mock that checked only creates
 * would let a rename onto a taken name look correct here that a live server
 * refuses. Both paths are pinned; each fails if its check is removed.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const HEADERS = { authorization: AUTH, "content-type": "application/json" };

type MethodCall = [string, Record<string, unknown>, string];

async function jmap(methodCalls: unknown[]): Promise<MethodCall[]> {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls,
    }),
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

/** Make a folder, and hand back its id. */
async function mkdir(name: string): Promise<string> {
  const responses = await jmap([
    [
      "FileNode/set",
      {
        accountId: ACCOUNT,
        create: { d: { name, nodeType: "directory", parentId: null } },
      },
      "d",
    ],
  ]);
  const created = responseOf(responses, "d")[1].created as Record<string, { id: string }>;
  return created.d!.id;
}

/** Every node's name, so a refused rename can be shown to have left it. */
async function nodeNames(): Promise<string[]> {
  const responses = await jmap([
    ["FileNode/get", { accountId: ACCOUNT, ids: null }, "g"],
  ]);
  return (responseOf(responses, "g")[1].list as Array<{ name: string }>).map(
    (n) => n.name,
  );
}

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("creating a node onto a sibling's name is refused", async () => {
  await mkdir("create-clash");

  const responses = await jmap([
    [
      "FileNode/set",
      {
        accountId: ACCOUNT,
        create: { d: { name: "create-clash", nodeType: "directory" } },
      },
      "c",
    ],
  ]);
  const res = responseOf(responses, "c")[1] as {
    notCreated?: Record<string, { type: string; existingId?: string }>;
  };
  assert.equal(res.notCreated?.d?.type, "alreadyExists");
});

test("renaming a node onto a sibling's name is refused on the update path", async () => {
  const held = await mkdir("update-clash-held");
  const renamed = await mkdir("update-clash-renamed");

  const responses = await jmap([
    [
      "FileNode/set",
      { accountId: ACCOUNT, update: { [renamed]: { name: "update-clash-held" } } },
      "u",
    ],
  ]);
  const res = responseOf(responses, "u")[1] as {
    updated?: Record<string, null>;
    notUpdated?: Record<string, { type: string; existingId?: string }>;
  };
  assert.equal(res.updated?.[renamed], undefined, "the rename did not land");
  assert.equal(res.notUpdated?.[renamed]?.type, "alreadyExists");
  assert.equal(
    res.notUpdated?.[renamed]?.existingId,
    held,
    "the node already holding the name is named",
  );
  assert.ok(
    (await nodeNames()).includes("update-clash-renamed"),
    "the name is unchanged",
  );
});

test("renaming a node to a free name is accepted", async () => {
  const node = await mkdir("update-free-before");

  const responses = await jmap([
    [
      "FileNode/set",
      { accountId: ACCOUNT, update: { [node]: { name: "update-free-after" } } },
      "u",
    ],
  ]);
  const res = responseOf(responses, "u")[1] as { updated?: Record<string, null> };
  assert.equal(res.updated?.[node], null);
  assert.ok((await nodeNames()).includes("update-free-after"));
});
