/**
 * The agent's side of the group chat (ADR 0006, ADR 0003 resolution 11).
 *
 * The chat is a folder of documents in the group's own account and both tiers
 * write them the same way: `messageDoc` for the shape, `writeAppFileAt` for the
 * write. What is the agent's own here is the reading — which messages address
 * it, how much conversation it reads, and the deterministic yes/no that turns a
 * member's words into a decision without a model guessing one.
 */

import {
  type Ctx,
  findAppFileAt,
  listAppDir,
  readAppJsonAt,
  writeAppFileAt,
} from "../appFolder.js";
import type { JmapClient } from "../jmap.js";
import {
  CHAT_FOLDER,
  type ChatMention,
  type ChatMessage,
  compareMessages,
  isChatMessageDoc,
  mentionsName,
  messageDoc,
  messageFileName,
  repliesToAuthor,
} from "../shared/chat.js";
import { type AgentChatRequest, clampChatContext } from "./documents.js";

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
 * The group's chat, oldest first.
 *
 * `_client` is the caller's own client for the account; the reads go through
 * the app-folder primitives, which build an equivalent one from the context, so
 * every tier reads the same documents the same way.
 */
export async function readChat(
  ctx: Ctx,
  accountId: string,
  _client: JmapClient,
): Promise<ChatMessage[]> {
  const nodes = await listAppDir(ctx, accountId, CHAT_FOLDER);
  const messages: ChatMessage[] = [];
  for (const node of nodes) {
    if (node.nodeType !== "file" || typeof node.name !== "string") continue;
    const doc = await readAppJsonAt(ctx, accountId, `${CHAT_FOLDER}/${node.name}`);
    if (!isChatMessageDoc(doc)) continue;
    messages.push({
      ...doc,
      id: String(node.id),
      created: typeof node.created === "string" ? node.created : doc.at,
    });
  }
  return messages.sort(compareMessages);
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
      `the message this run answers (${anchorId}) is not in the transcript the worker read, ` +
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

/**
 * The folder a person named when asking for more context, or null.
 *
 * The second widening step (ADR 0003 resolution 11) is one folder slice, and
 * like the first step it is decided by a closed set of shapes rather than by a
 * model: "the Inbox folder", "folder Archive". A message that names no folder
 * leaves the run on the conversation it already has — the agent asks for more
 * or reads what it was told to read, and never guesses.
 */
/** `folder Archive` / `folder "Archive"` — the explicit form. */
const FOLDER_AFTER =
  /\bfolder\s+[\u201c"']?([\w][\w .'-]{0,40}?)[\u201d"']?(?:[.,!?;]|$)/i;
/** `the Archive folder` — the same request said the other way round. */
const FOLDER_BEFORE = /([\w][\w.'-]*(?:\s+[\w][\w.'-]*)?)\s+folder\b/gi;

function cleanFolderName(name: string): string {
  return name.replace(/^the\s+/i, "").trim();
}

/**
 * The folder a person named when asking for more context, or null.
 *
 * The second widening step (ADR 0003 resolution 11) is one folder slice, and
 * like the first step it is decided by a closed set of shapes rather than by a
 * model: "folder Archive", "the Archive folder". Where both forms could match,
 * the name nearest the word is the one meant — a sentence says "@gilbert read
 * the Inbox folder", not "@gilbert read the Inbox" about a folder called
 * "gilbert read the Inbox". A message that names no folder leaves the run on
 * the conversation it already has: the agent asks for more, or reads what it
 * was told to read, and never guesses.
 */
export function folderRequest(text: string): string | null {
  const after = FOLDER_AFTER.exec(text)?.[1];
  if (after) return cleanFolderName(after);
  let last: string | null = null;
  for (const match of text.matchAll(FOLDER_BEFORE)) last = match[1] ?? last;
  return last ? cleanFolderName(last) : null;
}

export function widenRequested(text: string): boolean {
  return WIDEN_PATTERNS.some((pattern) => pattern.test(text));
}

export function readApproval(text: string): "yes" | "no" | "unclear" {
  if (APPROVAL_NO.test(text)) return "no";
  if (APPROVAL_YES.test(text)) return "yes";
  return "unclear";
}
