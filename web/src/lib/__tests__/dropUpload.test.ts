import { describe, expect, it } from "vitest";
import { folderPathKey, foldersNeeded, hasDirectory, planUpload } from "@/lib/dropUpload";

/**
 * Dropping a folder in, reduced to the two things the DataTransfer entry API
 * gets wrong if you take it at face value.
 *
 * `readEntries` answers with *up to* some number of entries and signals the end
 * of a directory with an empty array, so a single call quietly loses everything
 * past the first batch — a real folder of a few hundred files would upload the
 * first hundred and look like it had finished. And a directory tree that cycles
 * has to stop somewhere the tab is still alive.
 *
 * The third thing is the folders themselves. A plan is files *and* directories,
 * because dropping a folder is a statement about the tree: a folder that holds
 * nothing is still a folder the reader meant to copy, and a plan derived from
 * the files alone would silently drop it.
 */

const file = (name: string) => new File([name], name);

/** A directory whose contents arrive a batch at a time, as a real one does. */
const dir = (name: string, children: unknown[], batch = 2) => {
  let at = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (cb: (e: never[]) => void) => {
        const slice = children.slice(at, at + batch);
        at += slice.length;
        cb(slice as never[]);
      },
    }),
  };
};

const leaf = (name: string) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (cb: (f: File) => void) => cb(file(name)),
});

describe("walking a dropped folder", () => {
  it("reads a directory across as many batches as it takes", async () => {
    // Five children, two per readEntries call: a single read would find two.
    const plan = await planUpload([
      dir("docs", ["a", "b", "c", "d", "e"].map(leaf)),
    ] as never[]);
    expect(plan.files.map((p) => p.file.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(plan.files.every((p) => p.path.join("/") === "docs")).toBe(true);
  });

  it("keeps the folder each file came from", async () => {
    const plan = await planUpload([
      dir("outer", [leaf("top"), dir("inner", [leaf("deep")])]),
    ] as never[]);
    expect(plan.files.map((p) => [p.path.join("/"), p.file.name])).toEqual([
      ["outer", "top"],
      ["outer/inner", "deep"],
    ]);
  });

  it("puts a loose file at the drop itself, and asks for no folder", async () => {
    const plan = await planUpload([leaf("loose")] as never[]);
    expect(plan.files).toEqual([expect.objectContaining({ path: [] })]);
    expect(plan.dirs).toEqual([]);
  });

  it("carries the folders themselves, an empty one included", async () => {
    const plan = await planUpload([
      dir("outer", [dir("empty", []), dir("inner", [leaf("deep")])]),
    ] as never[]);
    expect(plan.dirs.map((d) => d.join("/"))).toEqual([
      "outer",
      "outer/empty",
      "outer/inner",
    ]);
    expect(plan.files.map((p) => p.file.name)).toEqual(["deep"]);
  });

  it("stops rather than following a cycle for ever", async () => {
    const loop: Record<string, unknown> = {};
    Object.assign(loop, dir("loop", []));
    (loop as { createReader: () => unknown }).createReader = () => ({
      readEntries: (cb: (e: unknown[]) => void) => cb([loop]),
    });
    // Terminating at all is the assertion; the caps decide where. Both are set
    // low so the test does not have to read twenty thousand phantom entries.
    const plan = await planUpload([loop] as never[], { maxDepth: 4, maxEntries: 50 });
    expect(plan.files).toEqual([]);
    // Each folder it did enter is still a folder to make, and the depth cap is
    // what ends the walk: four levels entered, the fifth refused.
    expect(plan.dirs.map((d) => d.length)).toEqual([1, 2, 3, 4]);
  });
});

describe("the folders a plan needs", () => {
  it("lists parents before their children", () => {
    const needed = foldersNeeded({
      files: [
        { file: file("x"), path: ["a", "b", "c"] },
        { file: file("y"), path: ["a"] },
      ],
      dirs: [],
    });
    expect(needed).toEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
  });

  it("names each folder once, however many files are in it", () => {
    const needed = foldersNeeded({
      files: [
        { file: file("x"), path: ["a"] },
        { file: file("y"), path: ["a"] },
      ],
      dirs: [["a"]],
    });
    expect(needed).toEqual([["a"]]);
  });

  it("asks for a folder the drop carried even when nothing is in it", () => {
    expect(foldersNeeded({ files: [], dirs: [["empty"], ["a", "b"]] })).toEqual([
      ["empty"],
      ["a"],
      ["a", "b"],
    ]);
  });

  it("asks for nothing when everything lands at the drop", () => {
    expect(foldersNeeded({ files: [{ file: file("x"), path: [] }], dirs: [] })).toEqual(
      [],
    );
  });

  it("does not collide a top-level folder with a nested one of the same joined name", () => {
    // The folder key is a "/"-join, not a plain space-join: a space-join makes
    // a top-level folder literally named "Documents 2024" and a nested
    // "Documents/2024" the identical key, so one is silently treated as the
    // other and files dropped for one are misfiled into it.
    const flat = ["Documents 2024"];
    const nested = ["Documents", "2024"];
    expect(folderPathKey(flat)).not.toEqual(folderPathKey(nested));

    const needed = foldersNeeded({
      files: [
        { file: file("flat.txt"), path: flat },
        { file: file("nested.txt"), path: nested },
      ],
      dirs: [],
    });
    // Both nestings are asked for, as the two distinct folders they are — a
    // space-joined key would collapse them into one.
    expect(needed).toContainEqual(flat);
    expect(needed).toContainEqual(["Documents"]);
    expect(needed).toContainEqual(nested);
  });
});

describe("spotting a folder in the drop", () => {
  it("is true when any entry is a directory", () => {
    expect(hasDirectory([leaf("a"), dir("d", [])] as never[])).toBe(true);
    expect(hasDirectory([leaf("a")] as never[])).toBe(false);
  });
});
