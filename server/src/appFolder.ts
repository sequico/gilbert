/**
 * The account's own `gilbert` app folder in JMAP Files, reached over JMAP.
 *
 * Every durable document Gilbert keeps in Stalwart's own storage lives here:
 * the synced settings, the forced-password-change directive, a group's label
 * catalog and the chat folders. One implementation, because all of them need
 * the same things and each one of them would get them subtly differently.
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
 * The paths below are app-folder-relative: `"workorders/closed/abc.json"` means
 * the file `abc.json` inside `closed` inside `workorders`, all inside
 * `gilbert`. Missing
 * folders on the way are created on demand, which is what makes a document
 * write a single call at the call site.
 */

import { isAlreadyExistsRefusal } from "./jmap.js";
import { recalled } from "./requestMemory.js";
import { ownAccountForCapability } from "./shared/accountRouting.js";
import { appDocumentJson } from "./shared/appDocument.js";
import {
  APP_DOCUMENT_TYPE,
  APP_FOLDER_NAME,
  appFolderCreate,
  ensureAppFolderId,
  FILE_PROPS,
  FILENODE_GET,
  FILENODE_QUERY,
  FILENODE_SET,
  FOLDER_PROPS,
  findAppFolderId,
} from "./shared/appFolder.js";
import { sameBytes } from "./shared/bytes.js";
import { CAPABILITIES } from "./shared/capabilities.js";
import { refusalOf, type SetResponse } from "./shared/jmap.js";
import { queryThenGet } from "./shared/jmapQuery.js";
import type { UpstreamSession } from "./upstream.js";
import { clientOf } from "./util.js";

/** The media type these documents are, when a node does not state one. */
export const DOCUMENT_TYPE_DEFAULT = "application/json";

/**
 * The media type a document node is read or written as: its own when it has
 * one, the JSON these documents are otherwise.
 *
 * Read in three places (the app-folder read, the account's own document read,
 * the knowledge base's revision read), and the fallback is the same one the
 * writer uses (`DOCUMENT_TYPE_DEFAULT`): a reader that guessed a different type
 * would download the bytes as something they are not.
 */
export function documentType(file: { type?: unknown }): string {
  return typeof file.type === "string" && file.type ? file.type : DOCUMENT_TYPE_DEFAULT;
}

/** The one encoder: what a document is about to be written as is bytes. */
const utf8 = new TextEncoder();

/** The JMAP capability that carries FileNode in Stalwart 0.16. */
export const FILENODE_CAP = CAPABILITIES.filenode;

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
  modified?: unknown;
}

/** What every caller of this module needs to talk to Stalwart. */
export interface Ctx {
  authorization: string;
  session: UpstreamSession;
  username: string;
}

/**
 * The account that owns this principal's Files.
 *
 * The reader's own Files account, by the one rule for that question
 * (`shared/accountRouting.ts`, `ownAccountForCapability`): the client and this
 * tier ask it the same way on purpose, so a document lands exactly where the
 * client's settings live.
 */
export function filesAccountId(ctx: Ctx): string {
  return ownAccountForCapability(ctx.session, FILENODE_CAP) ?? "";
}

/**
 * A node's own last-write stamp: `modified`, falling back to `created`.
 *
 * The pair the Files view sorts a node by, and the pair every registry here
 * cuts its newest-first page on — the workorder roots, the knowledge articles
 * and their revisions. Each had its own copy of the same two lines, in the
 * knowledge admin written as `node.modified ?? node.created` and in the
 * workorder admin as two `typeof` checks, which agree today and would not have
 * to: a node whose `modified` is present but not a string is a page this build
 * has to place anyway, and the two readers placed it differently.
 *
 * A node carrying neither stamp is a node the server has not stamped; it sorts
 * as the empty string, last, rather than throwing the page away.
 */
export function nodeStamp(node: FileNodeLike): string {
  if (typeof node.modified === "string") return node.modified;
  if (typeof node.created === "string") return node.created;
  return "";
}

