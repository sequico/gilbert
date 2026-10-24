import { FILENODE_GET, FILENODE_SET, isAppFolder } from "@gilbert/shared/appFolder";
import { sessionIsAdmin } from "@gilbert/shared/sessionAccount";
import {
  isTrashFolder,
  type TrashOrigin,
  uniqueName,
  withOrigins,
  withoutOrigins,
} from "@gilbert/shared/trash";
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { t as translate } from "@/lib/i18n";
import {
  ensureTrashFolder,
  findTrashFolder,
  readTrashOrigins,
  trashFolderId,
  trashRefusal,
  type TrashRefusal,
  writeTrashOrigins,
} from "@/lib/trash";
import { useSession } from "../../session";
import { readChildren } from "../shared";
import type { FilesGet, FilesSet, FilesState } from "../types";

/**
 * The Trash: what Delete does, what Restore does, and who may end what is in it.
 *
 * A slice of the files store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get` (ADR 0013).
 */

/** What a refusal says to the reader, composed here where the catalogue reaches it. */
function refusalMessage(code: TrashRefusal): string {
  return code === "group_files_empty"
    ? translate("Only an administrator can empty a group's trash.")
    : translate("Only an administrator can delete a group's files for good.");
}

/** What the reader's next move is, asked of the session at the moment of the write. */
function endRefusal(
  accountId: Id | null,
  ownAccountId: Id | null,
  kind: "empty" | "final",
) {
  return trashRefusal(
    {
      accountId,
      ownAccountId,
      isAdmin: sessionIsAdmin(useSession.getState().session),
    },
    kind,
  );
}

/**
 * Land named nodes in one folder, numbering a name the folder already holds.
 *
 * The one place a move into a level is written: `trash` lands what the reader
 * deleted in the Trash, and `restore` lands each group back in the folder it
 * came from — one `FileNode/set` per folder either way. A refusal is returned
 * rather than thrown, so a restore over several folders can finish the ones it
 * can and say what failed at the end; `moved` names the nodes that landed and
 * the name each landed with.
 */
async function landIn(
  accountId: Id,
  parentId: Id | null,
  wanted: Array<{ id: Id; name: string }>,
): Promise<{ moved: Array<{ id: Id; name: string }>; failure: unknown }> {
  const level = await readChildren(accountId, parentId);
  const taken = new Set(level.map((n) => n.name));
  const update: Record<Id, { parentId: Id | null; name: string }> = {};
  const landing: Array<{ id: Id; name: string }> = [];
  for (const { id, name } of wanted) {
    const free = uniqueName(taken, name);
    taken.add(free);
    update[id] = { parentId, name: free };
    landing.push({ id, name: free });
  }
  try {
    const res = await client.call<SetResponse>(FILENODE_SET, { accountId, update });
    const failed = Object.values(res.notUpdated ?? {})[0];
    if (failed) throw new Error(setErrorMessage(failed));
    return { moved: landing, failure: null };
  } catch (err) {
    return { moved: [], failure: err };
  }
}

