import { FILENODE_GET, FILENODE_QUERY } from "@gilbert/shared/appFolder";
import { errorMessage } from "@gilbert/shared/errors";
import { queryThenGet } from "@gilbert/shared/jmapQuery";
import { isSharedAccountRecord } from "@gilbert/shared/sessionAccount";
import { CAP, client } from "@/jmap/client";
import type { FileNode, GetResponse, Id, QueryResponse } from "@/jmap/types";
import { fileNodeProps } from "@/lib/filenode";
import { sortFiles } from "@/lib/fileSort";
import { DEFAULT_FILES_SORT, placeOwnerFrom, rememberPlace } from "@/lib/lastPlace";
import { useSession } from "../../session";
import {
  emptyForAccount,
  LEVEL_LIMIT,
  pageSize,
  readChildren,
  withoutAppFolder,
} from "../shared";
import type { FilesGet, FilesSet, FilesState, SharedAccount } from "../types";

/**
 * Browsing: which account is open, its tree, the level on screen, and the
 * changes that arrive from elsewhere.
 *
 * A slice of the files store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function treeSlice(
  set: FilesSet,
  get: FilesGet,
): Pick<
  FilesState,
  | "init"
  | "discoverShared"
  | "openAccount"
  | "openOwningAccount"
  | "loadTree"
  | "loadChildren"
  | "refresh"
  | "pathTo"
  | "setListingShown"
  | "applyChanges"
> {
  /*
   * How many levels are being read at once. `loading` is derived from it rather
   * than cleared by each call: two levels loaded together are two runs, and the
   * one that finishes first must not put the spinner away while the other is
   * still on its way.
   */
  let childrenLoads = 0;

  return {
    async init() {
      const session = useSession.getState();
      const ownAccountId = session.ownAccountFor(CAP.filenode);
      const available = Boolean(ownAccountId && client.hasCapability(CAP.filenode));
      /*
       * Stay where the reader is if the session still offers that account.
       * Whether it still holds files is `discoverShared`'s to say, and asking
       * here would put a round trip per shared account on every sign-in for two
       * views nobody has opened yet.
       */
      const browsing = get().accountId;
      const offered = Object.entries(session.session?.accounts ?? {}).some(
        ([id, a]) => id === browsing && isSharedAccountRecord(a),
      );
      if (!(browsing && (browsing === ownAccountId || offered)))
        set(emptyForAccount(ownAccountId));
      set({ available, ownAccountId, initialized: true });
    },

    /**
     * Which shared accounts hold files, asked when a view that lists them opens.
     *
     * A capability list will not answer it: Stalwart advertises the whole set on
     * a shared account -- mail, calendars, contacts and the rest -- identical to
     * a personal one, whatever was actually shared (checked on 0.16.19,
     * 2026-08-27). So each one is asked for its files, and only the ones that
     * answer with any are listed: an account holding none would otherwise appear
     * under "Shared with me", an invitation to open an empty pane, offered by an
     * account whose calendar or contacts were the thing actually shared.
     *
     * The questions go out together -- `client.call` batches the calls made in one
     * tick -- rather than one account after another as they used to.
     */
    async discoverShared() {
      const session = useSession.getState();
      const ownAccountId = get().ownAccountId;
      const candidates = Object.entries(session.session?.accounts ?? {}).filter(([, a]) =>
        isSharedAccountRecord(a),
      );
      const answers = await Promise.all(
        candidates.map(([id, a]) =>
          client.call<QueryResponse>(FILENODE_QUERY, { accountId: id, limit: 1 }).then(
            (res): SharedAccount | null => (res.ids.length ? { id, name: a.name } : null),
            // Refused means nothing here is ours to see, which is the same answer.
            () => null,
          ),
        ),
      );
      const sharedAccounts = answers.filter((a): a is SharedAccount => a !== null);
      // Stay where the reader is if they are reading a share that still exists.
      const browsing = get().accountId;
      const keep =
        browsing &&
        (browsing === ownAccountId || sharedAccounts.some((a) => a.id === browsing));
      if (!keep) set(emptyForAccount(ownAccountId));
      set({ sharedAccounts });
    },

    openAccount(accountId) {
      if (accountId === get().accountId) return;
      set(emptyForAccount(accountId));
    },

    async openOwningAccount(nodeId) {
      // The accounts that could hold it: the one on screen first, so a folder
      // that is already here is not probed for, then the reader's own and each
      // share the session offered.
      const candidates = [
        get().accountId,
        get().ownAccountId,
        ...get().sharedAccounts.map((a) => a.id),
      ].filter((id): id is Id => Boolean(id));
      const seen = new Set<Id>();
      for (const accountId of candidates) {
        if (seen.has(accountId)) continue;
        seen.add(accountId);
        try {
          const res = await client.call<GetResponse<FileNode>>(FILENODE_GET, {
            accountId,
            ids: [nodeId],
            properties: fileNodeProps(),
          });
          if (!res.list.some((n) => n.id === nodeId)) continue;
          if (accountId !== get().accountId) get().openAccount(accountId);
          return;
        } catch {
          // A refused account is not the one holding it; try the next.
        }
      }
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
        /*
         * Up to the module's ceiling in pages of what the server resolves: the
         * sidebar holds every folder the walk looked at, and a level past one
         * request is read in steps rather than cut at the first.
         */
        const dirs: FileNode[] = [];
        const step = pageSize();
        for (let position = 0; dirs.length < LEVEL_LIMIT; position += step) {
          const res = await client.chain(
            queryThenGet({
              query: FILENODE_QUERY,
              get: FILENODE_GET,
              accountId,
              filter: { nodeType: "directory" },
              sort: [{ property: "name", isAscending: true }],
              position,
              limit: Math.min(step, LEVEL_LIMIT - dirs.length),
              maxObjectsInGet: client.maxObjectsInGet,
              properties: fileNodeProps(),
            }),
          );
          const g = res.get("g")?.[0] as unknown as GetResponse<FileNode>;
          // Filtered again here rather than trusted: a server that ignores the
          // nodeType filter answers with files as well, and the tree would draw
          // them as folders you could open into nothing.
          dirs.push(
            ...withoutAppFolder(g.list).filter((n) => n.nodeType === "directory"),
          );
          if (g.list.length < step) break;
        }
        set((s) => {
          const nodes = { ...s.nodes };
          for (const n of dirs) nodes[n.id] = n;
          return { nodes, dirIds: dirs.map((n) => n.id), treeLoaded: true };
        });
      } catch (err) {
        // The listing still works without a tree, so this must not blank the view.
        set({ error: errorMessage(err), treeLoaded: true });
      }
    },

    async loadChildren(parentId) {
      const accountId = get().accountId;
      if (!accountId) return;
      childrenLoads += 1;
      set({ loading: true });
      try {
        /*
         * A level larger than one page is read whole: a single page would show
         * the first rows and silently drop the rest, leaving the tail of the
         * folder unreachable (`readChildren` pages it, and stops when a page
         * comes back short). The read carries no sort any more, so what is stored
         * is `DEFAULT_FILES_SORT` — the order the picker and the move dialog draw
         * directly. The Files view sorts what it draws by the reader's own
         * per-folder order (`useFilesSort`), which is not this one and is not
         * meant to be.
         */
        const listed = sortFiles(
          withoutAppFolder(await readChildren(accountId, parentId)),
          DEFAULT_FILES_SORT,
        );
        childrenLoads -= 1;
        set((s) => {
          const nodes = { ...s.nodes };
          for (const n of listed) nodes[n.id] = n;
          return {
            nodes,
            children: {
              ...s.children,
              [parentId ?? "root"]: listed.map((n) => n.id),
            },
            loading: childrenLoads > 0,
            error: null,
          };
        });
      } catch (err) {
        // No fallback abandons the filters and fetches every node in the
        // account: 0.16 supports parentId/isTopLevel, and quietly loading the
        // whole tree instead would hide a real fault behind a performance cliff
        // nobody would notice.
        childrenLoads -= 1;
        set({ loading: childrenLoads > 0, error: errorMessage(err) });
      }
    },

    /* Re-read named nodes in place. Sharing changes one property of one node and
     nothing about which folder it sits in, so reloading the level around it
     would be a bigger round trip to land in the same place. */
    async refresh(ids) {
      const accountId = get().accountId;
      if (!accountId || !ids.length) return;
      const res = await client.call<GetResponse<FileNode>>(FILENODE_GET, {
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
  };
}
