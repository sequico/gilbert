import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { FileNode, JmapSession } from "@/jmap/types";
import { useFiles } from "@/store/files";
import { useMail } from "@/store/mail";
import { fakeJmapServer } from "@/test/jmapServer";
import { SaveToFilesDialog } from "../SaveToFilesDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A level longer than one page offers every folder it holds.
 *
 * The picker read the level with a single request of its own, so a folder past
 * the server's `/get` ceiling — the tail of the alphabet, a folder a reader
 * filed under just now — was simply not offered, with nothing on screen saying
 * one was missing. It reads the level through the Files store's own pager now,
 * and this is where the tail is pinned.
 */

const A = "a1";

const dirs = Array.from({ length: 5 }, (_, i) => ({
  id: `d${i}`,
  name: `dir${i}`,
  nodeType: "directory",
  parentId: null,
})) as unknown as FileNode[];

describe("the save-to-Files picker", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // Two per `/get`, so the five folders are three pages and the last two are
    // past the first.
    client.session = {
      capabilities: { [CAP.core]: { maxObjectsInGet: 2 }, [CAP.filenode]: {} },
      accounts: {},
      primaryAccounts: {},
      state: "s1",
    } as unknown as JmapSession;
    const srv = fakeJmapServer();
    let page: FileNode[] = [];
    srv.on("FileNode/query", (call) => {
      const { position = 0, limit } = call.args as {
        position?: number;
        limit?: number;
      };
      const ids = dirs
        .map((n) => n.id)
        .slice(position, limit === undefined ? undefined : position + limit);
      page = dirs.filter((n) => ids.includes(n.id));
      return { accountId: A, ids, total: dirs.length, queryState: "1" };
    });
    srv.on("FileNode/get", () => ({ accountId: A, list: page, state: "1" }));
    useFiles.setState({ accountId: A, ownAccountId: A });
    useMail.setState({ mailAccounts: [] });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  /** The folder rows on screen, in the order they are drawn. */
  const shown = () =>
    Array.from(document.querySelectorAll(".menu-item .grow")).map((e) => e.textContent);

  it("offers the folders past the first page", async () => {
    await act(async () => {
      root.render(
        <SaveToFilesDialog accountId={A} attachments={[]} onClose={() => {}} />,
      );
    });
    // Each page is one request, and the effect chains them: settle the queue
    // rather than one turn of it, or the assertion runs before the last page.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    expect(shown()).toEqual(["dir0", "dir1", "dir2", "dir3", "dir4"]);
  });
});