export function trashSlice(
  _set: FilesSet,
  get: FilesGet,
): Pick<FilesState, "trash" | "restore" | "emptyTrash" | "destroyForever"> {
  return {
    async trash(ids) {
      const accountId = get().accountId;
      if (!accountId || !ids.length) return;
      /*
       * Two nodes are never trashed: the Trash folder itself, and Gilbert's own
       * app folder. Both are places this action writes into, and neither is
       * something a person filed.
       */
      const current = trashFolderId(get());
      const list = ids.filter((id) => {
        const node = get().nodes[id];
        return (
          Boolean(node) &&
          !isTrashFolder(node!) &&
          !isAppFolder(node!) &&
          /* A node already in the Trash is ended rather than moved again; with
             no Trash yet, everything is outside it. */
          !(current !== null && node!.parentId === current)
        );
      });
      if (!list.length) return;

      /* Whether the folder is being made by this deletion: the top-level listing
         then has one more row in it, and the reader is looking at some level. */
      const first = !current;
      const trashId = await ensureTrashFolder(accountId);
      const landing = await landIn(
        accountId,
        trashId,
        list.map((id) => ({ id, name: get().nodes[id]!.name })),
      );
      const origins: Record<Id, TrashOrigin> = {};
      for (const { id, name } of landing.moved) {
        const node = get().nodes[id]!;
        origins[id] = { parentId: node.parentId ?? null, name: node.name, as: name };
      }
      /*
       * The origins are a convenience, never the move: a restore that lost this
       * document puts the node at the top level of Files, so a failed write must
       * not report a move that happened as a failed one.
       */
      if (landing.moved.length)
        await writeTrashOrigins(accountId, (doc) => withOrigins(doc, origins)).catch(
          () => undefined,
        );

      await get().loadChildren(trashId);
      const from = new Set<Id | null>();
      for (const { id } of landing.moved) from.add(origins[id]?.parentId ?? null);
      for (const parentId of from) await get().loadChildren(parentId);
      if (first) await get().loadChildren(null);
      void get().loadTree();
      if (landing.failure) throw landing.failure;
    },

    async restore(ids) {
      const accountId = get().accountId;
      if (!accountId || !ids.length) return;
      const { origins } = await readTrashOrigins(accountId);
      /*
       * Which recorded destinations still exist, asked in one read. A folder
       * deleted while its contents sat in the Trash is not a place to put
       * anything back, and `nodes` only holds what this session has read -- so
       * the question goes to the server rather than to the map.
       */
      const recorded = [
        ...new Set(
          ids.map((id) => origins[id]?.parentId).filter((p): p is Id => Boolean(p)),
        ),
      ];
      let alive = new Set<Id>();
      if (recorded.length) {
        try {
          const res = await client.call<GetResponse<FileNode>>(FILENODE_GET, {
            accountId,
            ids: recorded,
            properties: ["id", "nodeType"],
          });
          alive = new Set(
            res.list.filter((n) => n.nodeType === "directory").map((n) => n.id),
          );
        } catch {
          alive = new Set();
        }
      }
      const byTarget = new Map<
        string,
        { parentId: Id | null; wanted: Array<{ id: Id; name: string }> }
      >();
      for (const id of ids) {
        const node = get().nodes[id];
        if (!node) continue;
        const origin = origins[id];
        const parentId =
          origin?.parentId && alive.has(origin.parentId) ? origin.parentId : null;
        /*
         * The name it had comes back when the move is what numbered it; a rename
         * made inside the Trash is the reader's and stays.
         */
        const name = origin && node.name === origin.as ? origin.name : node.name;
        const key = parentId ?? "root";
        const group = byTarget.get(key) ?? { parentId, wanted: [] };
        group.wanted.push({ id, name });
        byTarget.set(key, group);
      }

      const restored: Id[] = [];
      let firstError: unknown = null;
      for (const { parentId, wanted } of byTarget.values()) {
        const { moved, failure } = await landIn(accountId, parentId, wanted);
        if (failure) firstError ??= failure;
        restored.push(...moved.map((m) => m.id));
      }
      if (restored.length)
        await writeTrashOrigins(accountId, (doc) => withoutOrigins(doc, restored)).catch(
          () => undefined,
        );

      const trashId = trashFolderId(get());
      if (trashId) await get().loadChildren(trashId);
      for (const { parentId } of byTarget.values()) await get().loadChildren(parentId);
      void get().loadTree();
      if (firstError) throw firstError;
    },

    async emptyTrash() {
      const accountId = get().accountId;
      if (!accountId) return;
      const refusal = endRefusal(accountId, get().ownAccountId, "empty");
      if (refusal) throw new Error(refusalMessage(refusal));
      const trashId = trashFolderId(get()) ?? (await findTrashFolder(accountId));
      if (!trashId) return;
      const inside = await readChildren(accountId, trashId);
      if (!inside.length) return;
      const res = await client.call<SetResponse>(FILENODE_SET, {
        accountId,
        destroy: inside.map((n) => n.id),
        onDestroyRemoveChildren: true,
      });
      const gone = inside.map((n) => n.id).filter((id) => !res.notDestroyed?.[id]);
      if (gone.length)
        /*
         * An emptied Trash remembers nothing: the whole document goes rather
         * than an entry per node, which also drops the stale origins of items
         * that left the Trash some other way (a drag out to a folder).
         */
        await writeTrashOrigins(accountId, (doc) =>
          gone.length === inside.length ? { origins: {} } : withoutOrigins(doc, gone),
        ).catch(() => undefined);
      await get().loadChildren(trashId);
      void get().loadTree();
      const failed = Object.values(res.notDestroyed ?? {})[0];
      if (failed) throw new Error(setErrorMessage(failed));
    },

    async destroyForever(ids) {
      const accountId = get().accountId;
      if (!accountId || !ids.length) return;
      const refusal = endRefusal(accountId, get().ownAccountId, "final");
      if (refusal) throw new Error(refusalMessage(refusal));
      const trashId = trashFolderId(get()) ?? (await findTrashFolder(accountId));
      if (!trashId) return;
      /*
       * Anything the Trash holds, at any depth: a trashed folder opens like any
       * other, and the rows inside it are inside the Trash too. A node that is
       * not under it is deleted by trashing it, not by ending it.
       */
      const list = ids.filter((id) => get().pathTo(id).some(isTrashFolder));
      if (!list.length) return;
      const res = await client.call<SetResponse>(FILENODE_SET, {
        accountId,
        destroy: list,
        onDestroyRemoveChildren: true,
      });
      const gone = list.filter((id) => !res.notDestroyed?.[id]);
      if (gone.length)
        await writeTrashOrigins(accountId, (doc) => withoutOrigins(doc, gone)).catch(
          () => undefined,
        );
      await get().loadChildren(trashId);
      void get().loadTree();
      const failed = Object.values(res.notDestroyed ?? {})[0];
      if (failed) throw new Error(setErrorMessage(failed));
    },
  };
}
