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
    expect(plan.map((p) => p.file.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(plan.every((p) => p.path.join("/") === "docs")).toBe(true);
  });

  it("keeps the folder each file came from", async () => {
    const plan = await planUpload([
      dir("outer", [leaf("top"), dir("inner", [leaf("deep")])]),
    ] as never[]);
    expect(plan.map((p) => [p.path.join("/"), p.file.name])).toEqual([
      ["outer", "top"],
      ["outer/inner", "deep"],
    ]);
  });

  it("puts a loose file at the drop itself", async () => {
    const plan = await planUpload([leaf("loose")] as never[]);
    expect(plan).toEqual([expect.objectContaining({ path: [] })]);
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
    expect(plan).toEqual([]);
  });
});

describe("the folders a plan needs", () => {
  it("lists parents before their children", () => {
    const needed = foldersNeeded([
      { file: file("x"), path: ["a", "b", "c"] },
      { file: file("y"), path: ["a"] },
    ]);
    expect(needed).toEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
  });

  it("names each folder once, however many files are in it", () => {
    const needed = foldersNeeded([
      { file: file("x"), path: ["a"] },
      { file: file("y"), path: ["a"] },
    ]);
    expect(needed).toEqual([["a"]]);
  });

  it("asks for nothing when everything lands at the drop", () => {
    expect(foldersNeeded([{ file: file("x"), path: [] }])).toEqual([]);
  });

  it("does not collide a top-level folder with a nested one of the same joined name", () => {
    // The folder key is a "/"-join, not a plain space-join: a space-join makes
    // a top-level folder literally named "Documents 2024" and a nested
    // "Documents/2024" the identical key, so one is silently treated as the
    // other and files dropped for one are misfiled into it.
    const flat = ["Documents 2024"];
    const nested = ["Documents", "2024"];
    expect(folderPathKey(flat)).not.toBe(folderPathKey(nested));

    const needed = foldersNeeded([
      { file: file("flat.txt"), path: flat },
      { file: file("nested.txt"), path: nested },
    ]);
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
