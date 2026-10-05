import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { FileNode, JmapSession } from "@/jmap/types";
import { useFiles } from "@/store/files";
import { fakeJmapServer, type JmapFake } from "@/test/jmapServer";

/*
 * A FileNode push change (a folder created, renamed or deleted on another
 * device) reloaded the open folder listings but never the sidebar tree, so the
 * tree stayed wrong until a remount. These tests pin that a change reloads the
 * tree too — but only when a tree is actually on screen (`treeLoaded`).
 */

const NODE = (id: string, parentId: string | null = null) =>
  ({
    id,
    name: id,
    nodeType: "directory",
    parentId,
  }) as unknown as FileNode;

/** The `FileNode/query` calls the client made, as the arguments it sent. */
const queriesOf = (srv: JmapFake): Array<Record<string, unknown>> =>
  srv.callsTo("FileNode/query").map((call) => call.args);

beforeEach(() => {
  client.session = {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.filenode]: {},
    },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a FileNode push reloads the sidebar tree as well as the listings", () => {
  it("asks for the whole tree again when one is on screen", async () => {
    const srv = fakeJmapServer();
    useFiles.setState({
      accountId: "a1",
      ownAccountId: "a1",
      available: true,
      nodes: { d1: NODE("d1") },
      children: { root: ["d1"] },
      listingShown: null,
      loading: false,
      error: null,
      runs: [],
      dirIds: ["d1"],
      treeLoaded: true,
      draggingIds: [],
    });
    useFiles.getState().applyChanges(new Set(["FileNode"]));
    await vi.waitFor(() =>
      expect(
        queriesOf(srv).some(
          (q) =>
            (q.filter as { nodeType?: string } | undefined)?.nodeType === "directory",
        ),
      ).toBe(true),
    );
  });

  it("leaves a tree that is not on screen alone", async () => {
    const srv = fakeJmapServer();
    useFiles.setState({
      accountId: "a1",
      ownAccountId: "a1",
      available: true,
      nodes: {},
      children: {},
      listingShown: null,
      loading: false,
      error: null,
      runs: [],
      dirIds: [],
      treeLoaded: false,
      draggingIds: [],
    });
    useFiles.getState().applyChanges(new Set(["FileNode"]));
    // Nothing is open to reload and no tree is drawn; give any stray call a
    // chance to appear before asserting none did.
    await new Promise((r) => setTimeout(r, 0));
    expect(
      queriesOf(srv).some(
        (q) => (q.filter as { nodeType?: string } | undefined)?.nodeType === "directory",
      ),
    ).toBe(false);
  });

  it("re-reads the listing on screen, and only that one", async () => {
    /* A change arriving from elsewhere refreshes what is being looked at. Every
       folder the reader has ever opened is a different thing: that set grows
       with the session, and re-reading it cost a query and a get per folder per
       change. */
    const srv = fakeJmapServer();
    useFiles.setState({
      accountId: "a1",
      ownAccountId: "a1",
      available: true,
      nodes: { d1: NODE("d1"), d2: NODE("d2"), d3: NODE("d3") },
      children: { root: ["d1"], d2: ["d3"] },
      listingShown: { parentId: "d2" },
      loading: false,
      error: null,
      runs: [],
      dirIds: ["d1", "d2"],
      treeLoaded: false,
      draggingIds: [],
    });
    useFiles.getState().applyChanges(new Set(["FileNode"]));
    await vi.waitFor(() => expect(queriesOf(srv).length).toBeGreaterThan(0));
    const asked = queriesOf(srv).map(
      (q) => (q.filter as { parentId?: string }).parentId ?? "(top)",
    );
    expect(asked).toEqual(["d2"]);
  });
});