/**
 * One level of the Files tree: the top level, or the children of a folder.
 *
 * Read whole: the level is paged (`position`/`limit`) until a page comes back
 * short, because a level that outgrows one page is an ordinary state here — a
 * chat that keeps one file per message, an article's revisions, an agent's
 * jobs, the workorder registry — and a reader handed only the first page sees
 * an arbitrary subset of it. A name a writer then failed to find would be
 * created again over a document that is already there.
 *
 * The page is the widest the server will resolve in one `/get` (see below): the
 * pair asks for ids and then for those objects, and a page the server cannot
 * resolve is refused whole rather than cut short. A page that repeats the
 * previous one — a server ignoring `position` — is a failure rather than a loop.
 * Nobody chooses the page size, because nobody wants a part of a level: a caller
 * that shows the first twenty entries bounds what it *renders*, never what it
 * reads, and a smaller page would only be more round trips.
 */
export async function fileChildren(
  ctx: Ctx,
  accountId: string,
  parentId: string | null,
  properties: string[] = FILE_PROPS,
): Promise<FileNodeLike[]> {
  const props = readProps(properties);
  /*
   * One listing per folder per request.
   *
   * Resolving one request's documents -- a workorder, its parts, the template it
   * instantiates -- walks the same levels over and over, and every walk is a
   * query and a get against the mail server. A single click on a checklist step
   * asked it a hundred times, and the read is the same answer every time. The
   * level is remembered for as long as the request runs and no longer, so no
   * reader can be handed a listing from before its own request began; a write
   * forgets it (`requestMemory.ts`), which is what makes a listing wrong.
   *
   * The read asks for `readProps(properties)` -- `FILE_PROPS` when the caller
   * asked for less, so the folder lookups and the file lookups are answered by
   * one read; a caller asking for anything else is remembered under its own key.
   *
   * The answer is copied out, so a caller that changes the list it was
   * given does not change the memory -- the nodes in it are shared, and none is
   * written to by a reader today.
   */
  const level = await recalled(
    ctx,
    `${accountId}\u0000${parentId ?? ""}\u0000${props.join(",")}`,
    () => readLevel(ctx, accountId, parentId, props),
  );
  return [...level];
}

/** The level as the mail server has it: one page after another, to the end. */
async function readLevel(
  ctx: Ctx,
  accountId: string,
  parentId: string | null,
  props: string[],
): Promise<FileNodeLike[]> {
  const filter = parentId ? { parentId } : { isTopLevel: true };
  const client = clientOf(ctx);
  // The server states its own ceiling, and a level past it is read in pages of
  // that size: asking for more is not a shorter answer but a refused call. The
  // pair clamps the query to the same ceiling itself (`queryThenGet`); `size` is
  // what this loop measures a short page against.
  // The page is the widest the server will resolve in one `/get`, so a level
  // costs the fewest round trips it can: a smaller page is not a shorter answer,
  // only more calls.
  const size = client.maxObjectsInGet;
  const out: FileNodeLike[] = [];
  let seenFirst: unknown;
  for (let position = 0; ; ) {
    const res = await client.chain(
      queryThenGet({
        query: FILENODE_QUERY,
        get: FILENODE_GET,
        accountId,
        filter,
        position,
        limit: size,
        maxObjectsInGet: client.maxObjectsInGet,
        properties: props,
      }),
      [FILENODE_CAP],
    );
    const page = res.list<FileNodeLike>("g");
    if (!page.length) break;
    if (page[0]?.id === seenFirst && typeof page[0]?.id === "string")
      throw new AppFolderError(
        "The mail server answered the same page twice while listing a folder.",
      );
    seenFirst = page[0]?.id;
    out.push(...page);
    position += page.length;
    if (page.length < size) break;
  }
  return out;
}

/*
 * The properties a level is read with: the caller's own, widened to
 * `FILE_PROPS` when the caller asked for less. `FILE_PROPS` carries everything
 * `FOLDER_PROPS` names, so the folder lookups and the file lookups share one
 * read; a caller asking for something else (`created`, `state`) is read as
 * itself, and its answer is remembered under its own key.
 */
function readProps(properties: string[]): string[] {
  return properties.every((property) => FILE_PROPS.includes(property))
    ? FILE_PROPS
    : [...new Set([...FILE_PROPS, ...properties])];
}

