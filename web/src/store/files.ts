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
  uploads: Array<{ id: string; name: string; progress: number; error: string | null }>;
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
   * A file whose name the folder already holds is refused before its bytes are
   * uploaded, and the refusal is left in the tray as a row: the alternative --
   * a second node under the same name, or the first one quietly replaced -- is
   * a decision this does not make. One listing covers the whole call, so a
   * folder of two hundred files costs one query rather than two hundred, and
   * two files of the same name in one drop are caught here as well.
   */
  upload(parentId: Id | null, files: File[]): Promise<void>;
  /**
   * Take a failed upload out of the tray.
   *
   * A row that went up removes itself; one that did not stays, because its
   * message *is* the error and the reader has to be able to read it. So it is
   * the reader who takes it away, and only such a row offers to.
   */
  dismissUpload(id: string): void;
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
 * The reader is told which file it was and that nothing was replaced, because
 * the alternative the server offers -- `onExists: replace`, `rename`,
 * `newest` -- is a different decision from this one and is not made here.
 */
export function nameTakenMessage(name: string): string {
  return translate("A file called \u201c{name}\u201d is already here.", { name });
}

/**
 * Upload one file into an account and create the node that points at it.
 *
 * The account is a parameter because a node has to be created in the account
 * that holds the blob, and that is not always the one being browsed: saving a
 * message's attachments to Files can mean the reader's own files or a group's.
 *
 * Callers check the folder's names first, so a duplicate usually costs nothing
 * -- see the level reads in this store. This refusal is the server's, and it is
 * the one that counts: a name that appeared between that read and this write
 * lands here, and it reads the same as the duplicate the caller already caught.
 */
async function putFile(
  accountId: Id,
  parentId: Id | null,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Id> {
  const type = file.type || "application/octet-stream";
  const up = await client.upload(accountId, file, {
    type,
    onProgress:
      onProgress && ((loaded, total) => onProgress(Math.round((loaded / total) * 100))),
  });
  const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
    accountId,
    create: { f: fileCreate(parentId, file.name, up.blobId, type) },
  });
  const err = res.notCreated?.f;
  if (err)
    throw isAlreadyExists(err)
      ? new NameTakenError(err.existingId, nameTakenMessage(file.name))
      : new Error(setErrorMessage(err));
  return res.created!.f!.id;
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
 * many may have been cut short, which is what `readLevels` reports as
 * `complete`.
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
 * **The one place** a tree of nodes is turned into names-to-write-against, and
 * the one place a read's completeness is decided -- shared by the whole-account
 * scan a drop starts with and by the single-level read a writer makes, so the
 * two cannot answer the question differently. They did: the level read worked
 * its completeness out from the nodes the `get` returned and the total the
 * query reported, and a `get` truncated by its own ceiling on a level larger
 * than one page made it call a partial read whole.
 *
 * A level read buckets to exactly one level, which is all the callers of the
 * single-level form want; they ask for their level by key. Asking for
 * `parentId` on a level read is one property that buys the shared code path.
 */
async function readLevels(
  accountId: Id,
  scope: LevelScope,
): Promise<{ levels: Map<string, Map<string, SiblingNode>>; complete: boolean }> {
  const { list, complete } = await listChildrenWithState(
    accountId,
    scope.kind === "level" ? scope.parentId : null,
    ["id", "name", "nodeType", "parentId"],
    { limit: LEVEL_LIMIT, scope: scope.kind === "account" ? "account" : "level" },
  );
  const levels = new Map<string, Map<string, SiblingNode>>();
  for (const n of list) {
    const key = levelKey(n.parentId ?? null);
    const names = levels.get(key) ?? new Map<string, SiblingNode>();
    names.set(String(n.name), { id: n.id, name: n.name, nodeType: n.nodeType });
    levels.set(key, names);
  }
  return { levels, complete };
}

