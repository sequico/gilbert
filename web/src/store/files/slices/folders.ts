import { FILENODE_SET } from "@gilbert/shared/appFolder";
import { errorMessage } from "@gilbert/shared/errors";
import { isTrashFolder } from "@gilbert/shared/trash";
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, Id, SetResponse } from "@/jmap/types";
import { canDropFileNodes } from "@/lib/filenode";
import type { MergePlan, MergeTree } from "@/lib/folderMerge";
import { mergeBlockedMessage, planMerge } from "@/lib/folderMerge";
import { t as translate } from "@/lib/i18n";
import { trashFolderId } from "@/lib/trash";
import {
  createDirectory,
  endRun,
  readChildren,
  runRow,
  startRun,
  type TrayRun,
  writeContent,
} from "../shared";
import type { FilesGet, FilesSet, FilesState } from "../types";

/**
 * A folder as `planMerge` reads it: the node itself, and levels read once and
 * remembered.
 *
 * The memo is what makes the plan cheap over a tree the walk visits once per
 * level: the same folder is never read twice, and a folder the plan does not
 * descend into is never read at all -- which is the whole reason the tree is a
 * function rather than a snapshot.
 */
function mergeTree(accountId: Id, root: FileNode, signal: AbortSignal): MergeTree {
  const levels = new Map<Id, FileNode[]>();
  return {
    root,
    async childrenOf(parentId) {
      signal.throwIfAborted();
      const held = levels.get(parentId);
      if (held) return held;
      const list = await readChildren(accountId, parentId, signal);
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
  const res = await client.call<SetResponse>(FILENODE_SET, { accountId, update });
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
  const res = await client.call<SetResponse>(FILENODE_SET, {
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
 * (ADR 0011). Re-pointing the node at the other one's blob would save both the
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
  set: FilesSet,
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
 * What a person does to the folders themselves: make one, merge two, rename,
 * move, destroy.
 *
 * A slice of the files store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function foldersSlice(
  set: FilesSet,
  get: FilesGet,
): Pick<FilesState, "mkdir" | "mergeFolders" | "rename" | "move" | "moveMany"> {
  return {
    async mkdir(parentId, name) {
      const id = await createDirectory(get().accountId!, parentId, name);
      await get().loadChildren(parentId);
      void get().loadTree();
      return id;
    },

    async mergeFolders(keepId, mergeId) {
      const accountId = get().accountId!;
      const keep = get().nodes[keepId];
      const merge = get().nodes[mergeId];
      if (keep?.nodeType !== "directory" || merge?.nodeType !== "directory")
        throw new Error(translate("Merging takes two folders."));
      /*
       * Not inside the Trash. A merge destroys the folder given up, which is the
       * final step ADR 0013 keeps for the reader's own files and an installation
       * administrator — and the menu that offers it is disabled there too.
       */
      const trashId = trashFolderId(get());
      if (trashId !== null && keep.parentId === trashId)
        throw new Error(translate("Merging is not offered inside the trash."));

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
          mergeTree(accountId, merge, run.controller.signal),
          mergeTree(accountId, keep, run.controller.signal),
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
        fail(errorMessage(err));
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

    async rename(id, name) {
      const accountId = get().accountId!;
      // The Trash is the product's own folder: renaming it would put it out of
      // reach of the rule that finds it, and the next delete would make a second.
      const held = get().nodes[id];
      if (held && isTrashFolder(held))
        throw new Error(translate("The trash cannot be renamed."));
      const res = await client.call<SetResponse>(FILENODE_SET, {
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
      // The Trash is a place the product owns: it is entered by deleting and
      // left by restoring, never dragged somewhere.
      if (
        ids.some((id) => {
          const node = get().nodes[id];
          return Boolean(node) && isTrashFolder(node!);
        })
      )
        throw new Error(translate("The trash cannot be moved."));
      // One rule for every way in, asked where the move is actually committed:
      // the drag and the move dialog both ask it, and the store is the choke
      // point that stops a caller which did not — a move into a node's own
      // subtree is refused here rather than sent.
      if (!canDropFileNodes(get().nodes, ids, parentId))
        throw new Error(translate("That move is not allowed."));
      const accountId = get().accountId!;
      const from = new Set(ids.map((id) => get().nodes[id]?.parentId ?? null));
      await moveNodes(accountId, ids, parentId);
      from.add(parentId);
      for (const p of from) await get().loadChildren(p);
      void get().loadTree();
    },
  };
}
