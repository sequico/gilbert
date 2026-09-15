import { describe, expect, it } from "vitest";
import type { Id, Mailbox } from "@/jmap/types";
import {
  canDropFolder,
  canMoveFolderTo,
  descendantIds,
  folderColor,
  movable,
} from "../folderMove";

const mb = (
  id: string,
  name: string,
  parentId: string | null,
  role: Mailbox["role"] = null,
): Mailbox => ({
  id,
  name,
  parentId,
  role,
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  isSubscribed: true,
  myRights: {} as Mailbox["myRights"],
});

const rights = (over: Partial<Mailbox["myRights"]> = {}) =>
  ({
    mayReadItems: true,
    mayAddItems: true,
    mayRename: true,
    mayCreateChild: true,
    ...over,
  }) as Mailbox["myRights"];

/**  root ── Work ── Clients ── EU
 *        └─ Archive (role)
 *        └─ Inbox   (role)                                          */
const tree: Record<Id, Mailbox> = Object.fromEntries(
  [
    mb("inbox", "Inbox", null, "inbox"),
    mb("arch", "Archive", null, "archive"),
    mb("work", "Work", null),
    mb("clients", "Clients", "work"),
    mb("eu", "EU", "clients"),
    mb("news", "Newsletters", null),
  ].map((m) => [m.id, m]),
);

describe("movable", () => {
  it("refuses folders the server gave a role", () => {
    expect(movable(tree.inbox!)).toBe(false);
    expect(movable(tree.arch!)).toBe(false);
    expect(movable(tree.work!)).toBe(true);
  });
});

describe("descendantIds", () => {
  it("finds the whole subtree, not just the children", () => {
    expect([...descendantIds(tree, "work")].sort()).toEqual(["clients", "eu"]);
    expect([...descendantIds(tree, "eu")]).toEqual([]);
  });
});

describe("canDropFolder", () => {
  it("allows a plain move into another folder", () => {
    expect(canDropFolder(tree, "news", "work")).toBe(true);
    expect(canDropFolder(tree, "eu", "news")).toBe(true);
  });

  it("allows a move into a role folder, which may hold subfolders", () => {
    expect(canDropFolder(tree, "news", "arch")).toBe(true);
  });

  it("refuses to move a folder into itself or its own subtree", () => {
    expect(canDropFolder(tree, "work", "work")).toBe(false);
    expect(canDropFolder(tree, "work", "clients")).toBe(false);
    expect(canDropFolder(tree, "work", "eu")).toBe(false); // grandchild, not just child
  });

  it("refuses a move to the parent it already has", () => {
    expect(canDropFolder(tree, "clients", "work")).toBe(false);
  });

  it("refuses to move a role folder anywhere", () => {
    expect(canDropFolder(tree, "inbox", "work")).toBe(false);
    expect(canDropFolder(tree, "arch", null)).toBe(false);
  });

  it("handles the root: allowed from a parent, refused when already there", () => {
    expect(canDropFolder(tree, "eu", null)).toBe(true);
    expect(canDropFolder(tree, "news", null)).toBe(false);
  });

  it("refuses a target that does not exist", () => {
    expect(canDropFolder(tree, "news", "gone")).toBe(false);
    expect(canDropFolder(tree, "gone", "work")).toBe(false);
  });
});

describe("canMoveFolderTo", () => {
  /*
   * The folder picker lists every folder at once, so it cannot let the server
   * refuse one drag: the rights a drop would discover have to be checked up
   * front. Reparenting is `mayRename` on the folder itself (RFC 8621) and
   * `mayCreateChild` on the destination.
   */
  const withRights = (over: Record<string, Partial<Mailbox["myRights"]>>) => {
    const out: Record<Id, Mailbox> = {};
    for (const [id, m] of Object.entries(tree)) {
      out[id] = { ...m, myRights: rights(over[id]) };
    }
    return out;
  };

  it("allows a legal destination when the rights are there", () => {
    const t = withRights({});
    expect(canMoveFolderTo(t, "news", "work")).toBe(true);
    expect(canMoveFolderTo(t, "eu", null)).toBe(true);
  });

  it("refuses the same destinations a drop refuses", () => {
    const t = withRights({});
    expect(canMoveFolderTo(t, "work", "work")).toBe(false);
    expect(canMoveFolderTo(t, "work", "eu")).toBe(false);
    expect(canMoveFolderTo(t, "clients", "work")).toBe(false);
    expect(canMoveFolderTo(t, "inbox", "work")).toBe(false);
  });

  it("refuses when the folder itself may not be renamed", () => {
    // Reparenting is folded into mayRename, so this is the right that matters.
    const t = withRights({ news: { mayRename: false } });
    expect(canMoveFolderTo(t, "news", "work")).toBe(false);
  });

  it("refuses a destination that may not take a child", () => {
    const t = withRights({ work: { mayCreateChild: false } });
    expect(canMoveFolderTo(t, "eu", "work")).toBe(false);
    // The root is not a folder and grants nothing, so a folder that may be
    // renamed may always go there -- `news` may not, because it is already at
    // the top level and that move would be a no-op.
    expect(canMoveFolderTo(t, "eu", null)).toBe(true);
    expect(canMoveFolderTo(t, "news", null)).toBe(false);
  });
});

describe("folderColor", () => {
  it("returns the colour chosen for that folder, and null for the rest", () => {
    const colors = { work: "#7c3aed" };
    expect(folderColor(colors, "work")).toBe("#7c3aed");
    expect(folderColor(colors, "news")).toBeNull();
    expect(folderColor({}, "work")).toBeNull();
  });

  it("is keyed by id, so a renamed folder keeps its colour", () => {
    // The id is stable across a rename; the name and path are not.
    expect(folderColor({ mb1: "#0f766e" }, "mb1")).toBe("#0f766e");
  });
});