/**
 * A folder's names, as a writer checks them before it creates anything.
 *
 * **A partial map is sound to check against, and that is the point.** Every
 * entry comes from a FileNode the server returned for this level, so a name
 * found here really is taken and a create of it really would be refused -- the
 * check can therefore never invent a duplicate. What a short read costs is the
 * opposite: a name it did not reach, which is a create that gets attempted and
 * refused with the blob already paid for.
 *
 * That asymmetry is why this is a plain map and not a map-plus-a-completeness-
 * flag. Gating the check on completeness was tried and is wrong: skipping a
 * check that could not have been false only gives up refusals that were free.
 * Completeness is still asked for -- `readLevels` answers it -- but its one
 * real use is deciding whether a level is worth **reading**, which is a
 * question about requests rather than about correctness.
 */
async function namesAtLevel(
  accountId: Id,
  parentId: Id | null,
): Promise<Map<string, SiblingNode>> {
  const { levels } = await readLevels(accountId, { kind: "level", parentId });
  return levels.get(levelKey(parentId)) ?? new Map();
}

/**
 * One file: its tray row, the duplicate check, the upload and the node.
 *
 * Shared by the picker and by a drop, because both owe the reader the same
 * three things -- a row that reports progress, a name that is not silently
 * taken, and no upload paid for when the name is already there. The `taken` map
 * is the caller's: the picker reads the one folder it writes into, and a drop
 * the account once, so neither lists a folder again per file.
 *
 * `taken` is what the caller could find out about the folder, and it may be
 * short: a level larger than one page of it answers with a page. Checking
 * against that page is still worth doing -- every entry is a real sibling, so a
 * name found there really is taken -- and an empty map simply means the folder
 * answered with nothing this writer could see. See `namesAtLevel`.
 */
async function uploadOne(
  set: StoreApi<FilesState>["setState"],
  accountId: Id,
  parentId: Id | null,
  file: File,
  taken: Map<string, SiblingNode>,
): Promise<void> {
  const row = uploadRow(file.name, null);
  set((s) => ({ uploads: [...s.uploads, row] }));
  try {
    if (taken.has(file.name))
      throw new NameTakenError(undefined, nameTakenMessage(file.name));
    await putFile(accountId, parentId, file, (percent) =>
      set((s) => ({
        uploads: s.uploads.map((u) =>
          u.id === row.id ? { ...u, progress: percent } : u,
        ),
      })),
    );
    taken.set(file.name, { id: "", name: file.name, nodeType: "file" });
    set((s) => ({ uploads: s.uploads.filter((u) => u.id !== row.id) }));
  } catch (err) {
    // The row stays: its message *is* the error, and the reader takes it away.
    set((s) => ({
      uploads: s.uploads.map((u) =>
        u.id === row.id ? { ...u, error: (err as Error).message } : u,
      ),
    }));
  }
}

/**
 * A record in the upload tray, the one place a failure is reported.
 *
 * The id is what a progress update and a dismissal are aimed at, so two files
 * of the same name in one drop must not share one -- `Date.now()` alone hands
 * both the same value, and the second file's progress would then move the
 * first file's row.
 */
