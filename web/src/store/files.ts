import { create, type StoreApi } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, QueryResponse, SetResponse } from "@/jmap/types";
import { isAppFolder, listChildrenWithState } from "@/lib/appFolder";
import { type DropPlan, folderPathKey, foldersNeeded } from "@/lib/dropUpload";
import {
  directoryCreate,
  fileCreate,
  fileNodeProps,
  isAlreadyExists,
  NameTakenError,
} from "@/lib/filenode";
import {
  type MergePlan,
  type MergeTree,
  mergeBlockedMessage,
  planMerge,
} from "@/lib/folderMerge";
import { t as translate } from "@/lib/i18n";
import { placeOwnerFrom, rememberPlace } from "@/lib/lastPlace";
import { useSession } from "./session";

interface SharedAccount {
  id: Id;
  name: string;
}

interface FilesState {
  /**
   * The account being browsed, which is not always the reader's own.
   *
   * Files is the one module that opens somebody else's account in place: a
   * folder shared with you is reached from "Shared with me" in the tree, not by
   * switching the whole app over. So this moves and `ownAccountId` does not,
   * and anything belonging to the reader -- their settings, their signatures --
   * goes through `ownAccountFor` rather than either of them.
   */
  accountId: Id | null;
  /** The reader's own file account, wherever they happen to be looking. */
  ownAccountId: Id | null;
  /** Accounts someone else has shared, from the session. */
  sharedAccounts: SharedAccount[];
  available: boolean;
  /** Whether `init` has probed the session's accounts for shared Files. */
  initialized: boolean;
  nodes: Record<Id, FileNode>;
  children: Record<string, Id[]>; // parentId ("root" for null) → ids
  /**
   * The listing on screen, if any: the folder whose children the Files view is
   * drawing, `parentId: null` for the top level and `null` for no listing at
   * all.
   *
   * Registered by the view, because nobody else knows, and read by
   * `applyChanges` so a change arriving from elsewhere re-reads what is being
   * looked at instead of every folder the reader has ever opened.
   */
  listingShown: { parentId: Id | null } | null;
  loading: boolean;
  error: string | null;
  /**
   * The runs being reported in the tray, one row each.
   *
   * A row is one thing the reader asked for and can stop: an upload in flight,
   * or the merge of two folders. The fields are what any of them owes the tray
   * -- a name, how far it has come, and the switch that ends it.
   */
  runs: Array<{
    id: string;
    /**
     * The run that started this row -- one drop, or one picker action.
     *
     * Carried on the row because Cancel is aimed at a row and stops a run: the
     * row on screen is not always the one the run began with (a folder of two
     * hundred items draws a row per file, one after another), and a reader
     * pressing Cancel between two of them must still stop the same thing.
     */
    runId: string;
    name: string;
    /**
     * How far the step in flight has come, where that means anything: the
     * percentage of the file being uploaded, or of the bytes being copied into
     * a file a merge writes over. A step that moves no bytes -- a move, or the
     * destruction of an emptied folder -- has no percentage, and the tray draws
     * none for it rather than a `0%` that is not a measurement.
     */
    progress: number | null;
    /**
     * What those steps are called, because two kinds of run count different
     * things: an upload counts files, and a merge counts the items it moves,
     * replaces and destroys.
     */
    unit: "file" | "item";
    error: string | null;
    /**
     * Steps of this row's run that are already through, out of the steps it set
     * out to take. The count of the moment the row was made -- a run adds a row
     * per step, and each one carries the count as it stood when its own work
     * started, which is what makes the number move while the run lasts.
     */
    done: number;
    total: number;
  }>;
  dirIds: Id[];
  treeLoaded: boolean;
  /*
   * The node being dragged, if any.
   *
   * Kept here rather than in whichever pane started the drag, because a drag
   * crosses between them -- a row dragged onto the sidebar tree, a folder in
   * the tree dragged onto a row -- and every possible target has to know what
   * is in flight to say whether it will take it. Two panes each holding their
   * own copy leave the one that did not start the drag unable to light up or
   * accept the drop.
   *
   * It cannot be read from the drag itself: `dataTransfer.getData` is blocked
   * during dragover, which is exactly when the answer is needed.
   */
  draggingIds: Id[];

