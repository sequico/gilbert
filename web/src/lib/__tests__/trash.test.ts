import {
  isTrashFolder,
  isTrashPath,
  parseTrashDocument,
  uniqueName,
  withOrigins,
  withoutOrigins,
} from "@gilbert/shared/trash";
import { describe, expect, it } from "vitest";
import { mayEndFiles, trashFolderId, trashRefusal } from "@/lib/trash";

/**
 * The Trash's own rules, without a server: what the folder is, what a name
 * arriving twice becomes, what the origins document says, and who may end what
 * is in it (ADR 0013).
 *
 * Each case is one invariant the store and the surfaces rest on, and each fails
 * if the rule it names is removed rather than merely reporting that the code
 * ran.
 */

describe("the Trash folder", () => {
  it("is a top-level directory by its reserved name, and nothing else", () => {
    expect(isTrashFolder({ name: "Trash", parentId: null, nodeType: "directory" })).toBe(
      true,
    );
    expect(isTrashFolder({ name: "Trash", parentId: "p", nodeType: "directory" })).toBe(
      false,
    );
    expect(isTrashFolder({ name: "Trash", parentId: null, nodeType: "file" })).toBe(
      false,
    );
    expect(isTrashFolder({ name: "trash", parentId: null, nodeType: "directory" })).toBe(
      false,
    );
  });

  it("is found in the nodes a Files state already holds", () => {
    const nodes = {
      a: { id: "a", name: "Work", nodeType: "directory", parentId: null },
      b: { id: "b", name: "Trash", nodeType: "directory", parentId: null },
    };
    expect(trashFolderId({ nodes: nodes as never })).toBe("b");
    expect(trashFolderId({ nodes: { a: nodes.a } as never })).toBeNull();
  });

  it("is the first segment of a visible path, and only there", () => {
    expect(isTrashPath("Trash/report.pdf")).toBe(true);
    expect(isTrashPath("Trash")).toBe(true);
    expect(isTrashPath("Work/Trash/report.pdf")).toBe(false);
    expect(isTrashPath("Trashy/report.pdf")).toBe(false);
  });
});

describe("a name arriving in the trash", () => {
  it("keeps its own name when the trash is free", () => {
    expect(uniqueName(new Set(), "report.pdf")).toBe("report.pdf");
  });

  it("is numbered beside one it would collide with, extension and all", () => {
    const taken = new Set(["report.pdf", "report (2).pdf"]);
    expect(uniqueName(taken, "report.pdf")).toBe("report (3).pdf");
    expect(uniqueName(new Set(["Photos"]), "Photos")).toBe("Photos (2)");
    // A leading dot is a name, not an extension: `.gitignore (2)`.
    expect(uniqueName(new Set([".gitignore"]), ".gitignore")).toBe(".gitignore (2)");
  });
});

describe("the origins document", () => {
  const entry = (parentId: string | null, name = "report.pdf", as = name) => ({
    parentId,
    name,
    as,
  });

  it("keeps where a node came from and what it was called, and drops an entry with nothing to put back", () => {
    expect(parseTrashDocument({ origins: { a: entry("p") } })).toEqual({
      origins: { a: entry("p") },
    });
    expect(
      parseTrashDocument({
        origins: { b: { parentId: null, name: "Photos", as: "Photos (2)" } },
      }),
    ).toEqual({ origins: { b: { parentId: null, name: "Photos", as: "Photos (2)" } } });
    expect(
      parseTrashDocument({
        origins: {
          a: "p",
          b: { parentId: "p" },
          c: { parentId: null, name: "x" },
        },
      }),
    ).toEqual({ origins: { c: entry(null, "x") } });
    expect(parseTrashDocument("nonsense")).toEqual({ origins: {} });
    expect(parseTrashDocument(null)).toEqual({ origins: {} });
  });

  it("merges one entry at a time and forgets one at a time", () => {
    const held = { origins: { a: entry("p") } };
    expect(withOrigins(held, { b: entry(null, "Photos") }).origins).toEqual({
      a: entry("p"),
      b: entry(null, "Photos"),
    });
    expect(
      withoutOrigins(withOrigins(held, { b: entry(null, "Photos") }), ["a"]).origins,
    ).toEqual({ b: entry(null, "Photos") });
  });
});

describe("who may end what is in the trash", () => {
  const own = { accountId: "a1", ownAccountId: "a1", isAdmin: false };
  const group = { accountId: "g1", ownAccountId: "a1", isAdmin: false };
  const admin = { accountId: "g1", ownAccountId: "a1", isAdmin: true };
  const unknown = { accountId: "a1", ownAccountId: null, isAdmin: false };

  it("lets the reader empty and delete for good in their own files", () => {
    expect(mayEndFiles(own)).toBe(true);
    expect(trashRefusal(own, "empty")).toBeNull();
    expect(trashRefusal(own, "final")).toBeNull();
  });

  it("refuses a group's trash to a member, and names which entry it was", () => {
    expect(mayEndFiles(group)).toBe(false);
    expect(trashRefusal(group, "empty")).toBe("group_files_empty");
    expect(trashRefusal(group, "final")).toBe("group_files_final");
  });

  it("lets an installation administrator end either", () => {
    expect(mayEndFiles(admin)).toBe(true);
    expect(trashRefusal(admin, "empty")).toBeNull();
    expect(trashRefusal(admin, "final")).toBeNull();
  });

  it("refuses an account that is not provably the reader's own", () => {
    expect(mayEndFiles(unknown)).toBe(false);
    expect(mayEndFiles({ accountId: null, ownAccountId: null, isAdmin: false })).toBe(
      false,
    );
  });
});
