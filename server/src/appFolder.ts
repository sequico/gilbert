/**
 * The account's own `gilbert` app folder in JMAP Files, reached over JMAP.
 *
 * Every durable document Gilbert keeps in Stalwart's own storage lives here:
 * the synced settings, the forced-password-change directive, a group's label
 * catalog, the chat folders, and (ADR 0003) the agent's rules, jobs,
 * decisions, claims, schedule and audit. One implementation, because all of
 * them need the same things and each one of them would get them subtly
 * differently.
 *
 * Facts this module encodes, all of them live-verified against Stalwart 0.16
 * (see gilbert-stalwart):
 *
 * - `FileNode/query` cannot filter by `name`; a filter the server does not
 *   know fails the whole query, so names are matched here (2026-08-27).
 * - `FileNode/set` returns no `blobId` on create; anything that needs the
 *   blob straight after has to ask again.
 * - A blob is uploaded separately and then referenced by a node.
 *
 * The paths below are app-folder-relative: `"agent/jobs/abc.json"` means the
 * file `abc.json` inside `jobs` inside `agent`, all inside `gilbert`. Missing
 * folders on the way are created on demand, which is what makes a document
 * write a single call at the call site.
 */

import { isAlreadyExistsRefusal, JmapClient } from "./jmap.js";
import { appDocumentJson } from "./shared/appDocument.js";
import { CAPABILITIES } from "./shared/capabilities.js";
import type { UpstreamSession } from "./upstream.js";

/** The one encoder: what a document is about to be written as is bytes. */
const utf8 = new TextEncoder();

/** The folder Gilbert keeps its own documents in, in every account. */
export const APP_FOLDER_NAME = "gilbert";

/** The JMAP capability that carries FileNode in Stalwart 0.16. */
export const FILENODE_CAP = CAPABILITIES.filenode;

/** Properties needed to find a node by name and parent. */
const FOLDER_PROPS = ["id", "name", "nodeType", "parentId"];
const FILE_PROPS = ["id", "name", "parentId", "blobId", "size", "type", "nodeType"];

/** An error with a message meant for the person using the app. */
export class AppFolderError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    public readonly code = "upstream",
  ) {
    super(message);
    this.name = "AppFolderError";
  }
}

export interface FileNodeLike {
  id?: unknown;
  name?: unknown;
  parentId?: unknown;
  blobId?: unknown;
  nodeType?: unknown;
  type?: unknown;
  size?: unknown;
  created?: unknown;
}

/** What every caller of this module needs to talk to Stalwart. */
export interface Ctx {
  authorization: string;
  session: UpstreamSession;
  username: string;
}

function clientOf(ctx: Ctx): JmapClient {
  return new JmapClient(ctx);
}

/**
 * The account that owns this principal's Files.
 *
 * The client reads and writes its own state through `ownAccountFor(CAP.filenode)`
 * (`web/src/lib/accountRouting.ts`): the primary filenode account when it is
 * personal, else the first personal account advertising the capability. The
 * server resolves the same way, so the document lands exactly where the
 * client's settings live.
 */
export function filesAccountId(ctx: Ctx): string {
  const prim = ctx.session.primaryAccounts?.[FILENODE_CAP];
  if (prim) {
    const account = ctx.session.accounts?.[prim] as { isPersonal?: unknown } | undefined;
    if (account?.isPersonal !== false) return prim;
  }
  for (const [id, acc] of Object.entries(ctx.session.accounts ?? {})) {
    const a = acc as {
      isPersonal?: unknown;
      accountCapabilities?: Record<string, unknown>;
    };
    if (a.isPersonal !== false && a.accountCapabilities?.[FILENODE_CAP]) return id;
  }
  return "";
}

/** One level of the Files tree: the top level, or the children of a folder. */
export async function fileChildren(
  ctx: Ctx,
  accountId: string,
  parentId: string | null,
  properties: string[] = FILE_PROPS,
  limit = 1000,
): Promise<FileNodeLike[]> {
  const filter = parentId ? { parentId } : { isTopLevel: true };
  const res = await clientOf(ctx).chain(
    [
      ["FileNode/query", { accountId, filter, limit }, "q"],
      [
        "FileNode/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" },
          properties,
        },
        "g",
      ],
    ],
    [FILENODE_CAP],
  );
  return res.list<FileNodeLike>("g");
}