  init(): Promise<void>;
  /** Browse an account: the reader's own, or one shared with them. */
  openAccount(accountId: Id | null): void;
  loadChildren(parentId: Id | null): Promise<void>;
  mkdir(parentId: Id | null, name: string): Promise<Id>;
  /*
   * Upload files into a folder of the account being browsed.
   *
   * A file whose name the folder already holds is **written over** rather than
   * refused, and a name that is a folder is left alone: dropping the same tree
   * twice is one tree, which keeps a drop repeatable instead of turning the
   * second one into a page of errors. One tray row per file carries the run's
   * count -- files through, out of the files the gesture named -- beside the
   * percentage of the file in flight.
   */
  upload(parentId: Id | null, files: File[]): Promise<void>;
  /**
   * Take a failed upload out of the tray.
   *
   * A row that went up removes itself; one that did not stays, because its
   * message *is* the error and the reader has to be able to read it. So it is
   * the reader who takes it away, and only such a row offers to.
   */
  dismissRun(id: string): void;
  /**
   * Stop the run a tray row belongs to.
   *
   * A run is one thing the reader asked for: a file, a folder of two hundred,
   * or the merge of two folders. Cancelling it aborts the work in flight and
   * drops everything of the same run that had not started, so a folder does not
   * owe the reader a press per file.
   *
   * **From the run's first file onward.** A drop creates and reads the folders
   * of its tree before it uploads anything, and until the first file is in
   * flight the tray holds no row of this run -- so that phase has nothing to
   * press, and nothing in it checks for an abort. A merge is cancellable from
   * its first step, which is a scan and then the plan being carried out.
   */
  cancelRun(id: string): void;
  /**
   * Merge two folders into one, keeping the node named by `keepId`.
   *
   * The merge is decided before it is carried out. Both trees are read, the plan
   * is built, and a collision anywhere in either tree stops the whole thing with
   * nothing written -- which is why the two folders are named by id and not by
   * "keep this name": the plan needs the trees, and the caller has the nodes.
   *
   * What the plan does is `planMerge`'s (see `web/src/lib/folderMerge.ts`):
   * everything the folder given up holds moves into the kept one, a name they
   * both hold as a file has the other's bytes written into the node that already
   * has the name, two folders of one name merge, and a name that is a folder on
   * one side and a file on the other stops the merge. The folder given up is
   * destroyed last, once it is empty.
   *
   * The run is registered before the scan, so the tray holds a row with a Cancel
   * on it for the whole of it -- which is the difference between this and a drop,
   * whose folder phase has no row because until the first file there is nothing
   * on screen to press.
   *
   * It is cancellable like an upload, and what it has done when the reader stops
   * it stays done: no step is undone. The folder being merged in is never
   * destroyed unless every step of the plan ran, so a cancelled or a failed
   * merge leaves both folders where they are, with whatever had moved already
   * inside the kept one, and can be asked for again.
   *
   * A collision is reported in the tray rather than by throwing: nothing was
   * written and the tray is where this view reports. The throw is kept for the
   * one case that is not a merge at all -- two folders were not handed over.
   */
  mergeFolders(keepId: Id, mergeId: Id): Promise<void>;
  /** Say which listing is on screen, so a push refreshes it and not the rest. */
  setListingShown(shown: { parentId: Id | null } | null): void;
  /**
   * Save files into a folder of an account that is not the one being browsed.
   *
   * A message's attachments belong to the mailbox's account, and saving them
   * to Files can mean the reader's own files or a group's -- neither of which
   * is where Files happens to be looking. The nodes are created where the
   * blobs go and `accountId` is left alone, so the view does not move under
   * the reader. `parentId` is the folder chosen inside that account, the top
   * level when it is null.
   *
   * Returns how many landed, the names that could not be saved, and the names
   * the folder already held -- kept apart because the caller says something
   * different about each: one is a failure, the other is a file that is still
   * there and was not touched.
   */
  uploadTo(
    accountId: Id,
    files: File[],
    parentId?: Id | null,
  ): Promise<{ saved: number; failed: string[]; existing: string[] }>;
  rename(id: Id, name: string): Promise<void>;
  /**
   * Write text back over a file. `seenBlobId` is what the editor started from:
   * if the node has moved on since, somebody else saved and this throws rather
   * than quietly winning.
   */
  saveText(id: Id, text: string, seenBlobId: Id | null): Promise<Id>;
  move(id: Id, parentId: Id | null): Promise<void>;
  /** Move several at once, in one round trip -- see the note on the implementation. */
  moveMany(ids: Id[], parentId: Id | null): Promise<void>;
  destroy(ids: Id[]): Promise<void>;
  refresh(ids: Id[]): Promise<void>;
  setDragging(ids: Id[]): void;
  /** Every directory in the account, for the tree in the sidebar. */
  loadTree(): Promise<void>;
  /**
   * Upload a planned drop, spreading it over what is already in the folder.
   *
   * A folder the drop names is used when it is already there and made when it
   * is not, so dropping the same tree twice adds what is new to the same
   * folders rather than building a second copy beside them.
   */
  uploadPlan(parentId: Id | null, plan: DropPlan): Promise<void>;
  pathTo(id: Id | null): FileNode[];
  applyChanges(types: Set<string>): void;
}

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
async function writeContent(
  accountId: Id,
  id: Id,
  blobId: Id,
  type: string,
  size: number,
): Promise<void> {
  const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
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
async function putFile(
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
  const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
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
  const node = await client.call<GetResponse<FileNode>>("FileNode/get", {
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
async function createDirectory(
  accountId: Id,
  parentId: Id | null,
  name: string,
): Promise<Id> {
  const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
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
type SiblingNode = Pick<FileNode, "id" | "name" | "nodeType">;

/** The level a node sits at, as a map key: a parent id, or the top level. */
const levelKey = (parentId: Id | null): string => parentId ?? "root";

/**
 * How many nodes one read of a level or of the account will ask for.
 *
 * The ceiling the module uses everywhere else (`loadChildren`, `loadTree`), and
 * it is a *ceiling*, not a promise: a read that comes back holding exactly this
 * many may have been cut short. What that costs a walk is a folder it cannot
 * see, and a folder is recovered by the create the server refuses -- so the
 * ceiling never turns into a wrong answer, only into a request that was not
 * needed (see `uploadPlan`).
 */
export const LEVEL_LIMIT = 1000;

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
async function readLevels(
  accountId: Id,
  scope: LevelScope,
): Promise<Map<string, Map<string, SiblingNode>>> {
  const { list } = await listChildrenWithState(
    accountId,
    scope.kind === "level" ? scope.parentId : null,
    ["id", "name", "nodeType", "parentId"],
    { limit: LEVEL_LIMIT, scope: scope.kind === "account" ? "account" : "level" },
  );
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
function levelNames(
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
interface TrayRun {
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
const trayRuns = new Map<string, AbortController>();

function startRun(total: number): TrayRun {
  const run: TrayRun = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    controller: new AbortController(),
    tally: { done: 0, total },
  };
  trayRuns.set(run.id, run.controller);
  return run;
}

function endRun(run: TrayRun): void {
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
async function uploadOne(
  set: StoreApi<FilesState>["setState"],
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
      runs: s.runs.map((u) =>
        u.id === row.id ? { ...u, error: (err as Error).message } : u,
      ),
    }));
  }
}

/**
 * One level of an account, read whole.
 *
 * `readLevels` above answers what a walk over names needs and stops at one
 * page; this answers the nodes themselves and pages until the level is in hand,
 * which is what a merge decides from: it has to know *every* name of a level
 * before it may move anything into it, and a page of a larger level would
 * silently plan half a merge.
 *
 * Three ways out, and the third is the point: a page shorter than the ceiling
 * is the last one, a page count that has reached `total` is the last one, and a
 * server that answers the same page twice is a **failure** rather than a loop.
 * The last is not hypothetical caution -- a server ignoring `position` would
 * spin here for ever, and a merge that hangs with a tray row and a Cancel
 * button that does nothing is worse than one that stops and says so.
 */
async function readChildren(accountId: Id, parentId: Id | null): Promise<FileNode[]> {
  const out: FileNode[] = [];
  let seenFirst: Id | undefined;
  for (let position = 0; ; ) {
    const { list, total } = await listChildrenWithState(
      accountId,
      parentId,
      fileNodeProps(),
      { position, limit: LEVEL_LIMIT },
    );
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
    if (list.length < LEVEL_LIMIT) break;
    if (total !== undefined && position >= total) break;
  }
  return out;
}

/**
 * A folder as `planMerge` reads it: the node itself, and levels read once and
 * remembered.
 *
 * The memo is what makes the plan cheap over a tree the walk visits once per
 * level: the same folder is never read twice, and a folder the plan does not
 * descend into is never read at all -- which is the whole reason the tree is a
 * function rather than a snapshot.
 */
function mergeTree(accountId: Id, root: FileNode): MergeTree {
  const levels = new Map<Id, FileNode[]>();
  return {
    root,
    async childrenOf(parentId) {
      const held = levels.get(parentId);
      if (held) return held;
      const list = await readChildren(accountId, parentId);
      levels.set(parentId, list);
      return list;
    },
  };
}

/**
 * Move nodes into a folder, in one call.
 *
 * Not only for the round trip: a loop would move half of them and then throw,
 * leaving a selection split across two folders with nothing saying which half
 * went. One call is one answer, and `notUpdated` names whichever ones the
 * server refused. The merge's steps go through here a batch at a time, and
 * `moveMany` is the store's own action over the same call.
 */
async function moveNodes(accountId: Id, ids: Id[], parentId: Id | null): Promise<void> {
  const update = Object.fromEntries(ids.map((id) => [id, { parentId }]));
  const res = await client.call<SetResponse>("FileNode/set", { accountId, update });
  const failed = Object.values(res.notUpdated ?? {})[0];
  if (failed) throw new Error(setErrorMessage(failed));
}

/**
 * Destroy nodes, in one call.
 *
 * `cascade` is the server's `onDestroyRemoveChildren`, and the two callers want
 * different things from it. Deleting a folder from the file manager takes its
 * contents with it, because that is what the reader asked for. A merge destroys
 * a folder the **plan emptied**, so it does not ask: something that landed in
 * there between the scan and this call is not the merge's to destroy, and a
 * server that refuses a folder it still holds something in gives the reader the
 * honest answer instead.
 */
async function destroyNodes(accountId: Id, ids: Id[], cascade: boolean): Promise<void> {
  const res = await client.call<SetResponse>("FileNode/set", {
    accountId,
    destroy: ids,
    ...(cascade ? { onDestroyRemoveChildren: true } : {}),
  });
  const failed = Object.values(res.notDestroyed ?? {})[0];
  if (failed) throw new Error(setErrorMessage(failed));
}

/**
 * Write one file's bytes over another node.
 *
 * The copy is what carries a merge's content across: the blob is read from the
 * account and uploaded again, and `writeContent` writes the three properties
 * that describe it into the node that already holds the name. The reader's
 * bytes are the same afterwards either way, and the node the kept folder had is
 * the one that holds them -- same id, same sharing, same place in the tree
 * (ADR 0014). Re-pointing the node at the other one's blob would save both the
 * download and the upload, and nothing here has read a 0.16 do it: the server
 * charges the account for the second blob and leaves the first to its GC, which
 * is the price of not resting a durable write on an unverified answer.
 */
async function copyOver(
  accountId: Id,
  dstId: Id,
  blobId: Id,
  type: string,
  opts: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const blob = await client.fetchBlob(accountId, blobId, type, opts.signal);
  const up = await client.upload(accountId, blob, {
    type,
    signal: opts.signal,
    onProgress:
      opts.onProgress &&
      ((loaded, total) => opts.onProgress!(Math.round((loaded / total) * 100))),
  });
  await writeContent(accountId, dstId, up.blobId, type, blob.size);
}

/**
 * A merge, carried out: the steps, the count, and the switch that stops them.
 *
 * The plan is already decided and has already refused anything that collides,
 * so this does exactly what it says. The row it reports on belongs to the caller,
 * because the caller made it before the scan -- the run exists from the moment
 * the reader asked, not from the first move.
 *
 * An abort is not an error: the loop breaks, or the step in flight rejects on the
 * signal it was given, the run's owner sees the signal and takes the row away,
 * and **what has been done stays done**. No step is undone,
 * which is why the plan puts the destruction of the folder given up last: a
 * merge that stopped halfway has moved part of a folder into another and left
 * both where they are, with nothing destroyed that still had something in it.
 */
async function runMergeSteps(
  set: StoreApi<FilesState>["setState"],
  accountId: Id,
  plan: MergePlan,
  row: FilesState["runs"][number],
  run: TrayRun,
): Promise<void> {
  let done = 0;
  const report = (progress: number | null) =>
    set((s) => ({
      runs: s.runs.map((u) =>
        u.id === row.id ? { ...u, done, total: run.tally.total, progress } : u,
      ),
    }));
  for (let i = 0; i < plan.steps.length; ) {
    if (run.controller.signal.aborted) return;
    const step = plan.steps[i]!;
    if (step.kind === "move") {
      /*
       * Consecutive moves into one folder are one call, chunked by what the
       * server takes in one set: a folder of two hundred items joining another
       * is one `FileNode/set` and not two hundred, and the tray counts the items
       * because they are what the reader is watching move.
       */
      const ids: Id[] = [];
      while (i < plan.steps.length) {
        const next = plan.steps[i]!;
        if (next.kind !== "move" || next.into !== step.into) break;
        ids.push(next.srcId);
        i += 1;
      }
      for (let at = 0; at < ids.length; at += client.maxObjectsInSet)
        await moveNodes(accountId, ids.slice(at, at + client.maxObjectsInSet), step.into);
      done += ids.length;
      report(null);
      continue;
    }
    if (step.kind === "replace") {
      await copyOver(accountId, step.dstId, step.blobId, step.type, {
        signal: run.controller.signal,
        onProgress: (percent) => report(percent),
      });
      /*
       * The file the bytes came out of goes, and it goes **after** the copy
       * rather than before: a run stopped in between has a copy that landed and
       * a file that is still there, which is two of one name and loses nothing,
       * where the other order would destroy a file whose content had not crossed
       * yet. It is also what leaves the folder given up empty enough for its own
       * destruction to be accepted.
       */
      await destroyNodes(accountId, [step.srcId], false);
    } else {
      await destroyNodes(accountId, [step.id], false);
    }
    i += 1;
    done += 1;
    report(null);
  }
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
const runRow = (
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

export const useFiles = create<FilesState>((set, get) => ({
  accountId: null,
  ownAccountId: null,
  sharedAccounts: [],
  available: false,
  initialized: false,
  nodes: {},
  children: {},
  listingShown: null,
  loading: false,
  error: null,
  runs: [],
  dirIds: [],
  treeLoaded: false,
  draggingIds: [],

  async init() {
    const session = useSession.getState();
    const ownAccountId = session.ownAccountFor(CAP.filenode);
    const available = Boolean(ownAccountId && client.hasCapability(CAP.filenode));
    /*
     * Which accounts hold shared files cannot be worked out from capabilities:
     * Stalwart advertises the whole set on a shared account -- mail, calendars,
     * contacts and the rest -- identical to a personal one, whatever was
     * actually shared (checked on 0.16.19, 2026-08-27). So each one is asked
     * for its files, and only the ones that answer with any are listed.
     *
     * Listing them all and letting the folders speak for themselves puts an
     * account holding nothing at all under "Shared with me" -- an invitation to
     * open an empty pane, offered by an account whose calendar or contacts were
     * the thing actually shared. An account that shares no files does not
     * belong in a list of shared files.
     */
    const s = session.session;
    const candidates = Object.entries(s?.accounts ?? {}).filter(
      ([, a]) => a.isPersonal === false,
    );
    const sharedAccounts: SharedAccount[] = [];
    for (const [id, a] of candidates) {
      try {
        const res = await client.call<QueryResponse>("FileNode/query", {
          accountId: id,
          limit: 1,
        });
        if (res.ids.length) sharedAccounts.push({ id, name: a.name });
      } catch {}
    }
    // Stay where the reader is if they are reading a share that still exists.
    const browsing = get().accountId;
    const keep =
      browsing &&
      (browsing === ownAccountId || sharedAccounts.some((a) => a.id === browsing));
    if (!keep) set(emptyForAccount(ownAccountId));
    set({ available, ownAccountId, sharedAccounts, initialized: true });
  },

  openAccount(accountId) {
    if (accountId === get().accountId) return;
    set(emptyForAccount(accountId));
  },

  /*
   * The whole directory tree in one query.
   *
   * `filter: { nodeType: "directory" }` returns every folder in the account,
   * confirmed against 0.16.19 on 2026-08-27, so the sidebar tree is complete
   * from the first paint: expanding costs nothing, and a drag knows every
   * folder it could be dropped on without having opened it first.
   *
   * It is deliberately its own request rather than a call appended to another.
   * A filter Stalwart refuses fails with a request-level 400 that takes every
   * method call in the request with it -- `{ parentId: null }` does exactly
   * that -- so a tree query batched alongside the folder listing would blank
   * the whole view instead of just the sidebar.
   */
  async loadTree() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.chain([
        [
          "FileNode/query",
          {
            accountId,
            filter: { nodeType: "directory" },
            sort: [{ property: "name", isAscending: true }],
            limit: 1000,
          },
          "q",
        ],
        [
          "FileNode/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" },
            properties: fileNodeProps(),
          },
          "g",
        ],
      ]);
      const g = res.get("g")?.[0] as unknown as GetResponse<FileNode>;
      // Filtered again here rather than trusted: a server that ignores the
      // nodeType filter answers with files as well, and the tree would draw
      // them as folders you could open into nothing.
      const dirs = withoutAppFolder(g.list).filter((n) => n.nodeType === "directory");
      set((s) => {
        const nodes = { ...s.nodes };
        for (const n of dirs) nodes[n.id] = n;
        return { nodes, dirIds: dirs.map((n) => n.id), treeLoaded: true };
      });
    } catch (err) {
      // The listing still works without a tree, so this must not blank the view.
      set({ error: (err as Error).message, treeLoaded: true });
    }
  },

  async loadChildren(parentId) {
    const accountId = get().accountId;
    if (!accountId) return;
    set({ loading: true });
    try {
      const filter = parentId ? { parentId } : { isTopLevel: true };
      const res = await client.chain([
        [
          "FileNode/query",
          {
            accountId,
            filter,
            sort: [
              { property: "nodeType", isAscending: false },
              { property: "name", isAscending: true },
            ],
            limit: 1000,
          },
          "q",
        ],
        [
          "FileNode/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" },
            properties: fileNodeProps(),
          },
          "g",
        ],
      ]);
      const q = res.get("q")?.[0] as unknown as QueryResponse;
      const g = res.get("g")?.[0] as unknown as GetResponse<FileNode>;
      const listed = withoutAppFolder(g.list);
      const keep = new Set(listed.map((n) => n.id));
      set((s) => {
        const nodes = { ...s.nodes };
        for (const n of listed) nodes[n.id] = n;
        return {
          nodes,
          children: {
            ...s.children,
            [parentId ?? "root"]: q.ids.filter((id) => keep.has(id)),
          },
          loading: false,
          error: null,
        };
      });
    } catch (err) {
      // No fallback abandons the filters and fetches every node in the
      // account: 0.16 supports parentId/isTopLevel, and quietly loading the
      // whole tree instead would hide a real fault behind a performance cliff
      // nobody would notice.
      set({ loading: false, error: (err as Error).message });
    }
  },

  async mkdir(parentId, name) {
    const id = await createDirectory(get().accountId!, parentId, name);
    await get().loadChildren(parentId);
    void get().loadTree();
    return id;
  },

  /*
   * A file the folder already holds is written over, and its bytes are uploaded
   * to do it: that is the same upload the first copy cost, paid again because
   * the reader asked for these bytes to be here. A name a **folder** holds is
   * the one case that stops, and the server is what says so -- the create is
   * refused and the row carries the refusal. No level is listed first: the
   * refusal names the node, which is what a replacement needs, so a drop of two
   * hundred files costs two hundred uploads and one set each rather than a
   * listing on top of them.
   */
  async upload(parentId, files) {
    const accountId = get().accountId!;
    /* One run for the whole picker selection, so a file that is taking too
       long is a thing the reader can stop -- together with the files of the
       same gesture that had not started -- and so the count beside each row is
       about the whole selection rather than about one file. */
    const run = startRun(files.length);
    try {
      for (const f of files) {
        if (run.controller.signal.aborted) break;
        await uploadOne(set, accountId, parentId, f, run);
      }
    } finally {
      endRun(run);
    }
    await get().loadChildren(parentId);
  },

  /*
   * The way out of a row that failed.
   *
   * Nothing else takes one away: the tray is the only place a failed upload is
   * reported, and a row left in it would sit there for the rest of the session,
   * in every folder, with nothing to press.
   */
  dismissRun(id) {
    set((s) => ({ runs: s.runs.filter((u) => u.id !== id) }));
  },

  /*
   * The way out of a row that is still going.
   *
   * The row names its run, so a reader who presses Cancel on the file that is
   * on screen stops the run that file belongs to -- including the files of the
   * same drop that had not started, which is the only way a folder of two
   * hundred items can be stopped in one press. The abort travels two ways: the
   * upload in flight is aborted through the signal it was given, and the loop
   * that owns the run sees it before it starts the next file. A row whose run
   * is already over has nothing to abort and does nothing, which is why the
   * registry is emptied as each run ends.
   *
   * Only a row **in flight** may cancel: a row carrying an error is a failure
   * the reader has been told about and has still to read, and its run may well
   * have moved on to another file by now -- pressing Cancel there would stop
   * work the press had nothing to do with. The tray offers Cancel on the row in
   * flight alone, and this is the same rule one layer down, where it cannot be
   * forgotten by a second caller.
   */
  cancelRun(id) {
    const row = get().runs.find((u) => u.id === id);
    if (row && !row.error) trayRuns.get(row.runId)?.abort();
  },

  async mergeFolders(keepId, mergeId) {
    const accountId = get().accountId!;
    const keep = get().nodes[keepId];
    const merge = get().nodes[mergeId];
    if (keep?.nodeType !== "directory" || merge?.nodeType !== "directory")
      throw new Error(translate("Merging takes two folders."));

    /*
     * The row first, the scan second. The scan is several requests over two
     * trees and the reader has asked for something that has not begun to move;
     * a run with no row yet would be a merge with nothing to watch and nothing
     * to press, which for a large tree is a pause of its own.
     */
    const run = startRun(0);
    const row = runRow(merge.name, null, run.id, run.tally, "item");
    set((s) => ({ runs: [...s.runs, row] }));
    const fail = (message: string) =>
      set((s) => ({
        runs: s.runs.map((u) => (u.id === row.id ? { ...u, error: message } : u)),
      }));
    /*
     * The row of a run that is over goes, whether the run carried it out or the
     * reader stopped it: a merge that finished and a merge that was stopped say
     * the same thing to the tray, which is nothing.
     */
    const dropRow = () => set((s) => ({ runs: s.runs.filter((u) => u.id !== row.id) }));
    try {
      const plan = await planMerge(
        mergeTree(accountId, merge),
        mergeTree(accountId, keep),
      );
      if (plan.conflicts.length) {
        /*
         * Nothing was written -- planning first is exactly so that a collision
         * costs the reader nothing but the sentence about it -- and the row
         * carries it until it is dismissed, the way a failed upload's does.
         */
        fail(mergeBlockedMessage(plan.conflicts));
        return;
      }
      run.tally.total = plan.steps.length;
      // The row was made before the plan existed, so its size is written the
      // moment there is one: until then the tray would read "0 of 0 items"
      // beside a merge that is already scanning.
      set((s) => ({
        runs: s.runs.map((u) =>
          u.id === row.id ? { ...u, total: plan.steps.length } : u,
        ),
      }));
      await runMergeSteps(set, accountId, plan, row, run);
    } catch (err) {
      /*
       * A run the reader stopped says nothing, and its row goes with it -- the
       * way a cancelled upload's does. The abort arrives here as a rejection:
       * the blob read and the upload are both given the run's signal, so a call
       * in flight fails the moment the run is aborted, and the one that was
       * waiting on it is the scan or a step. Leaving the row behind would leave
       * a count nothing is advancing beside a Cancel that can no longer stop
       * anything -- the run is out of the registry by then -- and no Dismiss
       * either, which the tray draws on a row that failed and not on this one.
       */
      if (run.controller.signal.aborted) {
        dropRow();
        return;
      }
      fail((err as Error).message);
      return;
    } finally {
      endRun(run);
    }
    // Every step of the plan ran, the destruction of the folder given up among
    // them: the row has nothing left to report.
    dropRow();
    await get().loadChildren(keep.parentId ?? null);
    void get().loadTree();
  },

  async uploadTo(accountId, files, parentId = null) {
    const failed: string[] = [];
    const existing: string[] = [];
    let saved = 0;
    /*
     * One read of the folder, and whatever it answered is worth checking
     * against: a page of a large folder still names real siblings, so a name
     * found in it really is taken, and an attachment that must not overwrite
     * anything is worth not paying a blob for. A read that failed leaves an
     * empty map, which refuses nothing and lets the server say so -- the same
     * outcome as having no list at all, one blob later.
     */
    const read = await readLevels(accountId, { kind: "level", parentId }).catch(
      () => null,
    );
    const taken = levelNames(read ?? undefined, parentId);
    for (const f of files) {
      try {
        if (taken.has(f.name)) {
          existing.push(f.name);
          continue;
        }
        await putFile(accountId, parentId, f, { onExists: "refuse" });
        taken.set(f.name, { id: "", name: f.name, nodeType: "file" });
        saved += 1;
      } catch (err) {
        // The folder's own answer decides which list it goes in: a name that is
        // taken leaves a file that is still there, which is not a failure and
        // must not be reported as one.
        if (isAlreadyExists(err)) existing.push(f.name);
        else failed.push(f.name);
      }
    }
    return { saved, failed, existing };
  },

  /* Re-read named nodes in place. Sharing changes one property of one node and
     nothing about which folder it sits in, so reloading the level around it
     would be a bigger round trip to land in the same place. */
  setDragging(ids) {
    set({ draggingIds: ids });
  },

  async refresh(ids) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return;
    const res = await client.call<GetResponse<FileNode>>("FileNode/get", {
      accountId,
      ids,
      properties: fileNodeProps(),
    });
    set((s) => {
      const nodes = { ...s.nodes };
      for (const n of res.list) nodes[n.id] = n;
      return { nodes };
    });
  },

  /*
   * A drop, landed in the tree it names -- reusing what is already there.
   *
   * Every folder of the drop is resolved first: the one already under the
   * target is used as it is, and only a name that is not there is created. A
   * folder dropped twice therefore adds what is new to the same folders instead
   * of building a second copy beside them, which is what dropping onto a
   * folder one already has has to mean.
   *
   * The files are written over what the folder already holds of the same name,
   * folder and file alike, so dropping the same tree twice leaves one tree and
   * the latest bytes rather than a tray full of refusals. What that may not
   * overwrite is a folder: a file whose name a folder carries is refused (see
   * `putFile`).
   *
   * A folder that cannot be resolved is not a folder to guess at. Nothing below
   * it is created, and the files that were headed for it are left in the tray as
   * failures: filing them into the nearest folder that does exist is how a drop
   * comes to scatter files somewhere nobody chose.
   */
  async uploadPlan(parentId, plan) {
    const accountId = get().accountId!;
    /* One run for the whole dropped tree, so a folder of two hundred items is
       one thing the reader can stop: the file in flight, and every file of the
       drop that had not started. The count starts at the files the drop carried
       and is corrected below, once the folders have said which of them have
       anywhere to go. */
    const run = startRun(plan.files.length);
    try {
      /*
       * One read of the account answers every level the drop names -- as far as
       * it got.
       *
       * The walk resolves one folder at a time and would otherwise list a folder
       * per folder -- a request each -- for a tree the account can describe in a
       * single query. So the levels are read together here, and on an account the
       * read finished the walk makes no request at all except the creates it has
       * to make.
       *
       * A read that came back short is finished by **narrowing**, not by paging
       * the account until it is exhausted: the drop already knows which levels it
       * touches, and those are the smaller and more targeted piece of work. A
       * read that failed outright is the same situation as a short one -- look
       * each level up when it is asked for.
       */
      const scan = await readLevels(accountId, { kind: "account" }).catch(() => null);
      const hint = scan ?? new Map<string, Map<string, SiblingNode>>();

      /*
       * The names a folder may be resolved from: a hint is enough.
       *
       * A partial read can only make this walk try a create the server refuses,
       * and that refusal sends it back to look at the level for real -- so the
       * worst a short read costs here is one wasted create per folder that does
       * exist, and the level it teaches is then in hand for everything below it.
       *
       * This is the walk's only use for a level's names. What a folder **holds**
       * is not read at all: a file's name is written into rather than checked,
       * and the refusal of a create is what names the node that has it (see
       * `putFile`), so a level the drop writes files into costs no read.
       */
      const namesAt = async (id: Id | null): Promise<Map<string, SiblingNode>> => {
        const key = levelKey(id);
        const known = hint.get(key);
        if (known) return known;
        const read = await readLevels(accountId, { kind: "level", parentId: id });
        const names = levelNames(read, id);
        hint.set(key, names);
        return names;
      };

      // Folders first, parents before children, so every file has somewhere to go.
      //
      // Nothing in this walk checks the run's signal, and that is deliberate: a
      // run becomes cancellable when its first file is in flight, because until
      // then the tray holds no row of it for the reader to press. The checks
      // that matter are the ones in front of each file, below.
      const dirIds = new Map<string, Id | null>([["", parentId]]);
      // Paths the drop asked for and cannot have; the empty key is the drop
      // itself, which always exists because that is where the reader aimed.
      const missing = new Set<string>();
      for (const path of foldersNeeded(plan)) {
        const key = folderPathKey(path);
        const parentKey = folderPathKey(path.slice(0, -1));
        const name = path[path.length - 1]!;
        /* A parent that could not be resolved takes its whole subtree with it:
         creating the child elsewhere would put it outside the folder it was
         dropped in. */
        if (missing.has(parentKey)) {
          missing.add(key);
          continue;
        }
        const into = dirIds.get(parentKey) ?? parentId;
        const siblings = await namesAt(into);
        const found = siblings.get(name);
        if (found?.nodeType === "directory") {
          dirIds.set(key, found.id);
          continue;
        }
        if (found) {
          // A file is standing where the folder goes. Neither one may be moved
          // out of the way silently, so the folder -- and what was in it -- stop
          // here and say why.
          missing.add(key);
          set({ error: nameTakenMessage(name) });
          continue;
        }
        try {
          const id = await createDirectory(accountId, into, name);
          dirIds.set(key, id);
          siblings.set(name, { id, name, nodeType: "directory" });
        } catch (err) {
          /*
           * Another writer can make the folder between the read and this create,
           * and the server refuses a second create of the same name. That refusal
           * means the folder this drop wanted exists -- so take it rather than
           * reporting a name nobody can see. The level is re-read rather than
           * trusted: the listing in hand was taken before the other writer's
           * create, which is why the create was refused at all.
           */
          if (isAlreadyExists(err)) {
            const key0 = levelKey(into);
            const read = await readLevels(accountId, { kind: "level", parentId: into });
            const fresh = levelNames(read, into);
            /* Merged rather than substituted: the read in hand may have held names
             this one did not (both can be pages of a level larger than one), and
             every name either read saw is a real sibling, so dropping one set
             for the other gives up refusals that were already paid for. */
            const known = hint.get(key0);
            const names = known ? new Map([...known, ...fresh]) : fresh;
            hint.set(key0, names);
            const theirs = names.get(name);
            if (theirs?.nodeType === "directory") {
              dirIds.set(key, theirs.id);
              continue;
            }
          }
          missing.add(key);
          set({ error: (err as Error).message });
        }
      }
      const byFolder = new Map<string, File[]>();
      const orphans: File[] = [];
      for (const item of plan.files) {
        const key = folderPathKey(item.path);
        if (missing.has(key)) {
          orphans.push(item.file);
          continue;
        }
        byFolder.set(key, [...(byFolder.get(key) ?? []), item.file]);
      }
      /*
       * The run's size is the files that have somewhere to go, counted once
       * they all do. A file whose folder could not be made is not of this run
       * -- it was never going to be written -- and its row says so on its own
       * line below, with the count the run it was not part of has.
       */
      run.tally.total = [...byFolder.values()].reduce((n, f) => n + f.length, 0);
      if (orphans.length)
        set((s) => ({
          runs: [
            ...s.runs,
            ...orphans.map((f) =>
              runRow(
                f.name,
                translate("Its folder could not be created."),
                run.id,
                run.tally,
              ),
            ),
          ],
        }));
      /*
       * Every folder of the drop, uploaded through one writer each, one file
       * after another. What each file finds under its own name is the server's
       * answer rather than a listing taken first: a name the folder already
       * holds is written over, and one a folder holds stops the file with the
       * refusal.
       */
      for (const [key, files] of byFolder) {
        if (run.controller.signal.aborted) break;
        const into = dirIds.get(key) ?? parentId;
        for (const file of files) {
          if (run.controller.signal.aborted) break;
          await uploadOne(set, accountId, into, file, run);
        }
      }
    } finally {
      endRun(run);
    }
    await get().loadChildren(parentId);
    void get().loadTree();
  },

  async saveText(id, text, seenBlobId) {
    const accountId = get().accountId!;
    /*
     * Look before writing.
     *
     * `ifInState` is the obvious tool and the wrong one here: it is the state
     * of every FileNode in the account, so an unrelated upload in another
     * folder would fail this save, and a reader who is told "someone changed
     * it" when nobody did learns to click through the warning. The node's own
     * blobId is the thing that actually answers the question.
     */
    const fresh = await client.call<GetResponse<FileNode>>("FileNode/get", {
      accountId,
      ids: [id],
      properties: fileNodeProps(),
    });
    const now = fresh.list[0];
    if (!now) throw new Error(translate("That file is no longer there."));
    if (now.blobId !== seenBlobId)
      throw new Error(
        translate(
          "Somebody else saved this file while it was open. Copy your changes, close it, and start again.",
        ),
      );

    const type = now.type || "text/plain";
    const blob = new Blob([text], { type });
    const up = await client.upload(accountId, blob, { type });
    await writeContent(accountId, id, up.blobId, type, blob.size);
    await get().refresh([id]);
    return up.blobId;
  },

  async rename(id, name) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("FileNode/set", {
      accountId,
      update: { [id]: { name } },
    });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadChildren(get().nodes[id]?.parentId ?? null);
    void get().loadTree();
  },

  async move(id, parentId) {
    await get().moveMany([id], parentId);
  },

  /*
   * One `FileNode/set` for the lot rather than one per file.
   *
   * Not only for the round trip: a loop would apply half the moves and then
   * throw, leaving a selection split across two folders with nothing saying
   * which half went. One call is one answer, and `notUpdated` names whichever
   * ones the server refused.
   */
  async moveMany(ids, parentId) {
    if (!ids.length) return;
    const accountId = get().accountId!;
    const from = new Set(ids.map((id) => get().nodes[id]?.parentId ?? null));
    const update = Object.fromEntries(ids.map((id) => [id, { parentId }]));
    const res = await client.call<SetResponse>("FileNode/set", { accountId, update });
    const failed = Object.values(res.notUpdated ?? {})[0];
    if (failed) throw new Error(setErrorMessage(failed));
    from.add(parentId);
    for (const p of from) await get().loadChildren(p);
    void get().loadTree();
  },

  async destroy(ids) {
    const accountId = get().accountId!;
    const parents = new Set(ids.map((id) => get().nodes[id]?.parentId ?? null));
    const res = await client.call<SetResponse>("FileNode/set", {
      accountId,
      destroy: ids,
      onDestroyRemoveChildren: true,
    });
    const failed = Object.values(res.notDestroyed ?? {})[0];
    if (failed) throw new Error(setErrorMessage(failed));
    for (const p of parents) await get().loadChildren(p);
    void get().loadTree();
  },

  pathTo(id) {
    const out: FileNode[] = [];
    let cur = id ? get().nodes[id] : undefined;
    let guard = 0;
    while (cur && guard++ < 50) {
      out.unshift(cur);
      cur = cur.parentId ? get().nodes[cur.parentId] : undefined;
    }
    return out;
  },

  setListingShown(shown) {
    set({ listingShown: shown });
    /* Remembered for the next session on this device: where Files was left.
       Only a folder counts -- the top level is the absence of a place, and the
       view says `{ parentId: null }` on the way in, which must not overwrite
       the folder somebody was actually in. `null` is the view saying it is on
       its way out; nothing to remember either. */
    if (shown?.parentId)
      rememberPlace(placeOwnerFrom(useSession.getState()), {
        files: { accountId: get().accountId, parentId: shown.parentId },
      });
  },

  applyChanges(types) {
    if (types.has("FileNode")) {
      /* The sidebar tree must be re-read, or a folder created, renamed or
         deleted on another device stays wrong there until a remount. Only when
         a tree is on screen: otherwise the first loadTree (driven by the tree
         view) covers it. */
      if (get().treeLoaded) void get().loadTree();
      /* And the listing being looked at, and only it. Opening a folder reads it
         again anyway -- the view asks on every navigation -- so re-reading
         every folder the reader has ever opened is work that grows with the
         session and keeps no promise: each change paid for all of them, a
         query and a get apiece. */
      const shown = get().listingShown;
      if (shown) void get().loadChildren(shown.parentId);
    }
  },
}));

useSession.subscribe((s) => {
  if (s.status !== "authenticated")
    useFiles.setState({ accountId: null, nodes: {}, children: {}, listingShown: null });
});
