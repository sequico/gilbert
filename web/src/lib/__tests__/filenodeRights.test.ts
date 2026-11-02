// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FileNode } from "@/jmap/types";
import { nodeRights } from "@/lib/filenode";

/**
 * A file's rights are its folder's.
 *
 * Stalwart 1.0 answers `myRights` on directories only (`jmap/src/file/get.rs`,
 * v1.0.0): a file carries none, and a gate that reads the property straight off
 * the node disables itself on every file — which is what made rename, share and
 * edit unreachable while the folder they sat in was writable.
 */

const rights = (mayRename: boolean) => ({
  mayRead: true,
  mayAddChildren: mayRename,
  mayRename,
  mayDelete: mayRename,
  mayModifyContent: mayRename,
  mayShare: mayRename,
});

const node = (
  id: string,
  parentId: string | null,
  own?: ReturnType<typeof rights>,
): FileNode =>
  ({
    id,
    parentId,
    nodeType: own ? "directory" : "file",
    ...(own ? { myRights: own } : {}),
  }) as unknown as FileNode;

describe("the rights a node carries", () => {
  it("gives a file the rights of the folder it sits in", () => {
    const nodes = { d1: node("d1", null, rights(true)), f1: node("f1", "d1") };
    expect(nodeRights(nodes.f1!, nodes)?.mayRename).toBe(true);
  });

  it("walks up while a level carries none", () => {
    const nodes = {
      d1: node("d1", null, rights(true)),
      d2: node("d2", "d1"),
      f1: node("f1", "d2"),
    };
    expect(nodeRights(nodes.f1!, nodes)?.mayModifyContent).toBe(true);
  });

  it("keeps a folder's own answer rather than a parent's", () => {
    const nodes = {
      d1: node("d1", null, rights(true)),
      d2: node("d2", "d1", rights(false)),
    };
    expect(nodeRights(nodes.d2!, nodes)?.mayRename).toBe(false);
  });

  it("answers nothing at the root, where there is no folder to borrow from", () => {
    const nodes = { f1: node("f1", null) };
    expect(nodeRights(nodes.f1!, nodes)).toBeUndefined();
  });
});
