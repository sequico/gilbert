/**
 * A group's chat, read and written by this tier (ADR 0005).
 *
 * A chat message is one JSON document per node in the group account's own
 * `gilbert/chat` folder, and its shape, its validator and the ordering of the
 * transcript are `@gilbert/shared/chat` — one definition both tiers read. This
 * is the server tier's door to those documents, the twin of the client's
 * (`web/src/lib/chat.ts`): the agent reads the conversation a member reads and
 * says something in it, through the same app folder the rest of the group's
 * documents live in.
 *
 * A node in the folder that is not a readable message is not part of the
 * transcript, exactly as it is not for the client: the folder is Files, and
 * somebody may keep anything there.
 */

import {
  type Ctx,
  documentType,
  downloadBlobText,
  ensureFolderPath,
  FILENODE_CAP,
  type FileNodeLike,
  fileChildren,
  findFolderPath,
  writeAppFileIn,
} from "./appFolder.js";
import { APP_FOLDER_NAME, FILENODE_GET } from "./shared/appFolder.js";
import {
  CHAT_FOLDER,
  CHAT_PAGE,
  type ChatMention,
  type ChatMessage,
  compareMessages,
  isChatMessageDoc,
  messageDoc,
  messageFileName,
  messageProps,
} from "./shared/chat.js";
import { clientOf } from "./util.js";

/** The account's chat folder inside its app folder, or null when it has none. */
async function chatFolderId(ctx: Ctx, accountId: string): Promise<string | null> {
  return findFolderPath(ctx, accountId, CHAT_FOLDER);
}

/**
 * One node's document, parsed, or null when it is not a chat message.
 *
 * The node's own `created` is the ordering key — the server's stamp, never the
 * sender's clock (`compareMessages`) — and a node whose bytes will not read is
 * not a message this tier can show.
 */
async function messageOf(
  ctx: Ctx,
  accountId: string,
  node: FileNodeLike,
): Promise<ChatMessage | null> {
  if (
    node.nodeType !== "file" ||
    typeof node.blobId !== "string" ||
    typeof node.id !== "string"
  )
    return null;
  try {
    const text = await downloadBlobText(
      ctx,
      accountId,
      node.blobId,
      documentType(node),
      String(node.name ?? "message.json"),
    );
    const doc: unknown = JSON.parse(text);
    if (!isChatMessageDoc(doc)) return null;
    return {
      id: node.id,
      created: typeof node.created === "string" ? node.created : "",
      ...doc,
    };
  } catch {
    /* a node that is not a readable message is not part of the transcript */
    return null;
  }
}

/** One message of the conversation, by its node id, or null when it is not one. */
export async function readChatMessage(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<ChatMessage | null> {
  const folderId = await chatFolderId(ctx, accountId);
  if (!folderId) return null;
  const answer = await clientOf(ctx).call<{ list?: FileNodeLike[] }>(
    FILENODE_GET,
    { accountId, ids: [id], properties: messageProps() },
    [FILENODE_CAP],
  );
  const node = answer.list?.find((one) => one.parentId === folderId);
  return node ? await messageOf(ctx, accountId, node) : null;
}

/**
 * One message of the conversation by the path the account's change log names it
 * at, or null when it is not one.
 *
 * The change log reports a node by its path in the account's own tree
 * (`events.ts`) — the app folder's own name in front of the one that is here —
 * while a reader of this module names a message by its node id. This is the same
 * door twice over, and it lives here rather than in the reader's caller because
 * this is the module that knows where the messages are filed.
 */
export async function readChatMessageAt(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<ChatMessage | null> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name.endsWith(".json")) return null;
  const folderId = await chatFolderId(ctx, accountId);
  if (!folderId) return null;
  const nodes = await fileChildren(ctx, accountId, folderId, messageProps());
  const node = nodes.find((one) => one.name === name);
  return node ? await messageOf(ctx, accountId, node) : null;
}

/**
 * One message by any name an agent may hold for it.
 *
 * An event names the message by its path in the account's tree; a search answers
 * with its node id; and a model reading the event has been seen to keep only the
 * file name. All three are the same message, and this is the module that knows
 * where it is filed, so the resolution lives here rather than in each caller.
 */
export async function readChatMessageBy(
  ctx: Ctx,
  accountId: string,
  ref: string,
): Promise<ChatMessage | null> {
  if (ref.includes("/")) return await readChatMessageAt(ctx, accountId, ref);
  const byId = await readChatMessage(ctx, accountId, ref);
  if (byId) return byId;
  const name = ref.endsWith(".json") ? ref : `${ref}.json`;
  return await readChatMessageAt(
    ctx,
    accountId,
    `${APP_FOLDER_NAME}/${CHAT_FOLDER}/${name}`,
  );
}

/**
 * The conversation's messages whose text contains `query`, newest first.
 *
 * The scan is the newest `CHAT_PAGE` messages — the window the client pages the
 * transcript with — because the transcript is one document per message and a
 * scan of an account's whole history would read one blob per message on every
 * call. What the model needs from a search is what was just said.
 */
export async function findChatMessages(
  ctx: Ctx,
  accountId: string,
  query: string,
  limit: number,
): Promise<ChatMessage[]> {
  const folderId = await chatFolderId(ctx, accountId);
  if (!folderId) return [];
  const nodes = await fileChildren(ctx, accountId, folderId, messageProps());
  const newest = [...nodes]
    .sort((a, b) =>
      compareMessages(
        { created: String(a.created ?? ""), id: String(a.id ?? "") },
        { created: String(b.created ?? ""), id: String(b.id ?? "") },
      ),
    )
    .slice(-CHAT_PAGE);
  const wanted = query.toLowerCase();
  const found: ChatMessage[] = [];
  for (const node of newest.reverse()) {
    const message = await messageOf(ctx, accountId, node);
    if (!message) continue;
    if (message.text.toLowerCase().includes(wanted)) {
      found.push(message);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/**
 * Say something in the conversation, as `from`, and answer the message's id.
 *
 * The chat folders are made on the way (`ensureFolderPath`), so the first thing
 * the agent says in a group that has never spoken creates them, and the id the
 * write answers with is what a reply is addressed to (`replyTo`, ADR 0033) and
 * what a run waits on when the message is a question.
 */
export async function postChatMessage(
  ctx: Ctx,
  accountId: string,
  from: string,
  text: string,
  opts: { replyTo?: string; mentions?: ChatMention[] } = {},
): Promise<string> {
  const folderId = await ensureFolderPath(ctx, accountId, CHAT_FOLDER);
  return await writeAppFileIn(
    ctx,
    accountId,
    folderId,
    messageFileName(),
    messageDoc(from, text, opts.replyTo, opts.mentions),
  );
}
