import { FILENODE_GET, FILENODE_SET, isAppFolder } from "@gilbert/shared/appFolder";
import { errorMessage } from "@gilbert/shared/errors";
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { listChildrenWithState } from "@/lib/appFolder";
import {
  directoryCreate,
  fileCreate,
  fileNodeProps,
  isAlreadyExists,
  NameTakenError,
} from "@/lib/filenode";
import { t as translate } from "@/lib/i18n";
import type { FilesSet } from "./types";

/**
 * Drop the client's own app folder, and everything inside it, from a listing.
 * It holds signature images, the synced settings file, a group's chat
 * transcript — real nodes in the account, but housekeeping rather than anything
 * the user filed. The folder itself is dropped, by name (see `appFolder.ts`).
 *
 * The contents have to go too: the tree attaches a node whose parent is missing
 * to the root, so hiding the folder alone would spill its files into the top
 * level, which is worse than showing the folder.
 */
export function withoutAppFolder(nodes: FileNode[]): FileNode[] {
  const hidden = new Set<Id>();
  for (const n of nodes) if (isAppFolder(n)) hidden.add(n.id);
  if (!hidden.size) return nodes;
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes) {
      if (!hidden.has(n.id) && n.parentId && hidden.has(n.parentId)) {
        hidden.add(n.id);
        grew = true;
      }
    }
  }
  return nodes.filter((n) => !hidden.has(n.id));
}

/**
 * The state that belongs to one account, emptied when the selection moves.
 *
 * Every field here describes somebody's files, so none of it survives a switch
 * to somebody else's. `treeLoaded` is the one that bites: leave it true and the
 * sidebar never asks the new account for its folders, while `dirIds` still
 * names the old account's, which no longer resolve -- so the tree is simply
 * empty, with nothing to say why. That is what this exists to prevent: the
 * test asserts the whole set, so a field added to the store and forgotten here
 * fails rather than quietly persisting across accounts.
 */
export function emptyForAccount(accountId: Id | null) {
  return {
    accountId,
    nodes: {},
    children: {},
    dirIds: [],
    treeLoaded: false,
    draggingIds: [],
    error: null,
  };
}

/**
 * What a name refused for being taken is called, in one place.
 *
 * The reader is told which file it was, and the two writers that still refuse a
 * name say it here rather than in two sentences of their own: saving an
 * attachment must not touch a file somebody already keeps under that name, and
 * neither writer may put a file where a **folder** of that name stands.
 */
export function nameTakenMessage(name: string): string {
  return translate("A file called \u201c{name}\u201d is already here.", { name });
}

/**
 * Write new bytes into a node that is already there.
 *
 * The one place the three properties that describe a file's content are
 * written, because the two writers that replace bytes -- the editor saving over
 * a file, and a drop landing on a name the folder already holds -- owe the node
 * the same thing. `FileNode/set` returns no `blobId` on create and takes one on
 * update, so a replacement is an update and never a destroy-and-create: the id,
 * the sharing and the place in the tree stay, and only the content changes.
 *
 * `size` goes with the blob rather than being left to the server. It is the
 * length of the bytes just uploaded, which this side knows exactly, and sending
 * it is what the editor does; a listing that disagreed with the blob would show
 * a size for content the server no longer holds.
 */
export async function writeContent(
  accountId: Id,
  id: Id,
  blobId: Id,
  type: string,
  size: number,
): Promise<void> {
  const res = await client.call<SetResponse<FileNode>>(FILENODE_SET, {
    accountId,
    update: { [id]: { blobId, type, size } },
  });
  const err = res.notUpdated?.[id];
  if (err) throw new Error(setErrorMessage(err));
}

/**
 * Upload one file into an account and write the node that names it.
 *
 * The account is a parameter because a node has to be created in the account
 * that holds the blob, and that is not always the one being browsed: saving a
 * message's attachments to Files can mean the reader's own files or a group's.
 *
 * `onExists` is the caller's decision, and it is said out loud because the two
 * callers want opposite things from one server answer. The file manager
 * **replaces**: a name the folder already holds is a file to write over --
 * dropping the same tree twice is one tree, and the reader asked for those
 * bytes to be there. Saving an attachment **refuses**: a file somebody already
 * keeps under that name is not this reader's to overwrite.
 *
 * The refusal is what says which node carries the name, in `existingId`, and
 * replacing writes into that node -- its `blobId`, `type` and `size`, the same
 * three `saveText` writes -- rather than destroying it and creating another:
 * the id, the sharing and the place in the tree stay, and only the bytes
 * change. The one node that may not be written into is a **folder** of that
 * name, so what the refusal named is read first and anything but a file is
 * refused with the name it holds. The blob that was replaced is left
 * unreferenced for the server's GC, JMAP having no way to delete one.
 */
