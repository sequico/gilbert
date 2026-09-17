/**
 * Merging two folders into one, planned before anything is written.
 *
 * The reader selects two folders of one listing — two siblings, which is what a
 * selection is — and asks for them to become one. One of the two survives: its
 * node, its id, its sharing and its place in the tree. Everything the other one
 * holds moves into it, and the folder the reader gave up is destroyed once it
 * is empty.
 *
 * **The plan is decided before the first write, and a collision stops the whole
 * thing.** Two trees can disagree in ways no writer may settle on its own — a
 * name that is a folder on one side and a file on the other, a right the reader
 * does not hold — and a merge that discovered one of those halfway through
 * would have half a folder moved into another, with nothing that says which
 * half. So `planMerge` walks both trees first and answers two lists: the steps
 * that would be taken, and the collisions that stop every one of them.
 *
 * The trees are read through a function the caller supplies rather than from a
 * snapshot, so this asks for exactly the levels it decides about: a folder that
 * is not in the other one is **one step**, not a walk, and its subtree is never
 * read.
 *
 * Nothing here talks to a server. The one reader of it is `mergeFolders` in
 * `web/src/store/files.ts`, which owns the calls.
 */

import type { FileNode, FilesRights, Id } from "@/jmap/types";
import { plural, t } from "@/lib/i18n";

/**
 * What the merge needs to know about a node: what it is called, what kind of
 * thing it is, whether it carries bytes, and what the reader's rights allow.
 *
 * A `FileNode` satisfies this as it stands, so the store passes the nodes it
 * already holds instead of projecting them.
 */
export interface MergeNode {
  id: Id;
  name: string;
  parentId: Id | null;
  nodeType: FileNode["nodeType"];
  blobId?: Id | null;
  type?: string | null;
  myRights?: Partial<FilesRights> | null;
}

/**
 * One of the two folders being merged: the folder itself, and one level of it
 * on demand.
 *
 * `childrenOf` is the caller's read, so the walk below spends a request only on
 * a level it has a decision to make about.
 */
export interface MergeTree {
  root: MergeNode;
  childrenOf(parentId: Id): Promise<MergeNode[]>;
}

/**
 * One thing the merge would do, in the order it would be done.
 *
 * `name` travels with every step because the tray row says what is in flight,
 * and the step is what knows.
 */
export type MergeStep =
  /** Move a node — with everything under it — into a folder of the kept tree. */
  | { kind: "move"; srcId: Id; into: Id; name: string }
  /**
   * Write one file's bytes into the node holding its name in the kept tree, and
   * destroy the file they were read out of. The blob and its type travel on the
   * step so the writer needs no second lookup, and `srcId` travels with them
   * because a merge leaves **one** node of that name behind, not two.
   */
  | { kind: "replace"; srcId: Id; dstId: Id; name: string; blobId: Id; type: string }
  /** Destroy a folder the merge emptied — the last thing done in it. */
  | { kind: "rmdir"; id: Id; name: string };

/**
 * Why two trees cannot be merged, in codes rather than sentences.
 *
 * The codes are the vocabulary; the sentences are composed from them below, so
 * a reason added here without one does not compile.
 */
export type MergeConflictReason =
  /** One side is a folder and the other is a file: neither can become the other. */
  | "mixed"
  /** The node being merged in carries no content to copy. */
  | "no-bytes"
  /** A right the merge needs is not the reader's. */
  | "no-right";

export interface MergeConflict {
  /**
   * Where the two trees disagree, named from the folder being kept down —
   * `["Work", "Clients", "report.pdf"]`.
   */
  path: string[];
  reason: MergeConflictReason;
}

export interface MergePlan {
  /**
   * Every step, in the order it would be taken — and **empty when anything
   * collides**, so no caller can execute half a plan by mistake.
   */
  steps: MergeStep[];
  conflicts: MergeConflict[];
}

/** Whether a node is a folder. `symlink` is not: it has no children of its own. */
function isFolder(n: MergeNode): boolean {
  return n.nodeType === "directory";
}

/**
 * Whether the reader holds a right, where a node that carries no rights at all
 * is not a refusal.
 *
 * The same reading as `canDropFileNode`'s: rights are known for everything the
 * listing and the scan read, and a node whose rights are unknown is left to the
 * server to refuse rather than hidden behind a guess.
 */
function may(n: MergeNode | undefined, right: keyof FilesRights): boolean {
  return n?.myRights?.[right] !== false;
}

