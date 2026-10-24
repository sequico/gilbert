import { FILENODE_GET, FILENODE_SET, isAppFolder } from "@gilbert/shared/appFolder";
import { sessionIsAdmin } from "@gilbert/shared/sessionAccount";
import {
  isTrashFolder,
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
      /* What the Trash already holds, read once: two nodes of one name landing
         here is the ordinary case -- the reader deleted two "report.pdf". */
      const inside = await readChildren(accountId, trashId);
      const taken = new Set(inside.map((n) => n.name));
      const update: Record<Id, { parentId: Id; name: string }> = {};
      const origins: Record<Id, Id | null> = {};
      for (const id of list) {
        const node = get().nodes[id]!;
        const name = uniqueName(taken, node.name);
        taken.add(name);
        update[id] = { parentId: trashId, name };
        origins[id] = node.parentId ?? null;
      }
      const res = await client.call<SetResponse>(FILENODE_SET, { accountId, update });
      const moved = list.filter((id) => !res.notUpdated?.[id]);
      /*
       * The origins are a convenience, never the move: a restore that lost this
       * document puts the node at the top level of Files, so a failed write must
       * not report a move that happened as a failed one.
       */
      if (moved.length)
        await writeTrashOrigins(accountId, (doc) =>
          withOrigins(
            doc,
            Object.fromEntries(moved.map((id) => [id, origins[id] ?? null])),
          ),
        ).catch(() => undefined);

      await get().loadChildren(trashId);
      const from = new Set<Id | null>();
      for (const id of moved) from.add(origins[id] ?? null);
      for (const parentId of from) await get().loadChildren(parentId);
      if (first) await get().loadChildren(null);
      void get().loadTree();
      const failed = Object.values(res.notUpdated ?? {})[0];
      if (failed) throw new Error(setErrorMessage(failed));
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
        ...new Set(ids.map((id) => origins[id]).filter((p): p is Id => Boolean(p))),
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
      const byTarget = new Map<string, { parentId: Id | null; ids: Id[] }>();
      for (const id of ids) {
        if (!get().nodes[id]) continue;
        const origin = origins[id];
        const parentId = origin && alive.has(origin) ? origin : null;
        const key = parentId ?? "root";
        const group = byTarget.get(key) ?? { parentId, ids: [] };
        group.ids.push(id);
        byTarget.set(key, group);
      }

      const restored: Id[] = [];
      let firstError: unknown = null;
      for (const { parentId, ids: group } of byTarget.values()) {
        const level = await readChildren(accountId, parentId);
        const taken = new Set(level.map((n) => n.name));
        const update: Record<Id, { parentId: Id | null; name: string }> = {};
        for (const id of group) {
          const node = get().nodes[id]!;
          const name = uniqueName(taken, node.name);
          taken.add(name);
          update[id] = { parentId, name };
        }
        try {
          const res = await client.call<SetResponse>(FILENODE_SET, {
            accountId,
            update,
          });
          const failed = Object.values(res.notUpdated ?? {})[0];
          if (failed) throw new Error(setErrorMessage(failed));
          restored.push(...group);
        } catch (err) {
          firstError ??= err;
        }
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
        await writeTrashOrigins(accountId, (doc) => withoutOrigins(doc, gone)).catch(
          () => undefined,
        );
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
      /* Only what sits directly in the Trash: the action is offered there, and a
         node elsewhere is deleted by trashing it, not by ending it. */
      const list = ids.filter((id) => get().nodes[id]?.parentId === trashId);
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
