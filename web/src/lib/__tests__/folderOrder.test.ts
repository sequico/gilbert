import { describe, expect, it } from "vitest";
import type { Id, Mailbox } from "@/jmap/types";
import { compareFolders, treeOrder } from "../folderOrder";

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

const of = (...list: Mailbox[]): Record<Id, Mailbox> =>
  Object.fromEntries(list.map((m) => [m.id, m]));

/** root ── Work ── Clients
 *        └─ Archive (role), Inbox (role)
 */
const tree = () =>
  of(
    mb("inbox", "Inbox", null, "inbox"),
    mb("archive", "Archive", null, "archive"),
    mb("work", "Work", null),
    mb("clients", "Clients", "work"),
  );

describe("the order folders are listed in", () => {
  it("puts Inbox first, and the rest by name however they are cased", () => {
    const boxes = of(
      mb("z", "zeta", null),
      mb("inbox", "Inbox", null, "inbox"),
      mb("upper", "B", null),
      mb("lower", "a", null),
    );
    // "a" before "B" is what `sensitivity: "base"` buys: a case-sensitive
    // comparison puts the capital first, whatever the language's collation.
    expect(treeOrder(boxes).map((m) => m.id)).toEqual(["inbox", "lower", "upper", "z"]);
  });

  it("reads numbers as numbers, so 2 comes before 10", () => {
    const boxes = of(mb("ten", "Folder 10", null), mb("two", "Folder 2", null));
    expect(treeOrder(boxes).map((m) => m.id)).toEqual(["two", "ten"]);
  });

  it("keeps every folder under its parent, siblings in order", () => {
    expect(treeOrder(tree()).map((m) => m.id)).toEqual([
      "inbox",
      "archive",
      "work",
      "clients",
    ]);
  });

  it("appends a folder the walk cannot reach rather than dropping it", () => {
    // A parent loop the server should not allow: neither folder is reachable
    // from the top, and both are still listed.
    const boxes = of(mb("a", "A", "b"), mb("b", "B", "a"));
    expect(treeOrder(boxes).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("treats a parent that is not in the map as the top level", () => {
    // The mailbox keeps its own `parentId` -- what the walk decides is which
    // level it is listed at, and a parent the map does not hold is the top.
    // The orphan is listed beside a real root rather than dropped or nested.
    const boxes = of(mb("child", "Child", "missing"), mb("zeta", "Zeta", null));
    expect(treeOrder(boxes).map((m) => m.id)).toEqual(["child", "zeta"]);
  });

  it("is the same rule the two lists compare with", () => {
    expect(
      compareFolders(mb("i", "Inbox", null, "inbox"), mb("a", "Alpha", null)),
    ).toBeLessThan(0);
    expect(compareFolders(mb("x", "X", null), mb("y", "y", null))).toBeLessThan(0);
  });
});
