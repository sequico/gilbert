import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "@/jmap/types";
import { useFiles } from "@/store/files";
import { MoveDialog } from "../FilesView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Move dialog and the drop rule (finding 4).
 *
 * The dialog filtered its own destinations and the store checked nothing, so it
 * offered folders a drag would have refused. It now asks `canDropFileNodes`,
 * the one rule the drop path uses.
 */

const dir = (id: string, name: string, mayAddChildren: boolean): FileNode =>
  ({
    id,
    name,
    nodeType: "directory",
    parentId: null,
    myRights: { mayAddChildren },
  }) as unknown as FileNode;

const FILE = {
  id: "f",
  name: "f.txt",
  nodeType: "file",
  parentId: null,
  blobId: "b",
  type: "text/plain",
  myRights: { mayModifyContent: true },
} as unknown as FileNode;

describe("the Move dialog's destinations", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const moveButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Move here",
    );

  const folderButton = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) =>
      (b.textContent ?? "").includes(name),
    );

  it("offers only the folders the drop rule accepts", async () => {
    useFiles.setState({
      accountId: "own",
      ownAccountId: "own",
      children: { root: ["A", "B"] },
      nodes: {
        A: dir("A", "Folder A", true),
        B: dir("B", "Folder B", false),
        f: FILE,
      },
    });
    // After `setState`, which rebuilds the state object and would drop a spy
    // taken from the previous one.
    vi.spyOn(useFiles.getState(), "loadChildren").mockResolvedValue(undefined);

    await act(async () => {
      root.render(<MoveDialog nodes={[FILE]} onClose={() => {}} onMoved={() => {}} />);
    });
    // Folder B refuses children: it is not a destination.
    expect(folderButton("Folder A")).toBeTruthy();
    expect(folderButton("Folder B")).toBeFalsy();
  });

  it("keeps Move here dead until the chosen folder would take the move", async () => {
    useFiles.setState({
      accountId: "own",
      ownAccountId: "own",
      children: { root: ["A"], A: [] },
      nodes: { A: dir("A", "Folder A", true), f: FILE },
    });
    vi.spyOn(useFiles.getState(), "loadChildren").mockResolvedValue(undefined);

    await act(async () => {
      root.render(<MoveDialog nodes={[FILE]} onClose={() => {}} onMoved={() => {}} />);
    });

    // The file is already at the top level: "Move here" is a no-op.
    expect(moveButton()?.disabled).toBe(true);

    await act(async () => {
      folderButton("Folder A")!.click();
    });
    expect(moveButton()?.disabled).toBe(false);
  });
});
