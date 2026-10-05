import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * Group chat on the mock (ADR 0005): a member writes message documents into
 * the group account's `gilbert/chat` folder over JMAP FileNode, the change
 * log answers `FileNode/changes`, and the event source announces the FileNode
 * state change the way a real 0.16 server does -- the rail another member's
 * client re-syncs from. This is the mock parity the chat store depends on.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);

const mock = await import("./mock/index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const GROUP_ACCOUNT = "a3"; // team@example.org in the demo session's accounts
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

async function jmap(methodCalls: unknown[]): Promise<unknown[]> {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"],
      methodCalls,
    }),
  });
  assert.equal(res.status, 200, "jmap call should succeed");
  const body = (await res.json()) as { methodResponses: unknown[] };
  return body.methodResponses;
}

async function upload(text: string): Promise<string> {
  const res = await fetch(`${BASE}/jmap/upload/${GROUP_ACCOUNT}/`, {
    method: "POST",
    headers: {
      authorization: AUTH,
      "content-type": "application/json",
      "x-requested-with": "gilbert",
    },
    body: text,
  });
  assert.equal(res.status, 200, "upload should succeed");
  const body = (await res.json()) as { blobId: string };
  return body.blobId;
}

async function setNodes(
  creates: Record<string, unknown>,
): Promise<Record<string, { id: string }>> {
  const [resp] = await jmap([
    ["FileNode/set", { accountId: GROUP_ACCOUNT, create: creates }, "0"],
  ]);
  const r = resp as [
    string,
    { created?: Record<string, { id: string }>; notCreated?: Record<string, unknown> },
    string,
  ];
  assert.equal(r[0], "FileNode/set");
  assert.ok(
    !r[1].notCreated,
    `create should not fail: ${JSON.stringify(r[1].notCreated)}`,
  );
  return r[1].created ?? {};
}

/**
 * The id of a directory by name under one parent, or null when it is not there.
 *
 * Read rather than remembered: the group account ships with a `gilbert` folder
 * of its own (the identity assignments live in it), so a test that created one
 * unconditionally would be asking for a second folder by a name already in use
 * -- which a real server refuses, and rightly.
 */
async function findDir(parentId: string | null, name: string): Promise<string | null> {
  const [resp] = await jmap([
    [
      "FileNode/query",
      {
        accountId: GROUP_ACCOUNT,
        filter: parentId ? { parentId } : { isTopLevel: true },
        limit: 1000,
      },
      "0",
    ],
  ]);
  const ids = (resp as [string, { ids: string[] }])[1].ids;
  if (!ids.length) return null;
  const [got] = await jmap([
    [
      "FileNode/get",
      { accountId: GROUP_ACCOUNT, ids, properties: ["id", "name", "nodeType"] },
      "0",
    ],
  ]);
  const list = (
    got as [string, { list: Array<{ id: string; name: string; nodeType: string }> }]
  )[1].list;
  const found = list.find((n) => n.nodeType === "directory" && n.name === name);
  return found?.id ?? null;
}

/** The same folder, made only when the account does not have one already. */
async function dir(parentId: string | null, name: string): Promise<string> {
  const existing = await findDir(parentId, name);
  if (existing) return existing;
  const made = await setNodes({ d: { parentId, name, nodeType: "directory" } });
  return made.d!.id;
}

let chatFolder = "";
let stateAfterFolders = "";

before(async () => {
  // The app folder and its chat subfolders, resolving the folders the account
  // already has rather than asking for a second of each name -- which is what
  // `ensureChatFolders` does in the group's own account.
  const appFolder = await dir(null, "gilbert");
  chatFolder = await dir(appFolder, "chat");
  await dir(appFolder, "chat-state");
  const [ch] = await jmap([
    ["FileNode/changes", { accountId: GROUP_ACCOUNT, sinceState: "0" }, "0"],
  ]);
  const changes = ch as [string, { newState: string }];
  stateAfterFolders = changes[1].newState;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a message written into the group chat folder shows up in FileNode/changes", async () => {
  const doc = JSON.stringify({
    v: 1,
    from: "demo@example.com",
    at: new Date().toISOString(),
    text: "hello from the mock test",
  });
  const blobId = await upload(doc);
  const made = await setNodes({
    m: {
      parentId: chatFolder,
      name: "m1.json",
      blobId,
      type: "application/json",
      nodeType: "file",
    },
  });
  const messageId = made.m!.id;

  // The re-sync rail: FileNode/changes from the state the client last saw
  // reports the new node and advances.
  const [resp] = await jmap([
    [
      "FileNode/changes",
      { accountId: GROUP_ACCOUNT, sinceState: stateAfterFolders },
      "0",
    ],
  ]);
  const changes = resp as [
    string,
    {
      oldState: string;
      newState: string;
      hasMoreChanges: boolean;
      created: string[];
      updated: string[];
      destroyed: string[];
    },
  ];
  assert.equal(changes[0], "FileNode/changes");
  assert.equal(changes[1].oldState, stateAfterFolders);
  assert.equal(changes[1].hasMoreChanges, false);
  assert.ok(changes[1].created.includes(messageId), "changes should report the message");
  assert.deepEqual(changes[1].updated, []);
  assert.deepEqual(changes[1].destroyed, []);

  // A second changes call from the new state is empty: the anchor advances.
  const [again] = await jmap([
    [
      "FileNode/changes",
      { accountId: GROUP_ACCOUNT, sinceState: changes[1].newState },
      "0",
    ],
  ]);
  const againChanges = again as [string, { created: string[] }];
  assert.deepEqual(againChanges[1].created, []);

  // The document round-trips: the node carries the blob and a server-side
  // created stamp (the ordering key the client sorts transcripts by).
  const [get] = await jmap([
    [
      "FileNode/get",
      {
        accountId: GROUP_ACCOUNT,
        ids: [messageId],
        properties: ["id", "parentId", "blobId", "created", "name"],
      },
      "0",
    ],
  ]);
  const got = get as [
    string,
    { list: Array<{ id: string; parentId: string; blobId: string; created: string }> },
  ];
  assert.equal(got[1].list[0]?.parentId, chatFolder);
  assert.ok(got[1].list[0]?.created, "node should carry a created stamp");
  const text = await (
    await fetch(
      `${BASE}/jmap/download/${GROUP_ACCOUNT}/${got[1].list[0]!.blobId}/m1.json?accept=application/json`,
      {
        headers: { authorization: AUTH },
      },
    )
  ).text();
  assert.deepEqual(JSON.parse(text), JSON.parse(doc));
});

