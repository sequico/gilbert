/**
 * The agent's side of the group chat (ADR 0005, ADR 0003 resolution 11).
 *
 * The chat is a folder of documents in the group's own account and both tiers
 * write them the same way: `messageDoc` for the shape, `writeAppFileAt` for the
 * write. What is the agent's own here is the reading — which messages address
 * it, how much conversation it reads, and the deterministic yes/no that turns a
 * member's words into a decision without a model guessing one.
 */

import {
  type Ctx,
  downloadBlobText,
  type FileNodeLike,
  fileChildren,
  findAppFileAt,
  findFolderPath,
  readAppJsonAt,
  writeAppFileAt,
} from "../appFolder.js";
import type { JmapClient } from "../jmap.js";
import { FILE_PROPS } from "../shared/appFolder.js";
import {
  CHAT_FOLDER,
  type ChatMention,
  type ChatMessage,
  type ChatMessageDoc,
  compareMessages,
  isChatMessageDoc,
  mentionsName,
  messageDoc,
  messageFileName,
  repliesToAuthor,
} from "../shared/chat.js";
import {
  type AgentChatRequest,
  CHAT_CONTEXT_MAX,
  clampChatContext,
} from "./documents.js";

/**
 * The transcript by id. A reply is only an address to the agent when its direct
 * parent is the agent's own message, so the parent has to be found by id.
 */
export type ChatIndex = ReadonlyMap<string, ChatMessage>;

/** Index a transcript the way `pendingRequests` and replies need it. */
export function indexChat(messages: ReadonlyArray<ChatMessage>): ChatIndex {
  return new Map(messages.map((message) => [message.id, message]));
}

/**
 * How many messages one read of the transcript downloads.
 *
 * A run's context is at most `CHAT_CONTEXT_MAX` messages plus the reply chain of
 * the one it answers, and both are drawn from the newest of the transcript, so
 * that many is the whole of what any reader has ever used. The transcript is one
 * document per message and nothing prunes it: reading the folder whole makes
 * every read cost grow with the group's age while the part that is used stays
 * this size.
 */
export const CHAT_READ_MAX = CHAT_CONTEXT_MAX;

/** A node's own creation stamp — the transcript's ordering key — or "". */
function nodeCreated(node: FileNodeLike): string {
  return typeof node.created === "string" ? node.created : "";
}

/**
 * One message document, read from the node the listing already gave.
 *
 * `null` covers every way a document is not readable — the download refused,
 * bytes that are not JSON — so the caller skips it exactly as it skipped
 * `readAppJsonAt`'s null, without listing the folder once per message.
 */
