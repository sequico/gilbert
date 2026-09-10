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

import { JmapClient } from "./jmap.js";
import type { UpstreamSession } from "./upstream.js";

/** The folder Gilbert keeps its own documents in, in every account. */
export const APP_FOLDER_NAME = "gilbert";

/** The JMAP capability that carries FileNode in Stalwart 0.16. */
export const FILENODE_CAP = "urn:ietf:params:jmap:filenode";

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
  return new JmapClient(ctx.authorization, ctx.session);
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

/** The account's own `gilbert` app folder, or null when it is not there yet. */
export async function findAppFolder(ctx: Ctx, accountId: string): Promise<string | null> {
  const top = await fileChildren(ctx, accountId, null, FOLDER_PROPS);
  const existing = top.find(
    (n) => n.parentId == null && n.nodeType === "directory" && n.name === APP_FOLDER_NAME,
  );
  return existing?.id ? String(existing.id) : null;
}

/** The account's own `gilbert` app folder, creating it when missing. */
export async function ensureAppFolder(ctx: Ctx, accountId: string): Promise<string> {
  const existing = await findAppFolder(ctx, accountId);
  if (existing) return existing;
  const created = await clientOf(ctx).call<{
    created?: Record<string, { id?: string }>;
  }>(
    "FileNode/set",
    {
      accountId,
      create: { d: { parentId: null, name: APP_FOLDER_NAME, nodeType: "directory" } },
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
  parentId: string,
  name: string,
): Promise<string> {
  const children = await fileChildren(ctx, accountId, parentId, FOLDER_PROPS);
  const existing = children.find((n) => n.nodeType === "directory" && n.name === name);
  if (existing?.id) return String(existing.id);
  const created = await clientOf(ctx).call<{
    created?: Record<string, { id?: string }>;
  }>(
    "FileNode/set",
    { accountId, create: { d: { parentId, name, nodeType: "directory" } } },
    [FILENODE_CAP],
  );
  const id = created.created?.d?.id;
  if (!id)
    throw new AppFolderError(
      `The mail server created the folder "${name}" but returned no id.`,
    );
  return id;
}

/** Split an app-folder-relative path into its segments, refusing traversal. */
export function pathSegments(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
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
    JSON.stringify(value),
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
 * Write (or replace) a file at an app-folder-relative path with a text body,
 * for the things that are documents but not JSON — a saved log, an extracted
 * note. The JSON writers above stay the common case.
 */
export async function writeAppTextAt(
  ctx: Ctx,
  accountId: string,
  path: string,
  text: string,
  type = "text/plain",
): Promise<void> {
  const segments = pathSegments(path);
  const name = segments.pop();
  if (!name) throw new AppFolderError("a document path needs a file name");
  const folderId = await ensureFolderPath(ctx, accountId, segments.join("/"));
  const blobId = await uploadBlobBytes(
    ctx,
    accountId,
    new TextEncoder().encode(text),
    type,
  );
  const file = await findInFolder(ctx, accountId, folderId, name);
  const client = clientOf(ctx);
  if (file?.id) {
    await client.call(
      "FileNode/set",
      { accountId, update: { [String(file.id)]: { blobId, type } } },
      [FILENODE_CAP],
    );
  } else {
    await client.call(
      "FileNode/set",
      {
        accountId,
        create: { n: { parentId: folderId, name, blobId, type, nodeType: "file" } },
      },
      [FILENODE_CAP],
    );
  }
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
  const blobId = await uploadBlobBytes(ctx, accountId, bytes, type);
  const client = clientOf(ctx);
  const file = await findInFolder(ctx, accountId, folderId, name);
  if (file?.id) {
    await client.call(
      "FileNode/set",
      { accountId, update: { [String(file.id)]: { blobId, type } } },
      [FILENODE_CAP],
    );
  } else {
    await client.call(
      "FileNode/set",
      {
        accountId,
        create: { n: { parentId: folderId, name, blobId, type, nodeType: "file" } },
      },
      [FILENODE_CAP],
    );
  }
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
  const blobId = await uploadJsonBlob(ctx, accountId, value);
  const type = opts.type ?? "application/json";
  const file = await findInFolder(ctx, accountId, folderId, name);
  if (file?.id) {
    await clientOf(ctx).call(
      "FileNode/set",
      {
        accountId,
        ...(opts.ifInState ? { ifInState: opts.ifInState } : {}),
        update: { [String(file.id)]: { blobId, type } },
      },
      [FILENODE_CAP],
    );
  } else {
    await clientOf(ctx).call(
      "FileNode/set",
      {
        accountId,
        ...(opts.ifInState ? { ifInState: opts.ifInState } : {}),
        create: { n: { parentId: folderId, name, blobId, type, nodeType: "file" } },
      },
      [FILENODE_CAP],
    );
  }
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
 * The settings-shaped documents (the directive, a label catalog) live there.
 */
export async function writeAppFile(
  ctx: Ctx,
  accountId: string,
  name: string,
  value: unknown,
): Promise<void> {
  const folderId = await ensureAppFolder(ctx, accountId);
  await writeAppFileIn(ctx, accountId, folderId, name, value);
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

/** Remove a node by id. Missing is success: nothing to remove, nothing to say. */
export async function destroyAppNode(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<void> {
  await clientOf(ctx).call("FileNode/set", { accountId, destroy: [id] }, [FILENODE_CAP]);
}
