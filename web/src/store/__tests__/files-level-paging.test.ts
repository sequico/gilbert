import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { FileNode, JmapSession } from "@/jmap/types";
import { LEVEL_LIMIT, useFiles } from "@/store/files";
import { fakeJmapServer } from "@/test/jmapServer";

/**
 * A folder larger than one page is read whole.
 *
 * `FileNode/query` answers a page at a time, and the listing asked for exactly
 * one: a folder of two thousand entries drew the first thousand and said
 * nothing about the rest, so the tail of the alphabet was unreachable with no
 * sign that the listing had been cut. The read pages now, and the assertions
 * are on what ended up on screen and on the page boundaries asked for.
 */

const A = "a1";

const node = (i: number): FileNode =>
  ({
    id: `n${i}`,
    name: `f${i}`,
    nodeType: "file",
    parentId: null,
  }) as unknown as FileNode;

/** The level of this size: one full page plus a short one. */
const nodes = Array.from({ length: LEVEL_LIMIT + 500 }, (_, i) => node(i));

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

describe("a level larger than one page", () => {
  it("reads every page, not only the first", async () => {
    const srv = fakeJmapServer();
    // The query answers the page asked for; the get resolves the ids it named,
    // which is how the client reads a page back.
    let page: FileNode[] = [];
    srv.on("FileNode/query", (call) => {
      const { position = 0, limit } = call.args as {
        position?: number;
        limit?: number;
      };
      const ids = nodes.map((n) => n.id);
      const pageIds = ids.slice(
        position,
        limit === undefined ? undefined : position + limit,
      );
      page = pageIds.map((id) => nodes[Number(id.slice(1))]!);
      return { accountId: A, ids: pageIds, total: nodes.length, queryState: "1" };
    });
    srv.on("FileNode/get", () => ({ accountId: A, list: page, state: "1" }));

    useFiles.setState({
      accountId: A,
      ownAccountId: A,
      available: true,
      children: {},
      nodes: {},
      loading: false,
      error: null,
    });

    await useFiles.getState().loadChildren(null);

    const rows = useFiles.getState().children.root ?? [];
    expect(rows).toHaveLength(nodes.length);
    expect(rows[nodes.length - 1]).toBe(`n${nodes.length - 1}`);
    // The pages continued where the previous one stopped rather than asking the
    // same page again. The step is the module's ceiling narrowed to what this
    // server resolves in one `/get` (500 here, as the session advertises), which
    // is why the reads go 0/500/1000 and then one more for the empty tail.
    const queries = srv.callsTo("FileNode/query");
    expect(new Set(queries.map((c) => c.args.limit))).toEqual(new Set([500]));
    expect(queries.map((c) => c.args.position ?? 0)).toEqual([0, 500, 1000, 1500]);
  });
});
