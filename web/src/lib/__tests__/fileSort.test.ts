import { describe, expect, it } from "vitest";
import type { FileNode } from "@/jmap/types";
import { sortFiles } from "@/lib/fileSort";
import { DEFAULT_FILES_SORT, type FilesSort } from "@/lib/lastPlace";

/**
 * The order a file listing is drawn in.
 *
 * Three properties carry the whole rule, and each of them is a decision rather
 * than a preference: **folders come first whatever the column**, the column
 * decides within each group, and **a tie on the column falls back to the name**
 * so two devices draw the same listing. The fixture below is deliberately in an
 * order that agrees with none of them, so a comparator that stopped applying one
 * of them would show it.
 */

/** Only the fields the comparator reads; the rest of a node is not its business. */
const node = (over: Partial<FileNode>): FileNode =>
  ({
    id: over.name ?? "x",
    parentId: null,
    nodeType: "file",
    blobId: "blob",
    size: 0,
    name: "x",
    type: "text/plain",
    created: "2026-01-01T00:00:00Z",
    modified: null,
    myRights: {},
    ...over,
  }) as unknown as FileNode;

const NODES: FileNode[] = [
  // Files out of alphabetical order, and one of them older than the rest.
  node({ name: "zeta.txt", size: 300, modified: "2026-03-01T00:00:00Z" }),
  // middle before Alpha, so a comparator that had no tie-break would leave the
  // two equal-sized files in that order and be caught by the case below.
  node({ name: "middle.txt", size: 100, modified: "2026-05-01T00:00:00Z" }),
  node({ name: "Alpha.txt", size: 100, modified: "2026-02-01T00:00:00Z" }),
  // Two folders, the newer one second, so "folders first" cannot be mistaken
  // for "in the order they arrived".
  node({
    name: "work",
    nodeType: "directory",
    size: null,
    modified: "2026-01-01T00:00:00Z",
  }),
  node({ name: "Archive", nodeType: "directory", modified: "2026-04-01T00:00:00Z" }),
];

const names = (sort: FilesSort) => sortFiles(NODES, sort).map((n) => n.name);
const asc = (key: FilesSort["key"]): FilesSort => ({ key, desc: false });
const desc = (key: FilesSort["key"]): FilesSort => ({ key, desc: true });

describe("the order a listing is drawn in", () => {
  it("is the default when nobody has sorted the folder", () => {
    // The order the server answers in, which is what a reader saw before a
    // column was clickable: folders first, then files, each by name.
    expect(DEFAULT_FILES_SORT).toEqual({ key: "name", desc: false });
    expect(names(DEFAULT_FILES_SORT)).toEqual([
      "Archive",
      "work",
      "Alpha.txt",
      "middle.txt",
      "zeta.txt",
    ]);
  });

  it("keeps folders first whatever the column, and reverses the name", () => {
    // Z–A inside each group, and the groups themselves do not move: a Size or
    // Modified sort that scattered folders through the files would be sorting
    // by a number a folder does not have.
    expect(names(desc("name"))).toEqual([
      "work",
      "Archive",
      "zeta.txt",
      "middle.txt",
      "Alpha.txt",
    ]);
    expect(names(asc("size"))).toEqual([
      "Archive",
      "work",
      "Alpha.txt",
      "middle.txt",
      "zeta.txt",
    ]);
  });

  it("orders by size, and by the date the node was last modified", () => {
    expect(names(desc("size"))).toEqual([
      "Archive",
      "work",
      "zeta.txt",
      "Alpha.txt",
      "middle.txt",
    ]);
    expect(names(asc("modified"))).toEqual([
      "work",
      "Archive",
      "Alpha.txt",
      "zeta.txt",
      "middle.txt",
    ]);
    expect(names(desc("modified"))).toEqual([
      "Archive",
      "work",
      "middle.txt",
      "zeta.txt",
      "Alpha.txt",
    ]);
  });

  it("falls back to the name when the column ties", () => {
    // Alpha and middle are both 100 bytes; without the fallback their order
    // would be whatever the array happened to hold.
    expect(names(asc("size")).slice(2)).toEqual(["Alpha.txt", "middle.txt", "zeta.txt"]);
    // And a node with no `modified` is ordered by when it was created rather
    // than dropped to one end for being null.
    const created = node({ name: "a.txt", size: 1, created: "2026-06-01T00:00:00Z" });
    const modified = node({ name: "b.txt", size: 1, modified: "2026-05-01T00:00:00Z" });
    expect(sortFiles([created, modified], desc("modified")).map((n) => n.name)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("sorts a copy, not the list it was handed", () => {
    const before = NODES.map((n) => n.name);
    sortFiles(NODES, desc("size"));
    expect(NODES.map((n) => n.name)).toEqual(before);
  });
});