/**
 * The merge, as the sequence of steps that would carry it out.
 *
 * Four things can meet at a name, and each has one answer:
 *
 * - **nothing of that name in the kept tree** — the node moves in, with
 *   everything under it. Its subtree is not read: a folder that arrives whole
 *   is one step whatever it holds.
 * - **a folder on both sides** — the two merge, so the walk descends and the
 *   folder it emptied is destroyed on the way back up.
 * - **something carrying content on both sides** — the file's bytes are written
 *   into the node the kept tree already has under that name, which is
 *   `writeContent`'s rule from ADR 0013: the id, the sharing and the place in
 *   the tree stay, and only the content changes. Never a destroy-and-create, so
 *   nothing that referred to that file — a share, a chat message, a composer
 *   attachment — is invalidated by a name landing on it. The file the bytes came
 *   from is then destroyed, because a merge leaves one node of a name rather
 *   than two, and the folder it was in has to be empty to be destroyed at all.
 * - **a folder against a file** — a collision, because neither may be renamed,
 *   destroyed or put beside the other without being asked.
 *
 * The steps come out in the order they must be taken: a folder is destroyed
 * after everything of it has left, which the recursion gives, and the folder
 * given up is destroyed last of all.
 */
export async function planMerge(src: MergeTree, dst: MergeTree): Promise<MergePlan> {
  const steps: MergeStep[] = [];
  const conflicts: MergeConflict[] = [];

  if (!may(src.root, "mayDelete"))
    conflicts.push({ path: [src.root.name], reason: "no-right" });

  const walk = async (from: MergeNode, into: MergeNode, path: string[]) => {
    /*
     * Nothing may be moved into a folder that takes no children, so this pair
     * stops here rather than reporting, one step at a time, what the server
     * would refuse.
     */
    if (!may(into, "mayAddChildren")) {
      conflicts.push({ path, reason: "no-right" });
      return;
    }
    const [children, siblings] = await Promise.all([
      src.childrenOf(from.id),
      dst.childrenOf(into.id),
    ]);
    const held = new Map(siblings.map((n) => [n.name, n]));
    for (const child of children) {
      const here = [...path, child.name];
      const match = held.get(child.name);
      if (!match) {
        steps.push({ kind: "move", srcId: child.id, into: into.id, name: child.name });
        continue;
      }
      if (isFolder(child) && isFolder(match)) {
        if (!may(child, "mayDelete")) {
          conflicts.push({ path: here, reason: "no-right" });
          continue;
        }
        await walk(child, match, here);
        steps.push({ kind: "rmdir", id: child.id, name: child.name });
        continue;
      }
      if (isFolder(child) !== isFolder(match)) {
        conflicts.push({ path: here, reason: "mixed" });
        continue;
      }
      if (!may(match, "mayModifyContent")) {
        conflicts.push({ path: here, reason: "no-right" });
        continue;
      }
      if (!child.blobId) {
        conflicts.push({ path: here, reason: "no-bytes" });
        continue;
      }
      steps.push({
        kind: "replace",
        srcId: child.id,
        dstId: match.id,
        name: child.name,
        blobId: child.blobId,
        type: child.type || "application/octet-stream",
      });
    }
  };

  await walk(src.root, dst.root, [dst.root.name]);
  /*
   * The folder given up goes last, once the walk has emptied it. Its own right
   * to be destroyed was read before anything was planned, so a merge that may
   * not finish is never started.
   */
  steps.push({ kind: "rmdir", id: src.root.id, name: src.root.name });
  /*
   * A collision leaves no plan at all rather than a plan with a warning on it:
   * the caller's one question is whether to start, and a half-answer that can
   * be executed is the failure this walk exists to prevent.
   */
  return conflicts.length ? { steps: [], conflicts } : { steps, conflicts };
}

/**
 * One sentence per collision reason, in English, with the path as a hole.
 *
 * Held unwrapped rather than through `t()` at this scope: a module-level call
 * would fix the language at the moment the file was imported, and the reader can
 * change it later. The composer below is what translates, so the sentence
 * reaches `t()` as a variable and no literal is there for `i18n:check` to find --
 * which is why the name ends in `_LABELS`, the shape that check reads to know a
 * constant table's strings are translated where they render rather than never.
 */
const CONFLICT_LABELS: Record<MergeConflictReason, string> = {
  mixed:
    "\u201c{path}\u201d is a folder in one of the two and a file in the other, so neither can be merged into the other.",
  "no-bytes": "\u201c{path}\u201d carries no content to write over the file of its name.",
  "no-right": "\u201c{path}\u201d is not yours to change.",
};

/** How a collision names the place it is about: the folders, then the name. */
export function conflictPath(conflict: MergeConflict): string {
  return conflict.path.join("/");
}

/**
 * What the reader is told when a merge stops before it starts.
 *
 * The collision is named, and how many more there are after it: one name to fix
 * is not the same as a tree full of them, and a merge that reported one at a
 * time would take a retry per collision to enumerate.
 */
export function mergeBlockedMessage(conflicts: MergeConflict[]): string {
  const first = conflicts[0];
  if (!first) return "";
  const named = t(CONFLICT_LABELS[first.reason], { path: conflictPath(first) });
  const rest = conflicts.length - 1;
  if (!rest) return named;
  return `${named} ${plural(rest, {
    one: "One more collision stops it too.",
    other: "{n} more collisions stop it too.",
  })}`;
}