test("a FileNode set announces a state change on the event source", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const es = await fetch(`${BASE}/jmap/eventsource/?types=*&closeafter=no&ping=30`, {
    headers: { authorization: AUTH },
    signal: controller.signal,
  });
  assert.equal(es.status, 200);
  const reader = es.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const seen = new Promise<string>((resolve) => {
    const pump = async () => {
      const { done, value } = await reader.read();
      buf += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const hit = buf.indexOf('"FileNode"');
      if (hit >= 0) resolve(buf.slice(Math.max(0, hit - 80), hit + 40));
      else if (!done) void pump();
      else resolve("");
    };
    void pump();
  });

  // Let the stream open, then write another message: the broadcast must reach
  // the open event source with the group account and the FileNode type.
  await new Promise((r) => setTimeout(r, 150));
  await upload(
    JSON.stringify({
      v: 1,
      from: "ada@example.org",
      at: new Date().toISOString(),
      text: "live",
    }),
  );
  await setNodes({
    m: {
      parentId: chatFolder,
      name: `live-${Date.now()}.json`,
      blobId: await upload(
        JSON.stringify({
          v: 1,
          from: "ada@example.org",
          at: new Date().toISOString(),
          text: "live",
        }),
      ),
      type: "application/json",
      nodeType: "file",
    },
  });

  const frame = await seen;
  clearTimeout(timer);
  controller.abort();
  assert.ok(
    frame.includes("FileNode"),
    `event source should announce FileNode: ${frame}`,
  );
  // The frame names the group account whose node changed.
  assert.ok(
    frame.includes(GROUP_ACCOUNT),
    `event source should name account ${GROUP_ACCOUNT}: ${frame}`,
  );
});

test("FileNode/query pages by position and reports the real total", async () => {
  // Three fresh messages, independent of the earlier tests' count.
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const doc = JSON.stringify({
      v: 1,
      from: "ada@example.org",
      at: new Date().toISOString(),
      text: `page ${i}`,
    });
    const blobId = await upload(doc);
    const made = await setNodes({
      m: {
        parentId: chatFolder,
        name: `page-${Date.now()}-${i}.json`,
        blobId,
        type: "application/json",
        nodeType: "file",
      },
    });
    ids.push(made.m!.id);
  }
  const q = async (position: number, limit: number) => {
    const responses = await jmap([
      [
        "FileNode/query",
        { accountId: GROUP_ACCOUNT, filter: { parentId: chatFolder }, position, limit },
        "0",
      ],
    ]);
    const first = responses[0] as [
      string,
      { ids: string[]; total: number; position: number },
    ];
    return first[1];
  };

  const before = await q(0, 0);
  const total = before.total;
  assert.ok(total >= 3, `total should include the three new messages: ${total}`);

  const first = await q(0, 2);
  assert.equal(first.ids.length, 2, "a limit-2 page returns two ids");
  assert.equal(first.total, total, "total is independent of the page");

  const second = await q(2, 10);
  assert.equal(
    second.ids.length,
    total - 2,
    "the second page holds everything from position 2 on",
  );
  // Paging is over the server's own order (insertion = creation order), and
  // the three fresh messages were appended last: they sit at the tail, so the
  // second page -- which reaches the end -- must contain all of them, in
  // their creation order.
  assert.deepEqual(
    second.ids.slice(second.ids.length - 3),
    ids,
    "the newest messages are the tail of the list",
  );
  // The two pages together cover every message exactly once, whichever end
  // they came from.
  const covered = new Set([...first.ids, ...second.ids]);
  assert.equal(covered.size, total, "the pages cover every message exactly once");
});