const uploadRow = (name: string, error: string | null) => ({
  id: `${Date.now()}-${name}-${Math.random().toString(36).slice(2, 7)}`,
  name,
  progress: 0,
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
  uploads: [],
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
   * A file the folder already holds is refused before its bytes are uploaded.
   *
   * Stalwart charges for every upload and never gives one back, so the check is
   * worth making here rather than discovering at the write: the server would
   * refuse the create anyway (`alreadyExists`), and by then the blob is paid
   * for. One listing covers the whole call, and the names it found are added to
   * as this loop goes, so two files of the same name in one drop are caught
   * too. A listing that fails is not a reason to refuse the upload: the server
   * still is, one layer down.
   */
  async upload(parentId, files) {
    const accountId = get().accountId!;
    const taken = await namesAtLevel(accountId, parentId).catch(
      () => new Map<string, SiblingNode>(),
    );
    for (const f of files) await uploadOne(set, accountId, parentId, f, taken);
    await get().loadChildren(parentId);
  },

  /*
   * The way out of a row that failed.
   *
   * Nothing else takes one away: the tray is the only place a failed upload is
   * reported, and a row left in it would sit there for the rest of the session,
   * in every folder, with nothing to press.
   */
  dismissUpload(id) {
    set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
  },

  async uploadTo(accountId, files, parentId = null) {
    const failed: string[] = [];
    const existing: string[] = [];
    let saved = 0;
    /*
     * One read of the folder, and whatever it answered is worth checking
     * against: a page of a large folder still names real siblings, so a name
     * found in it really is taken. A read that failed leaves an empty map,
     * which refuses nothing and lets the server say so -- the same outcome as
     * having no list at all.
     */
    const taken = await namesAtLevel(accountId, parentId).catch(
      () => new Map<string, SiblingNode>(),
    );
    for (const f of files) {
      try {
        if (taken.has(f.name)) {
          existing.push(f.name);
          continue;
        }
        await putFile(accountId, parentId, f);
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
   * A folder that cannot be resolved is not a folder to guess at. Nothing below
   * it is created, and the files that were headed for it are left in the tray as
   * failures: filing them into the nearest folder that does exist is how a drop
   * comes to scatter files somewhere nobody chose.
   */
  async uploadPlan(parentId, plan) {
    const accountId = get().accountId!;
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
    const hint = scan?.levels ?? new Map<string, Map<string, SiblingNode>>();

    /*
     * The names a **folder** may be resolved from: a hint is enough.
     *
     * A partial read can only make this walk try a create the server refuses,
     * and that refusal sends it back to look at the level for real -- so the
     * worst a short read costs here is one wasted create per folder that does
     * exist, and the level it teaches is then in hand for everything below it.
     */
    const namesAt = async (id: Id | null): Promise<Map<string, SiblingNode>> => {
      const key = levelKey(id);
      const known = hint.get(key);
      if (known) return known;
      const names = await namesAtLevel(accountId, id);
      hint.set(key, names);
      return names;
    };

    /*
     * The names a **file** may be checked against: everything in hand for that
     * level, however short it is.
     *
     * A page of a folder names real siblings, so checking against it is sound
     * whether or not it is the whole folder -- the worst it can do is miss a
     * duplicate, never invent one (see `namesAtLevel`). What completeness
     * decides is whether it is worth a **request** to see more, and the
     * account read is what says so: on an account it finished, what is in hand
     * for a level is all of it, including "nothing" for a folder that is really
     * empty. On one it did not, a level the drop writes into is read for itself
     * -- one request per level written into, not per folder the drop names --
     * and the two are merged, since either read's names are real.
     */
    const filesAt = async (id: Id | null): Promise<Map<string, SiblingNode>> => {
      const key = levelKey(id);
      const known = hint.get(key);
      if (scan?.complete) return known ?? new Map();
      const fresh = await namesAtLevel(accountId, id).catch(() => null);
      if (!fresh) return known ?? new Map();
      const names = known ? new Map([...known, ...fresh]) : fresh;
      hint.set(key, names);
      return names;
    };
    // Folders first, parents before children, so every file has somewhere to go.
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
          const fresh = await namesAtLevel(accountId, into);
          hint.set(levelKey(into), fresh);
          const theirs = fresh.get(name);
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
    for (const item of plan.files) {
      const key = folderPathKey(item.path);
      if (missing.has(key)) {
        set((s) => ({
          uploads: [
            ...s.uploads,
            uploadRow(item.file.name, translate("Its folder could not be created.")),
          ],
        }));
        continue;
      }
      byFolder.set(key, [...(byFolder.get(key) ?? []), item.file]);
    }
    /*
     * Every folder of the drop, uploaded through one writer each -- with the
     * names already in hand where the account read could be trusted, and read
     * for themselves where it could not. Either way no folder is listed twice
     * for the same file, and a level the drop writes into is the only kind that
     * costs a request at all.
     */
    for (const [key, files] of byFolder) {
      const into = dirIds.get(key) ?? parentId;
      const taken = await filesAt(into);
      for (const file of files) await uploadOne(set, accountId, into, file, taken);
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
    const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
      accountId,
      update: { [id]: { blobId: up.blobId, type, size: blob.size } },
    });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
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