export async function putFile(
  accountId: Id,
  parentId: Id | null,
  file: File,
  opts: {
    onExists: "replace" | "refuse";
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  },
): Promise<Id> {
  const { onExists, onProgress, signal } = opts;
  const type = file.type || "application/octet-stream";
  const up = await client.upload(accountId, file, {
    type,
    signal,
    onProgress:
      onProgress && ((loaded, total) => onProgress(Math.round((loaded / total) * 100))),
  });
  const res = await client.call<SetResponse<FileNode>>(FILENODE_SET, {
    accountId,
    create: { f: fileCreate(parentId, file.name, up.blobId, type) },
  });
  const err = res.notCreated?.f;
  if (!err) return res.created!.f!.id;
  if (!isAlreadyExists(err)) throw new Error(setErrorMessage(err));
  if (onExists === "refuse")
    throw new NameTakenError(err.existingId, nameTakenMessage(file.name));
  /*
   * The node the server named, read before anything is written into it.
   *
   * `existingId` is absent only for a collision with a create of the same
   * request (`tests/src/jmap/files/node.rs`), which one file in one request
   * cannot be -- and a refusal that named no node is not one to write into
   * either way, so it stands as it is. The blob is paid for before the read:
   * the create is what names the sibling, and a name a **folder** holds is the
   * one case that pays for bytes it cannot use.
   */
  const id = err.existingId;
  if (!id) throw new NameTakenError(undefined, nameTakenMessage(file.name));
  const node = await client.call<GetResponse<FileNode>>(FILENODE_GET, {
    accountId,
    ids: [id],
    properties: ["nodeType"],
  });
  if (node.list[0]?.nodeType !== "file")
    throw new NameTakenError(id, nameTakenMessage(file.name));
  await writeContent(accountId, id, up.blobId, type, file.size);
  return id;
}

/**
 * A directory in a named account's tree, made outright.
 *
 * The account is a parameter for the same reason `putFile`'s is: a node is
 * created in the account that owns it, and a drop lands in whoever's files the
 * reader has open. It is deliberately *not* the store's `mkdir`, which is the
 * view's own action -- that one reloads the folder it was aimed at and
 * refreshes the tree, and a drop that made thirty folders would do both thirty
 * times.
 */
export async function createDirectory(
  accountId: Id,
  parentId: Id | null,
  name: string,
): Promise<Id> {
  const res = await client.call<SetResponse<FileNode>>(FILENODE_SET, {
    accountId,
    create: { d: directoryCreate(parentId, name) },
  });
  const err = res.notCreated?.d;
  // The type goes on the error, not only in its message: a create that lost a
  // race is a folder somebody else made, and its caller has to be able to tell
  // that from a create that failed.
  if (err)
    throw isAlreadyExists(err)
      ? new NameTakenError(err.existingId, setErrorMessage(err))
      : new Error(setErrorMessage(err));
  return res.created!.d!.id;
}

/**
 * A node as far as the folder walk is concerned: what to call it, whether it is
 * a folder, and which node to write into when it is.
 */
export type SiblingNode = Pick<FileNode, "id" | "name" | "nodeType">;

/** The level a node sits at, as a map key: a parent id, or the top level. */
export const levelKey = (parentId: Id | null): string => parentId ?? "root";

/**
 * How many nodes one read of a level or of the account will ask for, in pages.
 *
 * It is the ceiling every read in this module works to: `readChildren`,
 * `readLevels` and `loadTree` each page up to it in steps of what the session
 * resolves (`pageSize`) and stop there. As a ceiling it is not a promise: a read
 * that comes back holding exactly this many may have been cut short. What that
 * costs a walk is a folder it cannot see, and a folder is recovered by the create
 * the server refuses -- so the ceiling never turns into a wrong answer, only into
 * a request that was not needed (see `uploadPlan`).
 */
export const LEVEL_LIMIT = 1000;

/**
 * The page this session may actually ask for.
 *
 * A listing asks for ids and then asks for those objects in the same request,
 * and a page the server cannot resolve is refused whole rather than cut short
 * (`maxObjectsInGet`, 500 by default). So the module's own ceiling is narrowed
 * to the server's, and the readers that page compare their pages against this
 * rather than against `LEVEL_LIMIT` -- a pager measuring short pages against a
 * size it never sent would stop after the first one.
 */
export const pageSize = (): number => Math.min(LEVEL_LIMIT, client.maxObjectsInGet);

/**
 * Which nodes a level read looks at.
 *
 * A named union rather than a nullable id, because the two scopes are not a
 * degree of each other: one is a folder, the other is the whole account, and
 * `null` already means "the top level" in this module. Spelling it out keeps a
 * caller from passing the wrong nothing.
 */
type LevelScope = { kind: "account" } | { kind: "level"; parentId: Id | null };

