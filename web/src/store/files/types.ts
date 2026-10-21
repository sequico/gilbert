import type { StoreApi } from "zustand";
import type { FileNode, Id } from "@/jmap/types";
import type { DropPlan } from "@/lib/dropUpload";

export interface SharedAccount {
  id: Id;
  name: string;
}

export interface FilesState {
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
  /**
   * What each folder on screen holds, one level down, as the server counted it.
   *
   * Held in the store rather than in the view because it is a fact about the
   * account, not about one screen: the Files view and anything else that draws a
   * folder's Size read the same number. `null` is the answer "the server states
   * no total", which is not zero and not one — a page of one asked for one id
   * would otherwise read as a folder holding exactly one thing.
   *
   * A level is dropped from it whenever that level is read again
   * (`loadChildren`), which is the one path an upload, a delete, a move or a
   * change from another device passes through.
   */
  folderCounts: Record<Id, number | null>;
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

  /** Whether Files is available and which account is the reader's. No round trip. */
  init(): Promise<void>;
  /** Ask each shared account whether it holds files; see the note on it. */
  discoverShared(): Promise<void>;
  /** Browse an account: the reader's own, or one shared with them. */
  openAccount(accountId: Id | null): void;
  /**
   * Open the account that holds `nodeId`, asking each one that could.
   *
   * A link names a folder and not the account it lives in, and Files opens a
   * shared account in place: a cold load starts on the reader's own, where the
   * folder is not, so the listing comes back empty. Nothing moves when none of
   * the accounts holds it -- that is the empty-folder case, not a reason to
   * take the reader somewhere else.
   */
  openOwningAccount(nodeId: Id): Promise<void>;
  loadChildren(parentId: Id | null): Promise<void>;
  /**
   * Record what a folder holds, as the count query answered it: a number, or
   * `null` when the server states no total for the level.
   */
  setFolderCount(id: Id, count: number | null): void;
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
 * What `create` hands a slice: the store's own reader and writer.
 *
 * The store is assembled in `index.ts` from one function per job, and a slice
 * never imports the store it belongs to -- it is handed these two, which is what
 * keeps the modules acyclic and each one readable on its own.
 */
export type FilesSet = StoreApi<FilesState>["setState"];
export type FilesGet = StoreApi<FilesState>["getState"];
