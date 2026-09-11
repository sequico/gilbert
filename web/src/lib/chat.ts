/**
 * Group chat (ADR 0005): a text conversation per group mailbox, stored as
 * immutable JSON documents in the group account's own JMAP Files.
 *
 * Everything the group owns lives in the group's account -- chat included:
 * the `gilbert/chat` folder holds one node per message, and
 * `gilbert/chat-state` holds one read-marker per member. Membership is the
 * grant: a member's session on the group account reads and writes them, a
 * member added later sees the whole transcript from the start, and nothing is
 * shared out of a personal account.
 *
 * The format itself -- the document shapes, their validators and the pure
 * text helpers (mentions, replies, ordering, the context bound) -- is defined
 * once in `@gilbert/shared/chat`, because the agent worker reads and writes
 * the same documents from the server tier. This file is the client half: what
 * needs the browser's JMAP client and the FileNode tree. It re-exports the
 * shared half, so `@/lib/chat` stays the one import a view needs.
 */

import {
  CHAT_FOLDER,
  CHAT_STATE_FOLDER,
  type ChatMessage,
  isChatMessageDoc,
  MESSAGE_TYPE,
  messageFileName,
  messageProps,
} from "@gilbert/shared/chat";
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { ensureFolder, findInFolder } from "@/lib/appFolder";
import { directoryCreate, fileCreate } from "@/lib/filenode";

export * from "@gilbert/shared/chat";

/** The two chat folders under an account's `gilbert` app folder. */
export interface ChatFolders {
  chat: Id;
  state: Id;
}

/**
 * Find (or make) the chat folders in an account's app folder.
 *
 * Works for any account the session can write -- a member's own is not a chat
 * account, but a group account is exactly where the folders must live. The
 * app-folder lookup matches names client-side: Stalwart's FileNode/query
 * cannot filter by name (checked live 2026-08-27), and a filter it does not
 * know fails the whole query.
 */
export async function ensureChatFolders(accountId: Id): Promise<ChatFolders> {
  const app = await ensureFolder(accountId);
  const sub = async (name: string): Promise<Id> => {
    const existing = await findInFolder(accountId, app, name);
    if (existing && existing.parentId === app && existing.nodeType === "directory")
      return existing.id;
    const set = await client.call<SetResponse<FileNode>>("FileNode/set", {
      accountId,
      create: { d: directoryCreate(app, name) },
    });
    const err = set.notCreated?.d;
    if (err) throw new Error(setErrorMessage(err));
    return set.created!.d!.id;
  };
  const chat = await sub(CHAT_FOLDER);
  const state = await sub(CHAT_STATE_FOLDER);
  return { chat, state };
}

/** Fetch the text of a chat document node. */
export async function readDoc(accountId: Id, blobId: Id): Promise<unknown> {
  const text = await client.fetchBlobText(accountId, blobId, MESSAGE_TYPE);
  return JSON.parse(text) as unknown;
}

/**
 * Upload a JSON document and create it as a named file in a chat folder.
 *
 * One writer for every chat document (messages, markers): same upload, same
 * FileNode/set shape, same error formatter. The node's blobId is not asked
 * for here -- FileNode/set returns none on create and the callers re-fetch
 * the node (for its `created`) or the doc (for a marker) right after.
 */
export async function writeDoc(
  accountId: Id,
  folderId: Id,
  name: string,
  doc: object,
): Promise<Id> {
  const json = JSON.stringify(doc);
  const blob = new Blob([json], { type: MESSAGE_TYPE });
  const up = await client.upload(accountId, blob, { type: MESSAGE_TYPE });
  const set = await client.call<SetResponse<FileNode>>("FileNode/set", {
    accountId,
    create: { m: fileCreate(folderId, name, up.blobId, MESSAGE_TYPE) },
  });
  const err = set.notCreated?.m;
  if (err) throw new Error(setErrorMessage(err));
  const id = (set.created!.m as Partial<FileNode> | undefined)?.id;
  if (!id) throw new Error("chat document created without an id");
  return id;
}

/**
 * Create one message document under a random name and return its node id.
 * The caller fetches the node afterwards when it needs `created`.
 */
export function createDoc(accountId: Id, folderId: Id, doc: object): Promise<Id> {
  return writeDoc(accountId, folderId, messageFileName(), doc);
}

/**
 * Parse a list of file nodes into readable messages: files in the chat folder
 * whose JSON document is a valid message. Shared by the initial tail load,
 * the older-messages paging and the live re-sync -- one parser, one shape.
 */
export async function parseMessages(
  accountId: Id,
  nodes: Array<Pick<FileNode, "id" | "created" | "nodeType" | "blobId">>,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const node of nodes) {
    if (node.nodeType !== "file" || !node.blobId) continue;
    try {
      const doc = await readDoc(accountId, node.blobId);
      if (!isChatMessageDoc(doc)) continue;
      out.push({ id: node.id, created: node.created ?? "", ...doc });
    } catch {
      /* a node that is not a readable message is not part of the transcript */
    }
  }
  return out;
}

/** Fetch one message node and parse it, or null when it is not a message. */
export async function fetchMessage(
  accountId: Id,
  id: Id,
  chatFolderId: Id,
): Promise<ChatMessage | null> {
  const res = await client.call<GetResponse<FileNode>>("FileNode/get", {
    accountId,
    ids: [id],
    properties: messageProps(),
  });
  const node = res.list[0];
  if (!node || node.parentId !== chatFolderId || !node.blobId) return null;
  try {
    const doc: unknown = await readDoc(accountId, node.blobId);
    if (!isChatMessageDoc(doc)) return null;
    return { id, created: node.created ?? "", ...doc };
  } catch {
    return null; // a doc that does not parse is not a message we can show
  }
}
