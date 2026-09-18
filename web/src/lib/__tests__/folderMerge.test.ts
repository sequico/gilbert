import { describe, expect, it } from "vitest";
import {
  conflictPath,
  type MergeNode,
  type MergeStep,
  type MergeTree,
  mergeBlockedMessage,
  planMerge,
} from "../folderMerge";

/**
 * The plan a merge is carried out from.
 *
 * Two folders become one: what the folder given up holds moves into the one
 * being kept, a name they both hold is written into the node that is already
 * there, and the emptied folder is destroyed. All of it is decided before the
 * first write, because a collision found halfway through would leave half a
 * folder merged with nothing saying which half.
 *
 * These are cases over the plan alone — no server, no store — which is what
 * makes the awkward ones cheap to state: the trees are read through a function
 * the test owns, so a level that should not be read is a call that does not
 * happen.
 */

const dir = (id: string, name: string, parentId: string | null): MergeNode => ({
  id,
  name,
  parentId,
  nodeType: "directory",
});

const file = (
  id: string,
  name: string,
  parentId: string | null,
  blobId: string | null = `blob-${id}`,
  type = "application/pdf",
): MergeNode => ({ id, name, parentId, nodeType: "file", blobId, type });

/**
 * One of the two folders, over a flat list of nodes.
 *
 * `reads` records every level asked for, which is how "a folder that arrives
 * whole is never walked" is asserted rather than assumed.
 */
function tree(root: MergeNode, nodes: MergeNode[]) {
  const reads: string[] = [];
  const t: MergeTree = {
    root,
    async childrenOf(parentId) {
      reads.push(parentId);
      return nodes.filter((n) => n.parentId === parentId);
    },
  };
  return { t, reads };
}

const kinds = (steps: MergeStep[]) => steps.map((s) => s.kind);
const names = (steps: MergeStep[]) => steps.map((s) => s.name);

