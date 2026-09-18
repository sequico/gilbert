import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * Destroying a folder that still holds something.
 *
 * A merge destroys a folder it **emptied** -- everything of it has moved into
 * the folder being kept, or had its bytes written into the node that already
 * held the name -- and it therefore sends no `onDestroyRemoveChildren`. The
 * Files view's own Delete does send it, because taking a folder's contents with
 * it is what the reader asked for there.
 *
 * Two behaviours of a real 0.16 are pinned here, and both are assumptions the
 * client's merge rests on:
 *
 *   - a destroy of a **folder** that still holds something is refused when the
 *     call does not cascade, so a merge that left a file behind stops with its
 *     source folder standing rather than destroying a file nobody asked it to;
 *   - a destroy of a folder that is **empty** is accepted, cascade or not,
 *     which is what lets the merge's last step succeed at all.
 *
 * The refusal is read off the client's own habit of sending the flag rather than
 * off a server that was asked, so it is owed as a live probe in `KNOWN-ISSUES.md`
 * -- and pinned here so that a mock which stopped modelling it fails this file
 * rather than letting the merge look correct against a server that would have
 * accepted anything.
 *
 * Mock port: must not collide with any other test file -- the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 18846;
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
async function mkdir(name: string, parentId: string | null = null): Promise<string> {
  const responses = await jmap([
    [
      "FileNode/set",
      { accountId: ACCOUNT, create: { d: { name, nodeType: "directory", parentId } } },
      "d",
    ],
  ]);
  const created = responseOf(responses, "d")[1].created as Record<string, { id: string }>;
  return created.d!.id;
}

/** Every node of the account, so a refused destroy can be shown to have left it. */
async function nodeNames(): Promise<string[]> {
  const responses = await jmap([
    ["FileNode/get", { accountId: ACCOUNT, ids: null }, "g"],
  ]);
  return (responseOf(responses, "g")[1].list as Array<{ name: string }>)
    .map((n) => n.name)
    .sort();
}

const destroy = async (ids: string[], cascade = false) => {
  const responses = await jmap([
    [
      "FileNode/set",
      {
        accountId: ACCOUNT,
        destroy: ids,
        ...(cascade ? { onDestroyRemoveChildren: true } : {}),
      },
      "x",
    ],
  ]);
  return responseOf(responses, "x")[1] as {
    destroyed: string[];
    notDestroyed?: Record<string, { type: string }>;
  };
};

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a folder that still holds something is refused when the destroy does not cascade", async () => {
  const outer = await mkdir("cascade-full");
  await mkdir("cascade-inner", outer);

  const res = await destroy([outer]);

  assert.deepEqual(res.destroyed, []);
  assert.equal(res.notDestroyed?.[outer]?.type, "forbidden");
  // And it is still there, with what was in it.
  assert.ok((await nodeNames()).includes("cascade-full"));
  assert.ok((await nodeNames()).includes("cascade-inner"));
});

test("an emptied folder is destroyed without the flag, which is the merge's last step", async () => {
  const outer = await mkdir("cascade-empty");
  const inner = await mkdir("cascade-child", outer);
  // Take the child away first: the folder is now empty, which is the state a
  // merge leaves its source folder in.
  assert.deepEqual((await destroy([inner])).destroyed, [inner]);

  const res = await destroy([outer]);

  assert.deepEqual(res.destroyed, [outer]);
  assert.equal(res.notDestroyed, undefined);
  assert.ok(!(await nodeNames()).includes("cascade-empty"));
});

test("a folder that holds something goes with its contents when the call asks it to", async () => {
  const outer = await mkdir("cascade-take-all");
  await mkdir("cascade-taken", outer);

  const res = await destroy([outer], true);

  assert.deepEqual(res.destroyed, [outer]);
  assert.ok(!(await nodeNames()).includes("cascade-take-all"));
  assert.ok(!(await nodeNames()).includes("cascade-taken"));
});
