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
 * The least a node has to say to be judged against the rule below.
 *
 * Loose on purpose: the server reads its nodes off the wire (`FileNodeLike`,
 * `unknown` fields) and the client has them typed (`FileNode`), so the rule
 * takes anything shaped like a node and reads only the three fields it needs.
 */
export interface AppFolderNodeLike {
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
export type AppFolderChildren = (
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