/**
 * The FileNode state of an account, which is the CAS token every conditional
 * write compares against: Stalwart keeps one state per type per account, so
 * any node changing invalidates a write that read before it.
 */
export async function appFolderState(ctx: Ctx, accountId: string): Promise<string> {
  const res = await clientOf(ctx).call<{ state?: unknown }>(
    "FileNode/get",
    { accountId, ids: [] },
    [FILENODE_CAP],
  );
  return typeof res.state === "string" ? res.state : "";
}

/** The account's own app folder, or null when there is not one yet. */
export async function findAppFolder(ctx: Ctx, accountId: string): Promise<string | null> {
  const top = await fileChildren(ctx, accountId, null, FOLDER_PROPS);
  const found = top.find(
    (n) => n.parentId == null && n.nodeType === "directory" && n.name === APP_FOLDER_NAME,
  );
  return found ? String(found.id) : null;
}

/** The account's own app folder, creating it when missing. */
export async function ensureAppFolder(ctx: Ctx, accountId: string): Promise<string> {
  const existing = await findAppFolder(ctx, accountId);
  if (existing) return existing;
  const created = await clientOf(ctx).call<{
    created?: Record<string, { id?: string }>;
  }>(
    "FileNode/set",
    {
      accountId,
      create: {
        d: { parentId: null, name: APP_FOLDER_NAME, nodeType: "directory" },
      },
    },
    [FILENODE_CAP],
  );
  const id = created.created?.d?.id;
  if (!id)
    throw new AppFolderError(
      "The mail server created the app folder but returned no id.",
    );
  return id;
}

/** A directory by name under `parentId`, creating it when missing. */
async function ensureChildFolder(
  ctx: Ctx,
  accountId: string,
  parentId: string | null,
  name: string,
): Promise<string> {
  const children = await fileChildren(ctx, accountId, parentId, FOLDER_PROPS);
  const existing = children.find((n) => n.nodeType === "directory" && n.name === name);
  if (existing?.id) return String(existing.id);
  const created = await clientOf(ctx).call<{
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, { type?: string; existingId?: string }>;
  }>(
    "FileNode/set",
    { accountId, create: { d: { parentId, name, nodeType: "directory" } } },
    [FILENODE_CAP],
  );
  const id = created.created?.d?.id;
  /*
   * A create that lost the race is not a failure to report.
   *
   * Creating a folder is a read-then-write that cannot be made conditional (the
   * state a create would carry is the state of the account, which any other
   * write invalidates), so two workers can both find the folder missing and both
   * ask for it. Stalwart refuses the second with `alreadyExists` and names the
   * folder that is there in `existingId` — the one this call was trying to
   * reach. Taking it is the whole answer; the folder a caller asked for exists,
   * which is what it asked for.
   *
   * Without this the refusal is read as "created but no id" and thrown, so a
   * race that is entirely normal would fail one of two callers for no reason a
   * reader could act on.
   */
  if (!id) {
    const refused = created.notCreated?.d;
    if (isAlreadyExistsRefusal(refused)) {
      const named = refused?.existingId ? String(refused.existingId) : undefined;
      if (named) return named;
      const again = await fileChildren(ctx, accountId, parentId, FOLDER_PROPS);
      const theirs = again.find(
        (n) => n.nodeType === "directory" && n.name === name && n.id !== undefined,
      );
      if (theirs?.id) return String(theirs.id);
    }
    throw new AppFolderError(
      `The mail server created the folder "${name}" but returned no id.`,
    );
  }
  /*
   * And the state a duplicate would leave: two directories by one name under
   * one parent.
   *
   * The refusal above is what keeps that from happening on 0.16, so this is a
   * guard rather than a routine: it fires only if a create is accepted while a
   * sibling already carries the name, which a 0.16 server does not do. A
   * second one would make every later lookup pick whichever the server lists
   * first -- the documents would split across two trees and look as if they had
   * vanished -- so the list is re-read, the smaller id wins deterministically
   * (the same one for every caller), and the copy this call created is removed.
   */
  const after = await fileChildren(ctx, accountId, parentId, FOLDER_PROPS);
  const sameName = after
    .filter((n) => n.nodeType === "directory" && n.name === name && n.id !== undefined)
    .map((n) => String(n.id))
    .sort();
  const winner = sameName[0];
  if (sameName.length > 1 && winner !== undefined && winner !== String(id)) {
    await destroyAppNode(ctx, accountId, String(id));
    return winner;
  }
  return id;
}