/**
 * The FileNode state of an account, which is the CAS token every conditional
 * write compares against: Stalwart keeps one state per type per account, so
 * any node changing invalidates a write that read before it.
 */
export async function appFolderState(ctx: Ctx, accountId: string): Promise<string> {
  const res = await clientOf(ctx).call<{ state?: unknown }>(
    FILENODE_GET,
    { accountId, ids: [] },
    [FILENODE_CAP],
  );
  return typeof res.state === "string" ? res.state : "";
}

/**
 * The account's own app folder, or null when there is not one yet.
 *
 * What the folder *is* is `@gilbert/shared/appFolder`'s rule, which the client
 * asks as well: this is that rule over this tier's transport.
 */
export async function findAppFolder(ctx: Ctx, accountId: string): Promise<string | null> {
  return findAppFolderId((parentId) =>
    fileChildren(ctx, accountId, parentId, FOLDER_PROPS),
  );
}

/** The account's own app folder, creating it when missing. */
export async function ensureAppFolder(ctx: Ctx, accountId: string): Promise<string> {
  return ensureAppFolderId(
    (parentId) => fileChildren(ctx, accountId, parentId, FOLDER_PROPS),
    async () => {
      const created = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
        FILENODE_SET,
        { accountId, create: { d: appFolderCreate() } },
        [FILENODE_CAP],
      );
      const id = created.created?.d?.id;
      if (id) return String(id);
      /*
       * A create that lost the race is not a failure to report, for the same
       * reason `ensureChildFolder` says below: two processes booting on a fresh
       * account both find the folder missing and both ask for it, and the
       * server refuses the second with `alreadyExists`, naming the folder that
       * is there. That folder is the one this call wanted.
       */
      const refused = created.notCreated?.d;
      if (isAlreadyExistsRefusal(refused)) {
        const named = refused?.existingId;
        if (named) return named;
        const again = await findAppFolder(ctx, accountId);
        if (again) return again;
      }
      throw new AppFolderError(
        "The mail server created the app folder but returned no id.",
      );
    },
  );
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
  const created = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
    FILENODE_SET,
    { accountId, create: { d: { parentId, name, nodeType: "directory" } } },
    [FILENODE_CAP],
  );
  const id = created.created?.d?.id;
  /*
   * A create that lost the race is not a failure to report.
   *
   * Creating a folder is a read-then-write that cannot be made conditional (the
   * state a create would carry is the state of the account, which any other
   * write invalidates), so two agents can both find the folder missing and both
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
 * `"workorders/closed"` resolves the two directories under the app folder and
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

/**
 * Find a file by name inside a folder; `folderId` is null for the top level.
 *
 * The caller has already decided that the folder is where it means: this does
 * not fail closed on a null id, because the visible tree's top level *is* null
 * and a file a person put there is as real as one in a folder. A caller whose
 * null means "a segment was missing" returns before it gets here.
 */
async function findInFolder(
  ctx: Ctx,
  accountId: string,
  folderId: string | null,
  name: string,
): Promise<FileNodeLike | null> {
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
  // A hidden path is always inside the app folder, so a null here is a segment
  // that is not there — not the top level, which is what null means in Files.
  if (folderId === null) return { folderId: null, file: null };
  return { folderId, file: await findInFolder(ctx, accountId, folderId, name) };
}

/**
 * Remove a document by path, if it is there.
 *
 * Absent is success: releasing a lock or clearing a directive that was never
 * written is not an error. One definition of "find the node, destroy it", so a
 * caller does not repeat the two steps and forget the absent case.
 */