/**
 * The names at each level a read saw, keyed by the level they sit at.
 *
 * **The one place** a tree of nodes is turned into folders-to-write-into,
 * shared by the whole-account scan a drop starts with and by the single-level
 * read the folder walk makes, so the two cannot disagree about what is there.
 *
 * A level read buckets by the parent that was **asked for**, not by the
 * `parentId` the nodes came back wearing. The level is known by construction
 * there, and reading it off the response would make every caller depend on a
 * property the caller never needed -- a level read of one folder does not care
 * where its children say they live, and a server (or a test standing in for
 * one) that omits the field would silently bucket the names at the wrong level
 * and hand back an empty map. The account scan buckets by `parentId` because
 * there the response is the only thing that knows.
 */
export async function readLevels(
  accountId: Id,
  scope: LevelScope,
): Promise<Map<string, Map<string, SiblingNode>>> {
  /*
   * Up to the module's own ceiling, in pages of what the server will resolve:
   * `LEVEL_LIMIT` is how much of a level this walk looks at, not the size of one
   * request, so a level past the server's `/get` ceiling is read in steps rather
   * than truncated at the first one. A short page ends it.
   */
  const list: FileNode[] = [];
  const step = pageSize();
  const parentId = scope.kind === "level" ? scope.parentId : null;
  for (let position = 0; list.length < LEVEL_LIMIT; position += step) {
    const page = await listChildrenWithState(
      accountId,
      parentId,
      ["id", "name", "nodeType", "parentId"],
      {
        position,
        limit: Math.min(step, LEVEL_LIMIT - list.length),
        scope: scope.kind === "account" ? "account" : "level",
      },
    );
    if (!page.list.length) break;
    list.push(...page.list);
    if (page.list.length < step) break;
  }
  const levels = new Map<string, Map<string, SiblingNode>>();
  const key = scope.kind === "level" ? levelKey(scope.parentId) : null;
  for (const n of list) {
    const where = key ?? levelKey(n.parentId ?? null);
    const names = levels.get(where) ?? new Map<string, SiblingNode>();
    names.set(String(n.name), { id: n.id, name: n.name, nodeType: n.nodeType });
    levels.set(where, names);
  }
  return levels;
}

/**
 * One level's names out of a read, and the only place that lookup is written.
 *
 * A pure function over what `readLevels` answered, rather than one that fetches
 * as well. It is the smaller half on purpose: a caller that reads a level has
 * the request in front of it, which matters here because the number of requests
 * a drop makes is a thing this module's design argues about. A helper that both
 * fetched and picked out the names would hide how many requests a call site was
 * making, which is the one detail a reader of these call sites needs.
 *
 * A level larger than one read of it answers with a **page**, so a folder that
 * is in the level but past the page is one these names do not hold. That is the
 * folder walk's own case, and it recovers from it the way it recovers from any
 * folder it could not see: the create is refused, the refusal names what is
 * there, and the walk takes it (see `uploadPlan`).
 */
export function levelNames(
  levels: Map<string, Map<string, SiblingNode>> | undefined,
  parentId: Id | null,
): Map<string, SiblingNode> {
  return levels?.get(levelKey(parentId)) ?? new Map();
}

/**
 * One run, and the switch that stops it.
 *
 * A run is what the reader asked for in one gesture -- the files of a picker,
 * the tree of a drop, or the merge of two folders -- and it is the unit Cancel
 * acts on: the work in flight is aborted, and the loop that owns it stops
 * asking for the rest. Its rows are the ones drawn in the tray while it lasts,
 * and the run itself lives only as long as they do.
 *
 * Its `tally` is the count those rows carry. It lives on the run because the
 * count is the gesture's and not the step's: the reader watching a folder go up
 * is watching one job of two hundred files, and a row that counted only itself
 * would be a percentage with no sense of how much is left.
 */
export interface TrayRun {
  id: string;
  controller: AbortController;
  tally: { done: number; total: number };
}

/**
 * The runs in flight, by id.
 *
 * Module state rather than store state because an `AbortController` is not a
 * value to render: the tray draws rows, and the switch behind them is looked up
 * by the run a row names. Entries come and go with their run, so a row of a run
 * that is over cannot be cancelled by a stale id.
 */
export const trayRuns = new Map<string, AbortController>();

export function startRun(total: number): TrayRun {
  const run: TrayRun = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    controller: new AbortController(),
    tally: { done: 0, total },
  };
  trayRuns.set(run.id, run.controller);
  return run;
}

export function endRun(run: TrayRun): void {
  trayRuns.delete(run.id);
}

/**
 * One file: its tray row, the upload, the node and the run's count.
 *
 * Shared by the picker and by a drop, because both owe the reader the same
 * three things -- a row that reports progress, a name that is written into
 * rather than refused, and the count of the files still to go beside it.
 *
 * The run is the caller's, and carries its three answers: the row names it
 * (what Cancel is aimed at), its signal is what the upload itself watches, and
 * its tally is what the row shows. A run the reader stopped is not a failure to
 * report -- its row leaves the way a finished one does -- so the abort is
 * checked before the error is kept.
 */