/**
 * Split an app-folder-relative path into its segments.
 *
 * A `.` or `..` segment is **refused**, not turned into a folder of that name:
 * nothing here can escape the account (every lookup is by parent and name), but
 * a folder literally called `..` in somebody's Files is clutter that came from
 * a bug, and the honest answer is to say so.
 */
export function pathSegments(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => {
      if (s === "." || s === "..")
        throw new AppFolderError(
          `"${s}" cannot be part of a path in Files`,
          400,
          "bad_path",
        );
      return Boolean(s);
    });
}

/**
 * The folder a path names, or null when any segment is missing.
 *
 * Reads go through here rather than through `ensureFolderPath`, so that
 * looking at what an account holds never writes folders into it.
 */
export async function findFolderPath(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<string | null> {
  let current = await findAppFolder(ctx, accountId);
  if (!current) return null;
  for (const segment of pathSegments(path)) {
    const children = await fileChildren(ctx, accountId, current, FOLDER_PROPS);
    const found = children.find((n) => n.nodeType === "directory" && n.name === segment);
    if (!found?.id) return null;
    current = String(found.id);
  }
  return current;
}

/**
 * The folder a path names, creating every segment on the way.
 *
 * `"agent/jobs"` resolves the two directories under the app folder and
 * returns the id of the last one.
 */
export async function ensureFolderPath(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<string> {
  let current = await ensureAppFolder(ctx, accountId);
  for (const segment of pathSegments(path)) {
    current = await ensureChildFolder(ctx, accountId, current, segment);
  }
  return current;
}

/** A named file inside a folder, with the node when it is there. */
export interface AppFileRef {
  /** The folder's id, or null when the folder itself is missing. */
  folderId: string | null;
  file: FileNodeLike | null;
}

/** Find a file by name inside a folder; `folderId` is empty when it is missing. */
async function findInFolder(
  ctx: Ctx,
  accountId: string,
  folderId: string | null,
  name: string,
): Promise<FileNodeLike | null> {
  if (!folderId) return null;
  const files = await fileChildren(ctx, accountId, folderId, FILE_PROPS);
  return (
    files.find(
      (n) => n.nodeType === "file" && n.name === name && typeof n.blobId === "string",
    ) ?? null
  );
}

/**
 * Where a path lives and whether the file is there — without creating
 * anything. `folderId` is null when the folder is missing, `file` when the
 * file is.
 */
export async function findAppFileAt(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<AppFileRef> {
  const segments = pathSegments(path);
  const name = segments.pop();
  if (!name) throw new AppFolderError("a document path needs a file name");
  const folderId = await findFolderPath(ctx, accountId, segments.join("/"));
  return { folderId, file: await findInFolder(ctx, accountId, folderId, name) };
}

/** Upload a JSON body for this principal and return its blob id. */
export async function uploadJsonBlob(
  ctx: Ctx,
  accountId: string,
  value: unknown,
): Promise<string> {
  const blobId = await clientOf(ctx).upload(
    accountId,
    appDocumentJson(value),
    "application/json",
  );
  return blobId;
}

/** Upload raw bytes for this principal and return their blob id. */
export async function uploadBlobBytes(
  ctx: Ctx,
  accountId: string,
  bytes: Uint8Array,
  type: string,
): Promise<string> {
  return clientOf(ctx).upload(accountId, bytes, type);
}

/**
 * Write (or replace) a file at an app-folder-relative path from raw bytes.
 * Used where the content is somebody else's: an extracted attachment keeps
 * its own type and its own bytes.
 */
export async function writeAppBytesAt(
  ctx: Ctx,
  accountId: string,
  path: string,
  bytes: Uint8Array,
  type: string,
): Promise<void> {
  const segments = pathSegments(path);
  const name = segments.pop();
  if (!name) throw new AppFolderError("a document path needs a file name");
  const folderId = await ensureFolderPath(ctx, accountId, segments.join("/"));
  await writeFile(
    ctx,
    accountId,
    folderId,
    name,
    { bytes, upload: () => uploadBlobBytes(ctx, accountId, bytes, type) },
    type,
  );
}

/** Read a blob back as text over the principal's own download path. */
export async function downloadBlobText(
  ctx: Ctx,
  accountId: string,
  blobId: string,
  type: string,
  name = "document.json",
): Promise<string> {
  return clientOf(ctx).downloadText(accountId, blobId, name, type);
}

/** Whether two byte sequences are the same, byte for byte. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * What a write would store, and how to store it if that turns out to be
 * needed.
 *
 * The upload is a thunk rather than a blob id because the decision that it is
 * needed is made in `writeFile` and nowhere else: a caller that had already
 * called `uploadJsonBlob` or `uploadBlobBytes` would have spent the account's
 * upload quota before anything could notice the document was unchanged.
 */
interface PendingWrite {
  /** The bytes a write would store, exactly as they would arrive. */
  bytes: Uint8Array;
  /** Upload those bytes and return the blob id Stalwart hands back. */
  upload: () => Promise<string>;
}

/**
 * Whether the node already holds exactly this document.
 *
 * The comparison is of bytes, not of values: the bytes are what a blob is, and
 * they are fixed by the writer that made them (`appDocumentJson`,
 * `shared/appDocument.ts`), so the same value is always the same bytes and two
 * spellings of one document never look like a change.
 *
 * A node whose `type` is reported and differs is not this document whatever
 * its bytes read — what a file *is* is part of it where a person opens it —
 * and a blob that cannot be read is not equal either: unknown means the write
 * has to happen, because answering "unchanged" would leave the caller's change
 * unwritten.
 */
async function holdsSameDocument(
  ctx: Ctx,
  accountId: string,
  file: FileNodeLike,
  wanted: Uint8Array,
  type: string,
): Promise<boolean> {
  if (typeof file.blobId !== "string") return false;
  const stored = typeof file.type === "string" ? file.type : "";
  if (stored && stored !== type) return false;
  try {
    const bytes = await clientOf(ctx).downloadBlob(
      accountId,
      file.blobId,
      String(file.name ?? "document"),
      type,
    );
    return sameBytes(bytes, wanted);
  } catch {
    return false;
  }
}

/**
 * One file write, whatever the body came from — and the one place that decides
 * a write is not needed.
 *
 * An account's upload quota is spent per blob and nothing ever reclaims one
 * (JMAP offers no blob removal), so a write whose bytes are already stored is
 * pure loss: it buys the same document again and pushes the account towards the
 * quota at which *every* write in it fails. Gilbert rewrites the same documents
 * constantly (a job at every stage of a run, a notebook on every fact, a claim
 * on every tick), so "write what is already there" is the common case, not the
 * exceptional one.
 *
 * The order is what keeps the check cheap where it matters:
 *
 * 1. the node is looked up as the write needed anyway (`size` is one of
 *    `FILE_PROPS`);
 * 2. a `size` that differs — or a node that is not there — already proves the
 *    document changes, so the common changed case costs **nothing beyond that
 *    lookup** and no extra download;
 * 3. only when the sizes agree is the stored blob read back and compared byte
 *    for byte;
 * 4. equal bytes mean the account already holds this document: no upload, and
 *    no `FileNode/set`.
 *
 * Skipping the set is as much of the point as skipping the upload. The account's
 * FileNode state does not advance, so a no-op write cannot invalidate another
 * writer's compare-and-set token — the retry of a write that lost its race
 * rewrites the document it meant to, and when that document is already there
 * the retry is a no-op rather than a bump that costs somebody else their turn.
 *
 * `ifInState` is deliberately not consulted on that path. A conditional write
 * is conditional on what the document *is*, and an unchanged document is not a
 * change to condition: the caller's intent is already true of the account, so
 * the write succeeds with no upload, no set and no token spent — even when the
 * token it passed has since moved on, which is exactly the case that made a
 * retry of an unchanged document look like a failure before.
 *
 * The returned id is the one the write would have returned anyway: the existing
 * node's id when there is one (the update path returned it too), the id the
 * server minted when the name is new.
 */
async function writeFile(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  name: string,
  body: PendingWrite,
  type: string,
  ifInState?: string,
): Promise<string> {
  const file = await findInFolder(ctx, accountId, folderId, name);
  if (
    file?.id &&
    typeof file.size === "number" &&
    file.size === body.bytes.byteLength &&
    (await holdsSameDocument(ctx, accountId, file, body.bytes, type))
  ) {
    return String(file.id);
  }
  const blobId = await body.upload();
  return setFileNode(ctx, accountId, folderId, name, blobId, type, file, ifInState);
}

/**
 * The FileNode half of a write, once its bytes are uploaded.
 *
 * The writers differ only in where their bytes came from and which folder they
 * resolved; the FileNode shape itself — create when the name is new, update
 * when it is taken — exists here and nowhere else. The node the lookup already
 * found is handed in, so one write never asks the account the same question
 * twice.
 */
async function setFileNode(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  name: string,
  blobId: string,
  type: string,
  file: FileNodeLike | null,
  ifInState?: string,
): Promise<string> {
  const conditional = ifInState ? { ifInState } : {};
  const client = clientOf(ctx);
  // The bytes are already uploaded by the caller, and JMAP has no blob removal
  // to offer: a write that fails afterwards — a lost compare-and-set, a refused
  // permission — leaves a blob nothing refers to. It is the server's to
  // collect, and the alternative (uploading after the node exists) trades it
  // for a node with no bytes, which is worse.
  if (file?.id) {
    await client.call(
      "FileNode/set",
      { accountId, ...conditional, update: { [String(file.id)]: { blobId, type } } },
      [FILENODE_CAP],
    );
    return String(file.id);
  }
  // The node the write made comes back, because a caller that has to say what
  // it wrote — the trail, and the lineage a chain is read along — can only name
  // an id the server gave it.
  const created = await client.call<{ created?: Record<string, { id?: unknown }> }>(
    "FileNode/set",
    {
      accountId,
      ...conditional,
      create: { n: { parentId: folderId, name, blobId, type, nodeType: "file" } },
    },
    [FILENODE_CAP],
  );
  const id = created.created?.n?.id;
  return typeof id === "string" ? id : "";
}

/**
 * Write (or replace) a named file in a folder, creating the folder when
 * missing. `ifInState` makes the write conditional: the server refuses it if
 * any FileNode in the account changed since that state was read, which is the
 * compare-and-set JMAP offers in place of a lock.
 */
export async function writeAppFileIn(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  name: string,
  value: unknown,
  opts: { ifInState?: string; type?: string } = {},
): Promise<void> {
  const type = opts.type ?? "application/json";
  // The bytes this document is about to be written as, before any of them are
  // uploaded: the same serialization `uploadJsonBlob` sends
  // (`appDocumentJson`), so what is compared is what would be stored.
  const bytes = utf8.encode(appDocumentJson(value));
  await writeFile(
    ctx,
    accountId,
    folderId,
    name,
    { bytes, upload: () => uploadJsonBlob(ctx, accountId, value) },
    type,
    opts.ifInState,
  );
}

/** Write (or replace) a document at an app-folder-relative path. */
export async function writeAppFileAt(
  ctx: Ctx,
  accountId: string,
  path: string,
  value: unknown,
  opts: { ifInState?: string; type?: string } = {},
): Promise<void> {
  const segments = pathSegments(path);
  const name = segments.pop();
  if (!name) throw new AppFolderError("a document path needs a file name");
  const folderId = await ensureFolderPath(ctx, accountId, segments.join("/"));
  await writeAppFileIn(ctx, accountId, folderId, name, value, opts);
}

/**
 * Write (or replace) a named document in the app folder's own top level.
 * The settings-shaped documents (the directive, a label catalog, the
 * published policy and the job that wrote it) live there. `ifInState` makes
 * the write conditional on the account's FileNode state, exactly as it does
 * for `writeAppFileAt` above.
 */
export async function writeAppFile(
  ctx: Ctx,
  accountId: string,
  name: string,
  value: unknown,
  opts: { ifInState?: string; type?: string } = {},
): Promise<void> {
  const folderId = await ensureAppFolder(ctx, accountId);
  await writeAppFileIn(ctx, accountId, folderId, name, value, opts);
}

/** Read a document at a path, or null when it is not there. */
export async function readAppFileAt(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<{ text: string; file: FileNodeLike } | null> {
  const { file } = await findAppFileAt(ctx, accountId, path);
  if (!file) return null;
  const type =
    typeof file.type === "string" && file.type ? file.type : "application/json";
  const text = await downloadBlobText(
    ctx,
    accountId,
    String(file.blobId),
    type,
    String(file.name ?? "document.json"),
  );
  return { text, file };
}

/** Read and parse a JSON document, or null when it is absent or unreadable. */
export async function readAppJsonAt(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<unknown | null> {
  try {
    const found = await readAppFileAt(ctx, accountId, path);
    if (!found) return null;
    return JSON.parse(found.text) as unknown;
  } catch {
    // An unreadable document is treated as absent by every caller here: the
    // alternative is a corrupt file taking a whole surface down.
    return null;
  }
}

/** The nodes directly inside an app-folder-relative directory; empty when absent. */
export async function listAppDir(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<FileNodeLike[]> {
  const folderId = await findFolderPath(ctx, accountId, path);
  if (!folderId) return [];
  return fileChildren(ctx, accountId, folderId);
}

/**
 * A folder at the top of the account's Files — the tree a reader sees.
 *
 * Everything else in this module works inside the hidden `gilbert` app folder,
 * which the client's Files view deliberately does not show. A file that is
 * *for a person* — an attachment extracted out of a message — belongs in the
 * visible tree instead, in a folder the rule or the model named.
 */
export async function ensureRootFolder(
  ctx: Ctx,
  accountId: string,
  name: string,
): Promise<string> {
  return ensureChildFolder(ctx, accountId, null, name);
}

/** The same, for a path of folders under the visible root: `"invoices/2026"`. */
export async function ensureRootFolderPath(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<string> {
  let current: string | null = null;
  for (const segment of visibleSegments(path)) {
    current = await ensureChildFolder(ctx, accountId, current, segment);
  }
  if (current === null) throw new AppFolderError("a folder path needs a name");
  return current;
}

/**
 * Read a file from the account's visible Files, or null when it is not there.
 *
 * The twin of `readAppFileAt` for the tree a reader sees: the agent's own
 * documents live in the app folder, and the two trees never overlap.
 */
export async function readVisibleFileAt(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<{ text: string; file: FileNodeLike } | null> {
  const found = await readVisibleFileBytes(ctx, accountId, path);
  if (!found) return null;
  return { text: new TextDecoder().decode(found.bytes), file: found.file };
}

/**
 * The bytes of a file in the account's visible Files, or null when it is not
 * there.
 *
 * The primitive the readers of the visible tree are built on, because bytes
 * are what a file is: text is a decode of them, and a PDF, a `.docx` or an
 * image is nothing else (ADR 0003: the document family works on the blob).
 */
export async function readVisibleFileBytes(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<{ bytes: Uint8Array; file: FileNodeLike; name: string } | null> {
  const found = await findVisibleFile(ctx, accountId, path);
  if (!found) return null;
  const type =
    typeof found.file.type === "string" && found.file.type
      ? found.file.type
      : "application/octet-stream";
  const bytes = await clientOf(ctx).downloadBlob(
    accountId,
    String(found.file.blobId),
    found.name,
    type,
  );
  return { bytes, file: found.file, name: found.name };
}

/**
 * The node a visible path names, without reading its bytes.
 *
 * The one walk of the visible tree: the reader above and the writer that has to
 * avoid a name already taken both go through it, so "is this path taken" means
 * the same thing to both.
 */
export async function findVisibleFile(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<{ file: FileNodeLike; name: string } | null> {
  const segments = visibleSegments(path);
  const name = segments.pop();
  if (!name) throw new AppFolderError("a document path needs a file name");
  let folderId: string | null = null;
  for (const segment of segments) {
    const children = await fileChildren(ctx, accountId, folderId, FOLDER_PROPS);
    const found = children.find((n) => n.nodeType === "directory" && n.name === segment);
    if (!found?.id) return null;
    folderId = String(found.id);
  }
  const file = await findInFolder(ctx, accountId, folderId, name);
  return file ? { file, name } : null;
}

/**
 * A name in a visible folder that nothing is using yet.
 *
 * A file a person filed is theirs: an automation that saves under a name
 * already taken there adds a numbered one beside it instead of replacing what
 * they have. `note.txt`, `2-note.txt`, `3-note.txt` — the same shape the
 * extract action uses for two attachments that arrive with one name.
 */
export async function unusedVisibleName(
  ctx: Ctx,
  accountId: string,
  folderPath: string,
  name: string,
): Promise<string> {
  const folder = folderPath.replace(/\/+$/, "");
  if (!(await findVisibleFile(ctx, accountId, `${folder}/${name}`))) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${n}-${name}`;
    if (!(await findVisibleFile(ctx, accountId, `${folder}/${candidate}`)))
      return candidate;
  }
  throw new AppFolderError(
    `"${folder}" already holds a thousand files by the name of "${name}"`,
    409,
    "name_taken",
  );
}

/**
 * Write a file into a folder of the account's **visible** Files, creating the
 * folder when it is missing.
 *
 * This is the writer for anything a member is meant to find in Files; the
 * app-folder writers above are for Gilbert's own documents.
 */
export async function writeBytesIntoVisibleFolder(
  ctx: Ctx,
  accountId: string,
  folderPath: string,
  name: string,
  bytes: Uint8Array,
  type: string,
): Promise<string> {
  const folderId = await ensureRootFolderPath(ctx, accountId, folderPath);
  return writeFile(
    ctx,
    accountId,
    folderId,
    name,
    { bytes, upload: () => uploadBlobBytes(ctx, accountId, bytes, type) },
    type,
  );
}

/**
 * A path in the visible tree, refusing the app folder's own names.
 *
 * The app folder sits at the top of the same tree — that is what makes its
 * contents durable in the account — so a path that names it would write a
 * person's file into Gilbert's private documents, or read them back out. The
 * refusal is by name, because a model choosing a folder (`mail.extract`) is a
 * caller that can name anything.
 */
function visibleSegments(path: string): string[] {
  const segments = pathSegments(path);
  const first = segments[0];
  if (first === APP_FOLDER_NAME) {
    throw new AppFolderError(
      `"${first}" is Gilbert's own folder and cannot be a destination in Files.`,
      400,
      "reserved_folder",
    );
  }
  return segments;
}

/**
 * Remove a node by id. Missing is success: nothing to remove, nothing to say.
 *
 * `ifInState` makes the removal conditional on the account state it was
 * decided against, which is what a writer that must not remove a node somebody
 * else has since replaced needs — an agent releasing a claim, above all.
 */
export async function destroyAppNode(
  ctx: Ctx,
  accountId: string,
  id: string,
  opts: { ifInState?: string } = {},
): Promise<void> {
  await clientOf(ctx).call(
    "FileNode/set",
    {
      accountId,
      ...(opts.ifInState ? { ifInState: opts.ifInState } : {}),
      destroy: [id],
    },
    [FILENODE_CAP],
  );
}