export async function removeAppFile(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<void> {
  const { file } = await findAppFileAt(ctx, accountId, path);
  if (!file?.id) return;
  await destroyAppNode(ctx, accountId, String(file.id));
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
    APP_DOCUMENT_TYPE,
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
 * constantly (a settings save, a label edit, a workorder step), so "write what
 * is already there" is the common case, not the exceptional one.
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
 * server minted when the name is new — or the node already carrying the name,
 * when that create was refused and the write recovered onto it.
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
  let id = file?.id ? String(file.id) : "";
  if (!id) {
    // The node the write made comes back, because a caller that has to say what
    // it wrote — the trail, and the lineage a chain is read along — can only
    // name an id the server gave it.
    const created = await client.call<SetResponse<{ id?: unknown }>>(
      FILENODE_SET,
      {
        accountId,
        ...conditional,
        create: { n: { parentId: folderId, name, blobId, type, nodeType: "file" } },
      },
      [FILENODE_CAP],
    );
    const createdId = created.created?.n?.id;
    if (typeof createdId === "string") return createdId;
    const refused = created.notCreated?.n;
    /*
     * A create refused because a sibling already carries the name is the
     * document this call was writing, made by whoever won the race: the lookup
     * this write began with ran before that node existed, so the name was free
     * then and collides now. Taking the node that is there and writing these
     * bytes into it is the whole answer — the name the caller asked for then
     * holds what the caller asked it to hold.
     *
     * `existingId` names that node when the create met a committed sibling, and
     * is absent when it collided with one made earlier in the same request
     * (`isAlreadyExistsRefusal`); re-reading the folder is the fallback, and it
     * is also the last thing that can be done before the refusal is thrown.
     */
    if (isAlreadyExistsRefusal(refused)) {
      const existing =
        refused?.existingId ?? (await findInFolder(ctx, accountId, folderId, name))?.id;
      if (existing) id = String(existing);
    }
    if (!id)
      throw new AppFolderError(
        refused
          ? refusalOf(refused)
          : "The mail server accepted the write but returned no node id.",
      );
  }
  /*
   * The write itself, one call for both ways in: the id is the node the lookup
   * found, or the one a refused create was recovered onto. A refusal lands in
   * `notUpdated` in an otherwise successful response, so a caller told the
   * write succeeded would be told so about nothing; it is thrown instead.
   */
  const res = await client.call<SetResponse>(
    FILENODE_SET,
    { accountId, ...conditional, update: { [id]: { blobId, type } } },
    [FILENODE_CAP],
  );
  const refusedUpdate = res.notUpdated?.[id];
  if (refusedUpdate) throw new AppFolderError(refusalOf(refusedUpdate));
  return id;
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
  const type = opts.type ?? DOCUMENT_TYPE_DEFAULT;
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
  const type = documentType(file);
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
    // A *reader* wants the two answers together: the alternative is a corrupt
    // file taking a whole surface down. A read-modify-write must not, and asks
    // `readAppJsonForWrite` instead of guessing which one this was.
    return null;
  }
}

/**
 * Whether a document is absent or merely unreadable, for a writer that is
 * about to replace it.
 *
 * `readAppJsonAt` answers `null` to both, which is what a reader wants — a
 * corrupt document must not take a surface down. A read-modify-write wants the
 * opposite: only a document that is **not there** may be replaced by the change
 * the writer was going to make, and one it could not read is not this writer's
 * to throw away. Answering `unreadable` for a listing that failed, a download
 * that failed, and bytes that are not JSON — each of them a document that may
 * well exist — is the whole of the difference.
 *
 * `absent` is what the listing of the holding folder says: a node the walk does
 * not recognise as a file reads the same way as nothing there. The writer then
 * creates its document rather than replacing one — the failure that costs.
 * Nothing about that is new here; the difference is that the answer is now
 * stated rather than folded into `null`.
 */
export type AppDocumentRead =
  | { kind: "ok"; doc: unknown }
  | { kind: "absent" }
  | { kind: "unreadable" };