describe("planMerge", () => {
  /*
   * The ordinary merge: nothing of the same name, so everything moves in and
   * the folder given up is destroyed.
   */
  it("moves what only one of them holds, then destroys the emptied folder", async () => {
    const src = tree(dir("b", "Archive", null), [
      dir("b1", "2024", "b"),
      file("b2", "notes.txt", "b"),
    ]);
    const dst = tree(dir("a", "Work", null), []);

    const { steps, conflicts } = await planMerge(src.t, dst.t);

    expect(conflicts).toEqual([]);
    expect(steps).toEqual([
      { kind: "move", srcId: "b1", into: "a", name: "2024" },
      { kind: "move", srcId: "b2", into: "a", name: "notes.txt" },
      { kind: "rmdir", id: "b", name: "Archive" },
    ]);
  });

  /*
   * A folder that arrives whole is one step, and its subtree is not read: there
   * is no name for it to collide with, and walking it would be requests spent
   * on a decision already made.
   */
  it("does not read the subtree of a folder that moves in whole", async () => {
    const src = tree(dir("b", "Archive", null), [
      dir("b1", "2024", "b"),
      file("b2", "deep.txt", "b1"),
    ]);
    const dst = tree(dir("a", "Work", null), []);

    const { steps } = await planMerge(src.t, dst.t);

    expect(names(steps)).toEqual(["2024", "Archive"]);
    // The level of the moved folder was never asked for.
    expect(src.reads).toEqual(["b"]);
  });

  /*
   * A name both folders hold as a folder merges: the two become one, so the
   * walk descends into the pair and the folder it emptied is destroyed on the
   * way back up.
   */
  it("merges two folders of the same name, deepest first", async () => {
    const src = tree(dir("b", "Archive", null), [
      dir("b1", "Clients", "b"),
      file("b2", "eu.pdf", "b1"),
    ]);
    const dst = tree(dir("a", "Work", null), [
      dir("a1", "Clients", "a"),
      file("a2", "us.pdf", "a1"),
    ]);

    const { steps, conflicts } = await planMerge(src.t, dst.t);

    expect(conflicts).toEqual([]);
    expect(steps).toEqual([
      { kind: "move", srcId: "b2", into: "a1", name: "eu.pdf" },
      { kind: "rmdir", id: "b1", name: "Clients" },
      { kind: "rmdir", id: "b", name: "Archive" },
    ]);
    // The kept folder's own node never moves or changes name.
    expect(steps.some((s) => "id" in s && s.id === "a")).toBe(false);
  });

  /*
   * The name both hold as a file: the bytes are written into the node that is
   * already there, so its id, its sharing and its place in the tree stay
   * (ADR 0013). A destroy-and-create would invalidate everything that pointed
   * at that file.
   */
  it("writes one file's bytes into the node holding its name", async () => {
    const src = tree(dir("b", "Archive", null), [file("b1", "report.pdf", "b")]);
    const dst = tree(dir("a", "Work", null), [file("a1", "report.pdf", "a")]);

    const { steps, conflicts } = await planMerge(src.t, dst.t);

    expect(conflicts).toEqual([]);
    expect(steps).toEqual([
      {
        kind: "replace",
        srcId: "b1",
        dstId: "a1",
        name: "report.pdf",
        blobId: "blob-b1",
        type: "application/pdf",
      },
      { kind: "rmdir", id: "b", name: "Archive" },
    ]);
  });

  /*
   * A folder against a file, both ways round. Neither may be renamed, destroyed
   * or put beside the other, and the plan is what says so before anything is
   * written.
   */
  it("refuses a name that is a folder on one side and a file on the other", async () => {
    const folderInSource = await planMerge(
      tree(dir("b", "Archive", null), [dir("b1", "report", "b")]).t,
      tree(dir("a", "Work", null), [file("a1", "report", "a")]).t,
    );
    expect(folderInSource.steps).toEqual([]);
    expect(folderInSource.conflicts).toEqual([
      { path: ["Work", "report"], reason: "mixed" },
    ]);

    const folderInKept = await planMerge(
      tree(dir("b", "Archive", null), [file("b1", "report", "b")]).t,
      tree(dir("a", "Work", null), [dir("a1", "report", "a")]).t,
    );
    expect(folderInKept.steps).toEqual([]);
    expect(folderInKept.conflicts).toEqual([
      { path: ["Work", "report"], reason: "mixed" },
    ]);
  });

  /*
   * One collision is enough: the plan is refused as a whole rather than begun
   * and abandoned, so the reader never has half of a folder moved.
   */
  it("plans no steps at all when anything collides", async () => {
    const src = tree(dir("b", "Archive", null), [
      file("b1", "fine.txt", "b"),
      dir("b2", "clash", "b"),
    ]);
    const dst = tree(dir("a", "Work", null), [file("a1", "clash", "a")]);

    const { steps, conflicts } = await planMerge(src.t, dst.t);

    expect(steps).toEqual([]);
    expect(conflicts).toHaveLength(1);
  });

  it("reports every collision, not only the first", async () => {
    const src = tree(dir("b", "Archive", null), [
      dir("b1", "one", "b"),
      dir("b2", "two", "b"),
    ]);
    const dst = tree(dir("a", "Work", null), [
      file("a1", "one", "a"),
      file("a2", "two", "a"),
    ]);

    const { conflicts } = await planMerge(src.t, dst.t);

    expect(conflicts.map((c) => c.path)).toEqual([
      ["Work", "one"],
      ["Work", "two"],
    ]);
  });

  /*
   * A file with no content of its own — a symlink, which is not a folder and
   * carries no bytes — has nothing to write over the file of its name. Copying
   * is impossible and dropping it would lose a node, so it collides.
   */
  it("refuses a file that carries no content", async () => {
    const src = tree(dir("b", "Archive", null), [
      { id: "b1", name: "link", parentId: "b", nodeType: "symlink", blobId: null },
    ]);
    const dst = tree(dir("a", "Work", null), [file("a1", "link", "a")]);

    const { steps, conflicts } = await planMerge(src.t, dst.t);

    expect(steps).toEqual([]);
    expect(conflicts).toEqual([{ path: ["Work", "link"], reason: "no-bytes" }]);
  });

  /*
   * Rights, read before anything is planned. Each one is the right the step it
   * guards would need: destroying the folder given up, destroying a folder the
   * merge emptied, writing into a file, moving into a folder.
   */
  describe("rights the reader does not hold", () => {
    it("refuses when the folder given up may not be destroyed", async () => {
      const root = { ...dir("b", "Archive", null), myRights: { mayDelete: false } };
      const { steps, conflicts } = await planMerge(
        tree(root, [file("b1", "notes.txt", "b")]).t,
        tree(dir("a", "Work", null), []).t,
      );
      expect(steps).toEqual([]);
      expect(conflicts).toEqual([{ path: ["Archive"], reason: "no-right" }]);
    });

    it("refuses a folder it may not empty", async () => {
      const src = tree(dir("b", "Archive", null), [
        { ...dir("b1", "Clients", "b"), myRights: { mayDelete: false } },
      ]);
      const dst = tree(dir("a", "Work", null), [dir("a1", "Clients", "a")]);

      const { steps, conflicts } = await planMerge(src.t, dst.t);

      expect(steps).toEqual([]);
      expect(conflicts).toEqual([{ path: ["Work", "Clients"], reason: "no-right" }]);
    });

    it("refuses a file it may not write into", async () => {
      const src = tree(dir("b", "Archive", null), [file("b1", "report.pdf", "b")]);
      const dst = tree(dir("a", "Work", null), [
        { ...file("a1", "report.pdf", "a"), myRights: { mayModifyContent: false } },
      ]);

      const { steps, conflicts } = await planMerge(src.t, dst.t);

      expect(steps).toEqual([]);
      expect(conflicts).toEqual([{ path: ["Work", "report.pdf"], reason: "no-right" }]);
    });

    it("refuses a folder that takes no children", async () => {
      const src = tree(dir("b", "Archive", null), [
        dir("b1", "Closed", "b"),
        file("b2", "in.txt", "b1"),
      ]);
      const dst = tree(dir("a", "Work", null), [
        { ...dir("a1", "Closed", "a"), myRights: { mayAddChildren: false } },
      ]);

      const { steps, conflicts } = await planMerge(src.t, dst.t);

      expect(steps).toEqual([]);
      expect(conflicts).toEqual([{ path: ["Work", "Closed"], reason: "no-right" }]);
    });

    /*
     * Rights that are simply not known are not a refusal: the scan reads them
     * for everything the listing and the levels hold, and a node without them is
     * left to the server rather than hidden behind a guess.
     */
    it("plans the merge when no rights were read at all", async () => {
      const bare = (n: MergeNode): MergeNode => ({ ...n, myRights: undefined });
      const src = tree(bare(dir("b", "Archive", null)), [bare(file("b1", "x.txt", "b"))]);
      const dst = tree(bare(dir("a", "Work", null)), []);

      const { steps, conflicts } = await planMerge(src.t, dst.t);

      expect(conflicts).toEqual([]);
      expect(kinds(steps)).toEqual(["move", "rmdir"]);
    });
  });
});

describe("mergeBlockedMessage", () => {
  it("names the collision and counts the ones behind it", () => {
    expect(mergeBlockedMessage([{ path: ["Work", "report"], reason: "mixed" }])).toBe(
      "“Work/report” is a folder in one of the two and a file in the other, so neither can be merged into the other.",
    );
  });

  it("says how many more there are", () => {
    const one = [
      { path: ["Work", "one"], reason: "mixed" as const },
      { path: ["Work", "two"], reason: "no-bytes" as const },
    ];
    expect(mergeBlockedMessage(one)).toMatch(/One more collision stops it too\.$/);
    expect(
      mergeBlockedMessage([
        ...one,
        { path: ["Work", "three"], reason: "no-right" as const },
      ]),
    ).toMatch(/2 more collisions stop it too\.$/);
  });

  it("names the place as the folders down to the node", () => {
    expect(conflictPath({ path: ["Work", "Clients", "eu.pdf"], reason: "mixed" })).toBe(
      "Work/Clients/eu.pdf",
    );
  });
});