export async function uploadOne(
  set: FilesSet,
  accountId: Id,
  parentId: Id | null,
  file: File,
  run: TrayRun,
): Promise<void> {
  const row = runRow(file.name, null, run.id, run.tally);
  set((s) => ({ runs: [...s.runs, row] }));
  try {
    await putFile(accountId, parentId, file, {
      onExists: "replace",
      onProgress: (percent) =>
        set((s) => ({
          runs: s.runs.map((u) => (u.id === row.id ? { ...u, progress: percent } : u)),
        })),
      signal: run.controller.signal,
    });
    run.tally.done += 1;
    /*
     * The row of the file that went up leaves, and the count of the run moves
     * on every row still standing -- the one in flight is about to be replaced
     * by the next, and the failures that stay in the tray are about this same
     * run, so they read the count it has reached rather than the one it had
     * when they were made.
     */
    set((s) => ({
      runs: s.runs
        .filter((u) => u.id !== row.id)
        .map((u) => (u.runId === run.id ? { ...u, done: run.tally.done } : u)),
    }));
  } catch (err) {
    // A run the reader cancelled says nothing: the row goes, exactly as the
    // row of a file that went up does. Anything else stays, because its
    // message *is* the error and the reader takes it away.
    if (run.controller.signal.aborted) {
      set((s) => ({ runs: s.runs.filter((u) => u.id !== row.id) }));
      return;
    }
    set((s) => ({
      runs: s.runs.map((u) => (u.id === row.id ? { ...u, error: errorMessage(err) } : u)),
    }));
  }
}

/**
 * One level of an account, read whole.
 *
 * `readLevels` above answers what a walk over names needs and stops at one
 * page; this answers the nodes themselves and pages until the level is in hand,
 * for every caller that needs all of it: a merge, which has to know *every* name
 * of a level before it may move anything into it and would otherwise plan half
 * of one; the listing, which would otherwise draw a page and leave the tail of
 * the alphabet unreachable; and the save-to-Files picker, which offers the
 * folders of a level it read for the account it is filing into rather than from
 * the store.
 *
 * Three ways out besides a stopped run, and the third is the point: a page
 * shorter than the ceiling is the last one, a page count that has reached
 * `total` is the last one, and a server that answers the same page twice is a
 * **failure** rather than a loop. The last is not hypothetical caution -- a
 * server ignoring `position` would spin here for ever, and a merge that hangs
 * with a tray row and a Cancel button that does nothing is worse than one that
 * stops and says so.
 *
 * The signal is checked around every page, because the scan is the merge's
 * first step and a reader who presses Cancel while it runs means it: the read
 * in flight rejects on the run's signal and the loop stops before asking again.
 */
export async function readChildren(
  accountId: Id,
  parentId: Id | null,
  signal?: AbortSignal,
): Promise<FileNode[]> {
  const out: FileNode[] = [];
  const limit = pageSize();
  let seenFirst: Id | undefined;
  for (let position = 0; ; ) {
    signal?.throwIfAborted();
    const { list, total } = await listChildrenWithState(
      accountId,
      parentId,
      fileNodeProps(),
      { position, limit },
    );
    signal?.throwIfAborted();
    if (!list.length) break;
    if (list[0]!.id === seenFirst)
      throw new Error(
        translate(
          "The folder could not be read: the server answered the same page twice.",
        ),
      );
    seenFirst = list[0]!.id;
    out.push(...list);
    position += list.length;
    if (list.length < limit) break;
    if (total !== undefined && position >= total) break;
  }
  return out;
}

/**
 * A record in the tray, the one place a failure is reported.
 *
 * The id is what a progress update and a dismissal are aimed at, so two steps
 * of the same name in one run must not share one -- `Date.now()` alone hands
 * both the same value, and the second one's progress would then move the first
 * one's row.
 *
 * The count is the run's, taken as it stood when the row was made: a row lives
 * for one step, and the number beside it says which step of how many this one
 * is -- a folder of two hundred items reads as a job with a size rather than as
 * two hundred unrelated files, one after another. `unit` is what those steps
 * are called, because a run of uploads counts files and a merge counts the
 * items it moves, replaces and destroys.
 */
export const runRow = (
  name: string,
  error: string | null,
  runId: string,
  tally: { done: number; total: number },
  unit: "file" | "item" = "file",
) => ({
  id: `${Date.now()}-${name}-${Math.random().toString(36).slice(2, 7)}`,
  runId,
  name,
  done: tally.done,
  total: tally.total,
  progress: null as number | null,
  unit,
  error,
});