export async function readAppJsonForWrite(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<AppDocumentRead> {
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, path);
  } catch {
    return { kind: "unreadable" };
  }
  if (!found) return { kind: "absent" };
  try {
    return { kind: "ok", doc: JSON.parse(found.text) as unknown };
  } catch {
    return { kind: "unreadable" };
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
 * image is nothing else.
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
 * The node a visible folder path names: its id, `null` for the top level, or
 * `undefined` when a segment is not there.
 *
 * The one walk of the visible tree's folders, so "which folder is this" means
 * one thing to the reader that lists a folder and to the reader that finds a
 * file in it. The three answers are three because the top level is a real
 * place: `null` is the root of Files, and only `undefined` is a miss.
 */
export async function findVisibleFolder(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<string | null | undefined> {
  let folderId: string | null = null;
  for (const segment of visibleSegments(path)) {
    const children = await fileChildren(ctx, accountId, folderId, FOLDER_PROPS);
    const found = children.find((n) => n.nodeType === "directory" && n.name === segment);
    if (!found?.id) return undefined;
    folderId = String(found.id);
  }
  return folderId;
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
  const folderId = await findVisibleFolder(ctx, accountId, segments.join("/"));
  if (folderId === undefined) return null;
  const file = await findInFolder(ctx, accountId, folderId, name);
  return file ? { file, name } : null;
}

/**
 * A name in a visible folder that nothing is using yet.
 *
 * A file a person filed is theirs: a save under a name already taken there
 * adds a numbered one beside it instead of replacing what they have.
 * `note.txt`, `2-note.txt`, `3-note.txt` — the same shape the
 * extract action uses for two attachments that arrive with one name.
 *
 * The folder is read **once**, and the first free candidate is picked from that
 * listing. Looking each candidate up on its own would walk the folder path from
 * the root for every number it tried, so an extract into a folder already
 * holding hundreds of `n-note.txt` files would cost hundreds of round trips and
 * could be refused part-way through.
 */
export async function unusedVisibleName(
  ctx: Ctx,
  accountId: string,
  folderPath: string,
  name: string,
): Promise<string> {
  if (!name) throw new AppFolderError("a document path needs a file name");
  const folder = folderPath.replace(/\/+$/, "");
  const folderId = await findVisibleFolder(ctx, accountId, folder);
  // A folder the caller names is one it is about to write into, so a miss is a
  // folder not made yet: it holds nothing, and the name is free as it stands.
  if (folderId === undefined) return name;
  // Only a file with bytes counts as taken -- the same node `findVisibleFile`
  // reads -- so a directory that happens to carry the name does not push the
  // new file to a numbered one.
  const taken = new Set(
    (await fileChildren(ctx, accountId, folderId, FILE_PROPS))
      .filter((n) => n.nodeType === "file" && typeof n.blobId === "string")
      .map((n) => String(n.name)),
  );
  if (!taken.has(name)) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${n}-${name}`;
    if (!taken.has(candidate)) return candidate;
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
 * else has since replaced needs.
 */
export async function destroyAppNode(
  ctx: Ctx,
  accountId: string,
  id: string,
  opts: { ifInState?: string; removeChildren?: boolean } = {},
): Promise<void> {
  const res = await clientOf(ctx).call<SetResponse>(
    FILENODE_SET,
    {
      accountId,
      ...(opts.ifInState ? { ifInState: opts.ifInState } : {}),
      // A folder that still holds something is refused without this, and the
      // folder then goes with everything under it (Stalwart 0.16).
      ...(opts.removeChildren ? { onDestroyRemoveChildren: true } : {}),
      destroy: [id],
    },
    [FILENODE_CAP],
  );
  /*
   * A refusal lands in `notDestroyed` in an otherwise successful response, and
   * reading only the call's own success would report a removal that never
   * happened — a folder still holding something, a lost compare-and-set, a
   * permission. `notFound` is not one of those: the node is already gone, which
   * is the absence the doc above calls success.
   */
  const refused = res.notDestroyed?.[id];
  if (refused && refused.type !== "notFound")
    throw new AppFolderError(refusalOf(refused));
}

/**
 * Move or rename a node.
 *
 * Beside the destroy because it is the other way a level's membership changes.
 * `ifInState` is the conditional the caller read -- the three callers hold the
 * state of the account they are writing in -- and the refusal comes back for the
 * caller to name in its own words.
 */
export async function updateAppNode(
  ctx: Ctx,
  accountId: string,
  id: string,
  change: { name?: string; parentId?: string },
  ifInState: string,
): Promise<SetResponse> {
  return await clientOf(ctx).call<SetResponse>(
    FILENODE_SET,
    { accountId, ifInState, update: { [id]: change } },
    [FILENODE_CAP],
  );
}
