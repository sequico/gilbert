/**
 * The documents a workorder is read and written through.
 *
 * A root or a part is found by uid — the root in both its folders — and every
 * root write is a read-modify-write under the account's compare-and-set.
 */

import {
  appFolderState,
  type Ctx,
  findAppFileAt,
  readAppJsonAt,
  writeAppFileIn,
} from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import {
  isWorkorderDoc,
  WORKORDER_FOLDER,
  type WorkorderDoc,
  workorderClosedPath,
  workorderFileName,
} from "../shared/workorder.js";
import { requireState, WorkorderAdminError } from "./errors.js";

/** A root or a part found on disk, with the node a move needs. */
export interface WorkorderFound {
  /** The app-folder-relative path the document was read at. */
  path: string;
  /** The folder node holding it. */
  folderId: string;
  /** The file node's id — kept when a root moves. */
  nodeId: string;
  doc: WorkorderDoc;
}

/** The active copy of a uid, or null when it is not there. */
export async function findActive(
  ctx: Ctx,
  accountId: string,
  uid: string,
): Promise<WorkorderFound | null> {
  const path = `${WORKORDER_FOLDER}/${workorderFileName(uid)}`;
  const { folderId, file } = await findAppFileAt(ctx, accountId, path);
  if (!folderId || !file || typeof file.id !== "string") return null;
  const doc = await readAppJsonAt(ctx, accountId, path);
  if (!isWorkorderDoc(doc)) return null;
  return { path, folderId, nodeId: file.id, doc };
}

/**
 * The Master's copy of a uid, active or closed.
 *
 * A terminal state moves the root to `workorders/closed/`; the uid is the
 * identity, so a reader looks in both places. A part never moves, so a group's
 * copy is found by `findActive` alone.
 */
export async function findRoot(
  ctx: Ctx,
  accountId: string,
  uid: string,
): Promise<WorkorderFound | null> {
  const active = await findActive(ctx, accountId, uid);
  if (active) return active;
  const path = `${workorderClosedPath()}/${workorderFileName(uid)}`;
  const { folderId, file } = await findAppFileAt(ctx, accountId, path);
  if (!folderId || !file || typeof file.id !== "string") return null;
  const doc = await readAppJsonAt(ctx, accountId, path);
  if (!isWorkorderDoc(doc)) return null;
  return { path, folderId, nodeId: file.id, doc };
}

/**
 * Read-modify-write one workorder root under the account's compare-and-set,
 * retried once: JMAP offers no lock, and the state is whole-account, so the
 * retry is what keeps a write from being lost under two writers.
 *
 * `mutate` receives the root as it was read and returns the document to write;
 * a refusal it throws — a missing step, a reference that is not one — leaves
 * the function uncaught and reaches the caller unchanged. When the race is lost
 * twice the surface's own code is thrown, never the raw JMAP `stateMismatch`.
 *
 * What it answers is the root the write left behind: the caller that has to act
 * on the result — the gates pass a check runs next — would otherwise read one
 * document twice more in the same request.
 */
export async function writeRootUnderCas(
  ctx: Ctx,
  accountId: string,
  uid: string,
  fail: { code: string; message: string },
  mutate: (found: WorkorderFound) => WorkorderDoc,
): Promise<WorkorderFound> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    // The token is read before the document, so a write landing between the two
    // is refused rather than overwritten.
    const token = requireState(await appFolderState(ctx, accountId));
    const found = await findRoot(ctx, accountId, uid);
    if (!found)
      throw new WorkorderAdminError(
        "workorder_not_found",
        `No workorder "${uid}" is there.`,
        404,
      );
    const next = mutate(found);
    try {
      await writeAppFileIn(ctx, accountId, found.folderId, workorderFileName(uid), next, {
        ifInState: token,
      });
      return { ...found, doc: next };
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw new WorkorderAdminError(fail.code, fail.message, 502);
}
