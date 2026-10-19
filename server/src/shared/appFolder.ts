/**
 * The one folder, the one type a document in it is stored as, and the one rule
 * that finds it.
 *
 * Every byte Gilbert keeps durably is a document in the `gilbert` folder of an
 * account's own Files, written by one tier and often read by the other: the
 * synced settings, a group's label catalog, a chat transcript, the agent's
 * rules and records, the identity lock. So the folder's name, the MIME type
 * those documents are stored and fetched with, and the way the folder is found
 * are contracts between the tiers, not things either of them owns — and a
 * second spelling of one of them is not a cosmetic difference: `isAppFolder`
 * looks for the folder by name, and a document written under a different type is
 * a document a reader opening it with the expected type may refuse.
 *
 * The mock reproduces Stalwart and writes its own copies on purpose; that is
 * the one place a duplicate is tolerable, because it is simulating a server
 * rather than speaking to one.
 *
 * No imports, so nothing heavy reaches a bundle through this file: the rule
 * below takes the nodes a tier already has and hands back the answer both tiers
 * need, while the JMAP call that fetches them stays where the transport is.
 */

/** The folder Gilbert keeps its own documents in, in every account. */
export const APP_FOLDER_NAME = "gilbert";

/** What an app-folder document is stored and fetched as, in both tiers. */
export const APP_DOCUMENT_TYPE = "application/json";

/**
 * The FileNode properties a folder lookup asks for.
 *
 * Both tiers read these nodes — the server to find and write a document, the
 * client to find one and hide it — and a property named on one side and not
 * the other is a lookup that silently sees a different node.
 */
export const FOLDER_PROPS: string[] = ["id", "name", "nodeType", "parentId"];

/**
 * The FileNode methods the app folder is read and written through, named once.
 *
 * A writer and whoever has to notice a write must agree on the set method, and
 * they sit in different modules: the server's memory drops a listing when a
 * `FILENODE_SET` passes its client, which is a contract between the writer
 * (`appFolder.ts`) and the trigger (`jmap.ts`) that a string on each side would
 * let drift apart -- a rename on one side alone would leave the memory serving
 * a listing a write had already changed, and nothing would report it.
 */
export const FILENODE_QUERY = "FileNode/query";
export const FILENODE_GET = "FileNode/get";
export const FILENODE_SET = "FileNode/set";
export const FILENODE_CHANGES = "FileNode/changes";

/**
 * Whether a raw JMAP request body carries a write to the tree.
 *
 * The second reader of `FILENODE_SET`, beside the one in `jmap.ts` that serves a
 * call this process sends itself. The browser's own writes are forwarded whole
 * by `/api/jmap` (`routes/mail.ts`) and never pass the client, so that route
 * cannot rely on `JmapClient` having forgotten what the memory holds -- and it
 * is not an occasional path: `store/files/shared.ts` sends every `FileNode/set` a
 * person makes through it.
 *
 * The body is untrusted text and the answer is one question about it: does a
 * call named `FileNode/set` appear in it. A body that is not JSON, or whose
 * `methodCalls` is not a list, answers false -- the upstream is what decides
 * whether the call is well formed, and a reader here that guessed would forget
 * levels on reads.
 */
export function writesTheTree(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const calls = (parsed as { methodCalls?: unknown } | null)?.methodCalls;
  if (!Array.isArray(calls)) return false;
  return calls.some((call) => (Array.isArray(call) ? call[0] : null) === FILENODE_SET);
}

/**
 * The whole of a file node. The client asks for `state` beside these, which is
 * a fact about a conditional write rather than about the node.
 */
export const FILE_PROPS: string[] = [
  "id",
  "name",
  "parentId",
  "blobId",
  "size",
  "type",
  "nodeType",
];

/**
 * The FileNode properties `nodeStamp` reads, named once.
 *
 * A level that is cut on a node's stamp, or one that decides whether a document
 * has moved since it was read, has to ask the server for the pair; spelling it
 * again beside each of them is how the two readers end up asking for different
 * properties.
 */
export const STAMP_PROPS: string[] = ["created", "modified"];

/**
 * A node's own last-write stamp: `modified`, falling back to `created`.
 *
 * The pair the Files view sorts a node by, and the pair every registry cuts its
 * newest-first page on — the workorder roots, the knowledge articles and their
 * revisions. Both tiers read it here, so a document remembered at its stamp and
 * the listing that compares it cannot disagree about when it moved.
 *
 * A node carrying neither stamp is a node the server has not stamped; it sorts
 * as the empty string, last, rather than throwing the page away.
 */
export function nodeStamp(node: { created?: unknown; modified?: unknown }): string {
  if (typeof node.modified === "string") return node.modified;
  if (typeof node.created === "string") return node.created;
  return "";
}

/**
 * The least a node has to say to be judged against the rule below.
 *
 * Loose on purpose: the server reads its nodes off the wire (`FileNodeLike`,
 * `unknown` fields) and the client has them typed (`FileNode`), so the rule
 * takes anything shaped like a node and reads only the three fields it needs.
 */
interface AppFolderNodeLike {
  id?: unknown;
  name?: unknown;
  parentId?: unknown;
  nodeType?: unknown;
}

/**
 * The app folder itself: a top-level directory by that name.
 *
 * Asked by both tiers rather than kept by each: the server looks the folder up
 * and ensures it exists with this, and the client hides it from the Files
 * listing with the same call. The name is the whole rule — no marker to leave,
 * no second name to fall back to, nothing for the two sides to resolve
 * differently.
 */
export function isAppFolder(node: AppFolderNodeLike): boolean {
  return (
    (node.parentId ?? null) === null &&
    node.nodeType === "directory" &&
    String(node.name ?? "") === APP_FOLDER_NAME
  );
}

/** Create-arguments for the app folder, as both tiers send them. */
export function appFolderCreate(): {
  parentId: null;
  name: string;
  nodeType: "directory";
} {
  return { parentId: null, name: APP_FOLDER_NAME, nodeType: "directory" };
}

/** One level of Files, as the tier asking for it reads it. */
type AppFolderChildren = (
  parentId: string | null,
) => Promise<readonly AppFolderNodeLike[]>;

/** The app folder's id, or null when the account has none yet. */
export async function findAppFolderId(
  children: AppFolderChildren,
): Promise<string | null> {
  const top = await children(null);
  const found = top.find(isAppFolder);
  return found?.id == null ? null : String(found.id);
}

/**
 * The app folder's id, creating it through `create` when the account has none.
 *
 * Find-then-create is the half worth sharing. A tier that wrote its own would
 * decide for itself what "already there" means, and a folder created beside an
 * existing one is a second folder with the same name — the same rule a file
 * follows when it is written into this folder (ADR 0013).
 */
export async function ensureAppFolderId(
  children: AppFolderChildren,
  create: () => Promise<string>,
): Promise<string> {
  const existing = await findAppFolderId(children);
  return existing ?? (await create());
}
