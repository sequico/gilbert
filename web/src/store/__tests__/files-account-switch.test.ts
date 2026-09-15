import { describe, expect, it } from "vitest";
import { emptyForAccount } from "../files";

/**
 * Switching to an account somebody shared with you must not show an empty
 * folder tree.
 *
 * Clearing `nodes` and `children` and stopping there leaves `treeLoaded` true
 * from the previous account — the sidebar never asks the new one for its
 * folders — while `dirIds` still names the old account's folders, which do not
 * resolve against the cleared `nodes`. The result is a tree with nothing in it
 * and no error to explain it, in the one place a tree matters most: someone
 * else's files, where you have no idea what the shape should be.
 *
 * The test that matters is the last one. The defect is a field nobody
 * remembered rather than bad logic, and the only durable guard is asserting the
 * whole set rather than the fields we happen to think of today.
 */

describe("what a switch to another account keeps", () => {
  it("keeps nothing but the new account's own id", () => {
    expect(emptyForAccount("b")).toEqual({
      accountId: "b",
      nodes: {},
      children: {},
      dirIds: [],
      treeLoaded: false,
      draggingIds: [],
      error: null,
    });
  });

  it("asks the new account for its tree", () => {
    // The sidebar loads when `treeLoaded` is false. True here means an empty
    // tree for as long as the account stays selected.
    expect(emptyForAccount("b").treeLoaded).toBe(false);
  });

  it("carries no folder ids over from the account before it", () => {
    expect(emptyForAccount("b").dirIds).toEqual([]);
  });

  it("drops a drag that was in flight", () => {
    // Its id belongs to the other account and would name a different node here.
    expect(emptyForAccount("b").draggingIds).toEqual([]);
  });

  it("names every piece of per-account state", () => {
    // Add a per-account field to the store and forget it here, and this fails
    // rather than the field quietly following someone into another account.
    expect(Object.keys(emptyForAccount(null)).sort()).toEqual([
      "accountId",
      "children",
      "dirIds",
      "draggingIds",
      "error",
      "nodes",
      "treeLoaded",
    ]);
  });
});
