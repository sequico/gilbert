/**
 * Group chat (ADR 0006): a text conversation per group mailbox, stored as
 * immutable JSON documents in the group account's own JMAP Files.
 *
 * Everything the group owns lives in the group's account -- chat included:
 * the `gilbert/chat` folder holds one node per message, and
 * `gilbert/chat-state` holds one read-marker per member. Membership is the
 * grant: a member's session on the group account reads and writes them, a
 * member added later sees the whole transcript from the start, and nothing is
 * shared out of a personal account.
 */
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { ensureFolder, findInFolder } from "@/lib/appFolder";
import { directoryCreate, fileCreate } from "@/lib/filenode";

export const CHAT_FOLDER = "chat";
export const CHAT_STATE_FOLDER = "chat-state";
export const MESSAGE_TYPE = "application/json";

/** Messages are plain text; the bound keeps the documents small (ADR 0006). */
export const MAX_TEXT = 4000;

/** How many messages one transcript page holds (scroll-up paging). */
export const CHAT_PAGE = 200;

/** The local part of an address — the chat's short display name. */
export function shortName(address: string): string {
  const at = address.indexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

/** A principal a message is addressed to, by mention. */
export interface ChatMention {
  kind: "principal";
  /** The principal's address — the chat's identity, the same string as `from`. */
  id: string;
}

/** One message document, immutable once created. */
export interface ChatMessageDoc {
  v: 1;
  /** The member's own address, as the session reports it. */
  from: string;
  /** When the sender's client sent it (display only; ordering is the node's). */
  at: string;
  text: string;
  /** The message this one answers, when it is a quote reply (ADR 0006). */
  replyTo?: string;
  /** Principals the message mentions; optional so old documents stay valid. */
  mentions?: ChatMention[];
}

/** One member's read marker: which message they have read up to. */
export interface ChatMarkerDoc {
  v: 1;
  /** The id of the newest message read, or null when born on an empty chat. */
  lastRead: Id | null;
}

/** A message as the store keeps it: the document plus its FileNode identity. */
export interface ChatMessage extends ChatMessageDoc {
  id: Id;
  /** Server-side creation time of the node -- the ordering key. */
  created: string;
}

/** Properties a message node is fetched with. */
export const messageProps = (): string[] => [
  "id",
  "parentId",
  "name",
  "blobId",
  "type",
  "created",
  "nodeType",
];

function isChatMention(x: unknown): x is ChatMention {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return d.kind === "principal" && typeof d.id === "string";
}

export function isChatMessageDoc(x: unknown): x is ChatMessageDoc {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return (
    d.v === 1 &&
    typeof d.from === "string" &&
    typeof d.at === "string" &&
    typeof d.text === "string" &&
    (d.replyTo === undefined || typeof d.replyTo === "string") &&
    (d.mentions === undefined ||
      (Array.isArray(d.mentions) && d.mentions.every(isChatMention)))
  );
}

export function isChatMarkerDoc(x: unknown): x is ChatMarkerDoc {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return d.v === 1 && (d.lastRead === null || typeof d.lastRead === "string");
}

/** Build a message document — the one writer; the store must not inline it. */
export function messageDoc(
  from: string,
  text: string,
  replyTo?: string,
  mentions?: ChatMention[],
): ChatMessageDoc {
  const doc: ChatMessageDoc = { v: 1, from, at: new Date().toISOString(), text };
  if (replyTo) doc.replyTo = replyTo;
  if (mentions?.length) doc.mentions = mentions;
  return doc;
}

/**
 * The addresses a reader may mention: everyone who has posted in the
 * transcript, plus the reader. Membership is the grant (ADR 0006) and
 * Stalwart exposes no member list over JMAP, so the transcript is the one
 * source the client can see; a member becomes mentionable the moment they
 * post, and the live FileNode rail makes that visible without a refresh.
 */
export function participantsOf(
  messages: ReadonlyArray<{ from: string }>,
  me: string,
): string[] {
  const seen = new Set<string>();
  if (me) seen.add(me);
  for (const m of messages) if (m.from) seen.add(m.from);
  return [...seen].sort();
}

/**
 * The mentions a text carries: `@` immediately followed by a participant
 * address. First-appearance order, each participant once. The address is the
 * chat's identity (the `from` of a message), so matching is exact.
 */
export function mentionsFromText(
  text: string,
  participants: ReadonlyArray<string>,
): ChatMention[] {
  const known = new Set(participants);
  const out: ChatMention[] = [];
  const seen = new Set<string>();
  for (const token of text.match(/@[^\s]+/g) ?? []) {
    const id = token.slice(1);
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: "principal", id });
  }
  return out;
}

/**
 * The marker file name for a member.
 *
 * Deterministic per address, so every device of a member computes the same
 * name and reads the same marker. The address is URL-encoded because it is
 * the only character set a file name can rely on across servers.
 */
export function markerNameFor(member: string): string {
  return `read-${encodeURIComponent(member)}.json`;
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

/**
 * Order messages the way the transcript reads: server-side creation order.
 *
 * The message document carries its own `at`, but that is the sender's clock
 * and must not decide the order. The FileNode's `created` is the server's
 * stamp; two nodes created in the same instant tie-break on id so the order
 * is total. Decided at implementation (2026-09-08): FileNode ids are opaque
 * on a real server, so id alone cannot carry creation order, and the ADR's
 * live-server confirmation of a timestamp property is what `created` is.
 */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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
  return writeDoc(accountId, folderId, `${crypto.randomUUID()}.json`, doc);
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
    const doc = await readDoc(accountId, node.blobId);
    if (!isChatMessageDoc(doc)) return null;
    return { id, created: node.created ?? "", ...doc };
  } catch {
    return null; // a doc that does not parse is not a message we can show
  }
}

/**
 * How many of a conversation's messages are unread for the reader.
 *
 * The ADR kind rule: unread = messages newer than my marker. No marker (never
 * opened) reads as 0 and the transcript shows in full; a marker born on an
 * empty chat (lastRead null) makes everything that came after it unread; a
 * marker whose message is gone reads as nothing unread rather than flooding.
 */
export function unreadCount(
  nodes: ChatMessage[],
  marker: { lastRead: Id | null } | null,
): number {
  if (!marker) return 0;
  if (!marker.lastRead) return nodes.length;
  const at = nodes.findIndex((n) => n.id === marker.lastRead);
  // Known limitation, by design: once the oldest messages have been trimmed
  // off the transcript window, a marker that pointed into the trimmed part is
  // indistinguishable from one ahead of the window, and reads as nothing
  // unread. The badge under-counts for a member who never reopened a chat
  // that outgrew the window -- accepted until chat gains paging.
  if (at < 0) return 0;
  return nodes.length - at - 1;
}
