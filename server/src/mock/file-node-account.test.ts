import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, type MethodCall, responseOf } from "../testkit.js";

/**
 * A node belongs to one account.
 *
 * The installation's memory is one store in the **Master's** account (ADR
 * 0037) while the runs that recall it live in each group's own — two accounts of
 * the same session — and the app folder is per account like everything else.
 * What makes "they are not the same tree" true is the server scoping a node to
 * the account it was created in, never a client that happens not to ask: a node
 * under one account is not listed, and not served by id, under the other's.
 *
 * Pinned so a node store that hands any account the same tree fails this file.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
/** a1, the demo (Master) account. */
const ACCOUNT = "a1";
/** a3, team@example.org, the group account the same session also holds. */
const GROUP_ACCOUNT = "a3";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const FILENODE = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"];
const jmap = (methodCalls: unknown[]) => jmapCall(BASE, AUTH, FILENODE, methodCalls);

/** One file node at the top level of an account's Files, holding a document. */
async function createNode(accountId: string, name: string): Promise<string> {
  const uploaded = await fetch(`${BASE}/jmap/upload/${accountId}/`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({ v: 1, id: name, subject: "who holds this tree" }),
  });
  assert.equal(uploaded.status, 200);
  const blobId = ((await uploaded.json()) as { blobId: string }).blobId;

  const created: MethodCall = responseOf(
    await jmap([
      [
        "FileNode/set",
        {
          accountId,
          create: {
            n: {
              parentId: null,
              name,
              blobId,
              type: "application/json",
              nodeType: "file",
            },
          },
        },
        "n",
      ],
    ]),
    "n",
  );
  const id = (created[1].created as Record<string, { id: string }>).n?.id;
  assert.ok(id, "the mock created the node");
  return id;
}

/** The ids at the top level of an account's Files. */
async function topLevel(accountId: string): Promise<string[]> {
  const answer = responseOf(
    await jmap([["FileNode/query", { accountId, filter: { isTopLevel: true } }, "q"]]),
    "q",
  );
  return answer[1].ids as string[];
}

/** One node by id, as one account reads it. */
async function readNode(accountId: string, id: string): Promise<MethodCall> {
  return responseOf(await jmap([["FileNode/get", { accountId, ids: [id] }, "g"]]), "g");
}

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a node is listed under the account that created it, and no other", async () => {
  const own = await createNode(ACCOUNT, "proof.json");
  const group = await createNode(GROUP_ACCOUNT, "proof.json");

  assert.ok((await topLevel(ACCOUNT)).includes(own), "an account lists its own node");
  assert.ok(
    !(await topLevel(ACCOUNT)).includes(group),
    "and not the group's, whose name it happens to share",
  );
  assert.ok((await topLevel(GROUP_ACCOUNT)).includes(group));
  assert.ok(!(await topLevel(GROUP_ACCOUNT)).includes(own));
});

test("a node is served by id only from its own account", async () => {
  const own = await createNode(ACCOUNT, "held.json");

  const here = await readNode(ACCOUNT, own);
  assert.equal((here[1].list as unknown[]).length, 1, "its own account is served it");

  const there = await readNode(GROUP_ACCOUNT, own);
  assert.deepEqual(there[1].list, [], "the group is not served the Master's node");
  assert.deepEqual(
    there[1].notFound,
    [own],
    "and the id is answered as not found rather than as another account's",
  );
});
