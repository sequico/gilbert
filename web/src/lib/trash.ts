import { APP_DOCUMENT_TYPE, FOLDER_PROPS } from "@gilbert/shared/appFolder";
import {
  isTrashFolder,
  parseTrashDocument,
  TRASH_DOCUMENT,
  TRASH_FOLDER_NAME,
  type TrashDocument,
  type TrashOrigin,
} from "@gilbert/shared/trash";
import { client } from "@/jmap/client";
import {
  findAppFolder,
  findInFolderWithState,
  isStateMismatch,
  listChildrenWithState,
  writeAppJson,
} from "@/lib/appFolder";
import { createDirectory, NameTakenError } from "@/lib/filenode";
import type { FileNode, Id } from "@/jmap/types";

/**
 * The account's Trash, and who may end what is in it — the one rule for Files
 * (ADR 0013).
 *
 * Deleting in Files does not destroy: the node moves into the account's Trash,
 * whole, and a folder arrives with everything under it. The Trash is a real
 * top-level folder of the account — the reader's own or a group's — so it
 * travels with the account and a JMAP client sees an ordinary folder. What
 * remains destructive is emptying it and deleting one thing inside it for good,
 * and that is the half this module decides: the reader's own files always, a
 * group's only for an installation administrator.
 *
 * **It is a rule, not a boundary.** The same account reached by another JMAP
 * client destroys the same nodes without asking this code, exactly as ADR 0013
 * says of the mail rule beside it.
 *
 * **It answers codes, never sentences**, so a surface composes what the reader
 * reads from its own catalogue.
 *
 * The origins are kept beside the settings in the account's app folder
 * (`trash.json`, `@gilbert/shared/trash`), because a trashed node is a child of
 * the Trash folder and no longer says where it sat or what it was called. A node
 * whose origin has gone is restored to the top level of Files rather than
 * failing: visible somewhere is better than stuck.
 */

/** Where the Trash folder is in the nodes a Files state already holds. */
export function trashFolderId(state: { nodes: Record<Id, FileNode> }): Id | null {
  for (const node of Object.values(state.nodes)) if (isTrashFolder(node)) return node.id;
  return null;
}

export interface TrashContext {
  /** The account the action happens in: the one Files is browsing. */
  accountId: Id | null;
  /** The session's own Files account, whoever is browsing. */
  ownAccountId: Id | null;
  /** The session's admin flag (ADR 0001). */
  isAdmin: boolean;
}

/**
 * Whether what is in this trash may be ended here.
 *
 * An administrator may anywhere; the reader may in their own account. Anything
 * that is not provably the reader's own — a group, a share, an account the
 * session has not resolved yet — is refused, which is the order `mailDelete`'s
 * `mayDestroy` asks in and for the same reason: the answer must not wait on an
 * account probe.
 */
export function mayEndFiles(ctx: TrashContext): boolean {
  if (ctx.isAdmin) return true;
  return (
    ctx.accountId !== null &&
    ctx.ownAccountId !== null &&
    ctx.accountId === ctx.ownAccountId
  );
}

/**
 * Why emptying or a permanent delete is refused here, or `null` where it may be
 * taken. One code per entry point, because the reader's next move differs.
 */
export type TrashRefusal = "group_files_empty" | "group_files_final";

export function trashRefusal(
  ctx: TrashContext,
  kind: "empty" | "final",
): TrashRefusal | null {
  if (mayEndFiles(ctx)) return null;
  return kind === "empty" ? "group_files_empty" : "group_files_final";
}

/** The account's Trash folder, or null when it has never been used. */
export async function findTrashFolder(accountId: Id): Promise<Id | null> {
  const { list } = await listChildrenWithState(accountId, null, [...FOLDER_PROPS]);
  return list.find(isTrashFolder)?.id ?? null;
}

/**
 * The account's Trash folder, creating it on the first delete.
 *
 * The first delete is what makes the folder, so an account that never deletes
 * never grows one. A create that loses a race is the folder the other writer
 * made: the server names it, and a second read is the fallback when it does not.
 */
export async function ensureTrashFolder(accountId: Id): Promise<Id> {
  const existing = await findTrashFolder(accountId);
  if (existing) return existing;
  try {
    return await createDirectory(accountId, null, TRASH_FOLDER_NAME);
  } catch (err) {
    if (err instanceof NameTakenError && err.existingId) return err.existingId;
    const again = await findTrashFolder(accountId);
    if (again) return again;
    throw err;
  }
}

/**
 * What `trash.json` says, and the FileNode state the read saw.
 *
 * A missing app folder or a missing document is "nothing is remembered", which
 * is a real answer: the first delete writes both. An unreadable document is the
 * same answer, because a restore that cannot name an origin still has a place to
 * go (the top level).
 */
export async function readTrashOrigins(
  accountId: Id,
): Promise<{ origins: Record<string, TrashOrigin>; state?: string }> {
  const folderId = await findAppFolder(accountId);
  if (!folderId) return { origins: {} };
  const { file, state } = await findInFolderWithState(
    accountId,
    folderId,
    TRASH_DOCUMENT,
  );
  if (!file?.blobId) return { origins: {}, state };
  try {
    const text = await client.fetchBlobText(accountId, file.blobId, APP_DOCUMENT_TYPE);
    return { origins: parseTrashDocument(JSON.parse(text)).origins, state };
  } catch {
    return { origins: {}, state };
  }
}

/**
 * Rewrite `trash.json` from what is there now, conditional on the read.
 *
 * A read-modify-write over one document two tabs may write at once, so the write
 * carries the state its read saw and a lost compare-and-set is retried on a
 * fresh read — the same shape the settings writer uses, smaller because a lost
 * origin costs a restore its place and nothing else.
 */
export async function writeTrashOrigins(
  accountId: Id,
  change: (doc: TrashDocument) => TrashDocument,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const { origins, state } = await readTrashOrigins(accountId);
    try {
      await writeAppJson(accountId, TRASH_DOCUMENT, change({ origins }), {
        ...(state ? { ifInState: state } : {}),
      });
      return;
    } catch (err) {
      if (attempt >= 2 || !isStateMismatch(err)) throw err;
    }
  }
}
