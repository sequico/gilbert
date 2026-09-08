import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * Group chat on the mock (ADR 0006): a member writes message documents into
 * the group account's `gilbert/chat` folder over JMAP FileNode, the change
 * log answers `FileNode/changes`, and the event source announces the FileNode
 * state change the way a real 0.16 server does -- the rail another member's
 * client re-syncs from. This is the mock parity the chat store depends on.
 */

const PORT = 18804;
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

let chatFolder = "";
let stateAfterFolders = "";

before(async () => {
  // The app folder and its chat subfolders, exactly as the client's
  // ensureChatFolders makes them in the group's own account.
  const dirs = await setNodes({
    app: { parentId: null, name: "gilbert", nodeType: "directory" },
  });
  const appFolder = dirs.app!.id;
  const sub = await setNodes({
    chat: { parentId: appFolder, name: "chat", nodeType: "directory" },
    state: { parentId: appFolder, name: "chat-state", nodeType: "directory" },
  });
  chatFolder = sub.chat!.id;
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
