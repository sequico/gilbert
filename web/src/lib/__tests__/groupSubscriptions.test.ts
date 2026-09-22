import { describe, expect, it } from "vitest";
import type { Mailbox } from "@/jmap/types";
import { unsubscribedFolders } from "@/lib/groupSubscriptions";

/**
 * What membership owes a member, as the list of folders to write.
 *
 * The answer is what the tree in hand says, not a diff against the server, and
 * that is the property the reconciler depends on: it is asked on every read of
 * a group's folder list, and a tree that arrived subscribed has nothing to
 * write.
 */

const box = (id: string, isSubscribed: boolean) =>
  ({ id, name: id, parentId: null, isSubscribed }) as Mailbox;

describe("the folders of a group a member is not subscribed to", () => {
  it("is every unsubscribed one, whatever its depth", () => {
    const tree = {
      a: box("a", false),
      l: box("l", true),
      t: box("t", false),
    };
    expect(unsubscribedFolders(tree).sort()).toEqual(["a", "t"]);
  });

  it("is nothing at all once they are subscribed", () => {
    expect(unsubscribedFolders({ a: box("a", true), b: box("b", true) })).toEqual([]);
  });

  it("is nothing for an empty tree", () => {
    expect(unsubscribedFolders({})).toEqual([]);
  });
});