async function readChatDoc(
  ctx: Ctx,
  accountId: string,
  node: FileNodeLike,
): Promise<unknown> {
  try {
    const type =
      typeof node.type === "string" && node.type ? node.type : "application/json";
    const text = await downloadBlobText(
      ctx,
      accountId,
      String(node.blobId),
      type,
      String(node.name),
    );
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The group's chat, oldest first.
 *
 * The folder is listed once — the listing carries each node's own `created`,
 * the transcript's ordering key — and only the newest `CHAT_READ_MAX` documents
 * are downloaded, in transcript order. `_client` is the caller's own client for
 * the account; the reads go through the app-folder primitives, which build an
 * equivalent one from the context, so every tier reads the same documents the
 * same way.
 */
export async function readChat(
  ctx: Ctx,
  accountId: string,
  _client: JmapClient,
): Promise<ChatMessage[]> {
  const folderId = await findFolderPath(ctx, accountId, CHAT_FOLDER);
  if (!folderId) return [];
  const nodes = await fileChildren(ctx, accountId, folderId, [...FILE_PROPS, "created"]);
  const files = nodes.filter(
    (node) =>
      node.nodeType === "file" &&
      typeof node.name === "string" &&
      typeof node.blobId === "string",
  );
  const newest = files
    .map((node) => ({ node, created: nodeCreated(node), id: String(node.id) }))
    .sort(compareMessages)
    .slice(-CHAT_READ_MAX);
  const messages: ChatMessage[] = [];
  for (const { node } of newest) {
    const doc = await readChatDoc(ctx, accountId, node);
    if (!isChatMessageDoc(doc)) continue;
    messages.push(toMessage(node, doc));
  }
  return messages.sort(compareMessages);
}

/** One node and its document, as the transcript's own message. */
function toMessage(node: FileNodeLike, doc: ChatMessageDoc): ChatMessage {
  return { ...doc, id: String(node.id), created: nodeCreated(node) || doc.at };
}

/**
 * One message by node id, for the case the read window does not hold it.
 *
 * A run is woken by a message and answers *that* one, while a read covers the
 * newest `CHAT_READ_MAX` messages: a run arriving after more than that many were
 * written would otherwise find its own trigger missing and refuse to answer it.
 * One listing finds the node and one download reads it — a page and a read,
 * never a wider window.
 */
export async function readChatMessage(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<ChatMessage | null> {
  const folderId = await findFolderPath(ctx, accountId, CHAT_FOLDER);
  if (!folderId) return null;
  const nodes = await fileChildren(ctx, accountId, folderId, [...FILE_PROPS, "created"]);
  const node = nodes.find(
    (candidate) =>
      String(candidate.id) === id &&
      candidate.nodeType === "file" &&
      typeof candidate.blobId === "string",
  );
  if (!node) return null;
  const doc = await readChatDoc(ctx, accountId, node);
  return isChatMessageDoc(doc) ? toMessage(node, doc) : null;
}

/**
 * The messages that ask the agent for something.
 *
 * Two ways to address it and no third (ADR resolution 11): a mention — the
 * loose form, so a hand-typed `@gilbert` counts — or a direct reply to a
 * message the agent itself wrote. Everything else is conversation the agent
 * reads as context but is not expected to answer: this is the deterministic
 * pre-filter, applied before any model call.
 */
export function pendingRequests(
  messages: ReadonlyArray<ChatMessage>,
  agentAddress: string,
  me: ChatIndex,
): AgentChatRequest[] {
  const requests: AgentChatRequest[] = [];
  for (const message of messages) {
    if (message.from === agentAddress) continue;
    const parent = message.replyTo ? me.get(message.replyTo) : null;
    const reply = repliesToAuthor(message, parent, agentAddress);
    const mention = mentionsName(message.text, agentAddress);
    if (!reply && !mention) continue;
    requests.push({
      messageId: message.id,
      author: message.from,
      text: message.text,
      mentions: message.mentions ?? [],
      reply,
    });
  }
  return requests;
}

/**
 * Post as the agent, through the same writer the client uses. Returns the node
 * id, so the caller can record what it said where (the approval flow answers a
 * reply to that message).
 */
export async function postMessage(
  ctx: Ctx,
  accountId: string,
  from: string,
  text: string,
  replyTo?: string,
  mentions?: ReadonlyArray<ChatMention>,
): Promise<string> {
  if (!from) throw new Error("the agent has no address to post from");
  const path = `${CHAT_FOLDER}/${messageFileName()}`;
  const doc = messageDoc(from, text, replyTo, mentions ? [...mentions] : undefined);
  await writeAppFileAt(ctx, accountId, path, doc);
  // The writer returns nothing, and the caller needs the node it just made.
  const found = await findAppFileAt(ctx, accountId, path);
  return found.file?.id ? String(found.file.id) : "";
}

/**
 * What the agent says the first time it speaks in a group.
 *
 * A chat message like any other, and the marker below is written beside it: the
 * message is what a member reads, the marker is what survives out of sight of a
 * read window.
 */
export const AGENT_GREETING = "Hi all! Gilbert here, at your service.";

/**
 * The document the greeting leaves in the chat folder.
 *
 * A transcript is read in its newest `CHAT_READ_MAX` messages and a group's chat
 * only grows, so the greeting is eventually older than any read covers. The
 * marker is what says "this address has greeted this group" once the message is
 * out of the window; a missing or unreadable one reads as "not yet", which
 * repeats a greeting at worst.
 */
export const GREETING_FILE = "greeting.json";

/** Whether the agent has already spoken in a transcript. */
export function hasSpoken(
  messages: ReadonlyArray<ChatMessage>,
  address: string,
): boolean {
  return messages.some((message) => message.from === address);
}

/** Whether the greeting marker names this address. */
export async function hasGreeted(
  ctx: Ctx,
  accountId: string,
  address: string,
): Promise<boolean> {
  const doc = await readAppJsonAt(ctx, accountId, `${CHAT_FOLDER}/${GREETING_FILE}`);
  return !!doc && typeof doc === "object" && (doc as { from?: unknown }).from === address;
}

/**
 * Say hello in a group the agent has never spoken in.
 *
 * Returns the node id it posted, or null when the group has already heard from
 * the agent. Two records answer that and both are needed: the transcript, while
 * the greeting is still inside the window a read covers, and the marker it left,
 * once it is not — otherwise a group that has written more than a window's worth
 * of messages since is greeted again on every claim.
 */
export async function greetUnspoken(
  ctx: Ctx,
  accountId: string,
  address: string,
  client: JmapClient,
): Promise<string | null> {
  const messages = await readChat(ctx, accountId, client);
  if (hasSpoken(messages, address)) return null;
  if (await hasGreeted(ctx, accountId, address)) return null;
  const node = await postMessage(ctx, accountId, address, AGENT_GREETING);
  // Written after the message: a marker that outlived a failed post would
  // silence a greeting the group never heard.
  await writeAppFileAt(ctx, accountId, `${CHAT_FOLDER}/${GREETING_FILE}`, {
    from: address,
  });
  return node;
}

/**
 * What the agent reads of the conversation before it answers.
 *
 * The last `clampChatContext(requested)` messages up to and including `upto`,
 * plus the reply chain of the message being answered — the chain is context a
 * member wrote on purpose, and a window boundary would otherwise cut it off.
 *
 * `anchorId` is the message the run is answering, when the caller knows it. Two
 * things depend on it and neither is a guess: the chain is built from **that**
 * message rather than from whichever message happened to be last, and a message
 * the caller says is the trigger but which the transcript does not hold is an
 * error rather than a silently different conversation. Answering a window that
 * does not contain the thing you were asked about is the failure this closes.
 *
 * The bound holds either way, and it is the *human* one: the chain may take the
 * context to `CHAT_CONTEXT_MAX` only when somebody asked for a wider window;
 * otherwise it stays inside the default, so a long thread does not quietly hand
 * the model three hundred messages (ADR resolution 11).
 */
export function conversationContext(
  messages: ReadonlyArray<ChatMessage>,
  upto: string,
  requested?: number,
  anchorId?: string,
): ChatMessage[] {
  const ordered = [...messages].sort(compareMessages);
  const before = ordered.filter((message) => message.created <= upto);
  const ceiling = clampChatContext(requested);
  const byId = indexChat(ordered);
  const anchor = anchorId ? byId.get(anchorId) : before[before.length - 1];
  if (anchorId && !anchor) {
    throw new Error(
      `the message this run answers (${anchorId}) is not in the transcript the agent read, ` +
        "so there is no conversation to answer in",
    );
  }
  // The message being answered is the one thing that cannot be dropped, and the
  // chain is what a member wrote on purpose; both are read first, inside the
  // bound, and the window takes what is left. Reading the window first would
  // make a long thread the one case where the chain is always absent, which is
  // the opposite of what it is for.
  const chosen: ChatMessage[] = [];
  const included = new Set<string>();
  const take = (message: ChatMessage | undefined) => {
    if (!message || included.has(message.id)) return;
    included.add(message.id);
    chosen.push(message);
  };
  take(anchor);
  let cursor = anchor?.replyTo ? byId.get(anchor.replyTo) : undefined;
  while (cursor && chosen.length < ceiling) {
    // A reply chain is whatever the senders wrote, so it can point in a circle:
    // the walk stops at a message it has already read instead of following the
    // same two messages for ever.
    if (included.has(cursor.id)) break;
    take(cursor);
    cursor = cursor.replyTo ? byId.get(cursor.replyTo) : undefined;
  }
  for (let i = before.length - 1; i >= 0 && chosen.length < ceiling; i--) {
    take(before[i]);
  }
  return chosen.sort(compareMessages);
}

/**
 * The words that approve and the words that refuse. A closed vocabulary, whole
 * words, case-insensitive.
 *
 * Refusal wins when a message carries both ("ok, but don't send it"): a yes/no
 * that is not unambiguous is not an approval, and the caller asks a closed
 * question instead of acting on it.
 */
const APPROVAL_YES =
  /\b(yes|yep|ok|okay|approve|approved|send|confirm|confirmed|proceed|go ahead)\b/i;
const APPROVAL_NO =
  /\b(no|nope|cancel|cancelled|canceled|reject|rejected|stop|don't|do not|never|abort)\b/i;

/** What a member's reply means. `unclear` is a value, never a guess. */
/**
 * Whether a human asked for a wider context than the default.
 *
 * The agent never widens on its own (ADR 0003 resolution 11): fifty messages
 * is the default and three hundred is the ceiling, and the only thing that
 * moves a run from one to the other is a person saying so. The vocabulary is
 * deliberately small and deterministic — a closed set the pre-filter can
 * decide without a model, the same way the approval words are — and an
 * unlisted phrasing simply leaves the run on its default.
 */
const WIDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(whole|entire|full)\b[^.!?]{0,24}\b(conversation|thread|chat|history|transcript)\b/i,
  /\b(all|every)\b[^.!?]{0,12}\b(messages?|context)\b/i,
  /\bread\s+everything\b/i,
  /\bfrom\s+the\s+(beginning|start)\b/i,
];

export function widenRequested(text: string): boolean {
  return WIDEN_PATTERNS.some((pattern) => pattern.test(text));
}

export function readApproval(text: string): "yes" | "no" | "unclear" {
  if (APPROVAL_NO.test(text)) return "no";
  if (APPROVAL_YES.test(text)) return "yes";
  return "unclear";
}
