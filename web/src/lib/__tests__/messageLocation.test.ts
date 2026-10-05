import { describe, expect, it } from "vitest";
import type { Mailbox } from "@/jmap/types";
import { messageFolders } from "@/lib/messageLocation";

const box = (id: string, name: string, over: Partial<Mailbox> = {}) =>
  ({
    id,
    name,
    parentId: null,
    role: null,
    sortOrder: 0,
    ...over,
  }) as unknown as Mailbox;

const tree = (list: Mailbox[]) =>
  Object.fromEntries(list.map((m) => [m.id, m])) as Record<string, Mailbox>;

const INBOX = box("inbox", "Inbox", { role: "inbox" });
const ARCHIVE = box("arch", "Archive", { role: "archive" });
const INVOICES = box("inv", "Invoices", { parentId: "arch" });

describe("messageFolders", () => {
  it("names every folder holding the message, as a full path", () => {
    const mailboxes = tree([INBOX, ARCHIVE, INVOICES]);
    expect(messageFolders({ mailboxIds: { inbox: true, inv: true } }, mailboxes)).toEqual(
      ["Archive / Invoices", "Inbox"],
    );
  });

  it("leaves out the folder the list is already showing", () => {
    const mailboxes = tree([INBOX, ARCHIVE]);
    expect(
      messageFolders({ mailboxIds: { inbox: true, arch: true } }, mailboxes, "inbox"),
    ).toEqual(["Archive"]);
  });

  it("says nothing when the message sits only in the listed folder", () => {
    const mailboxes = tree([INBOX, ARCHIVE]);
    expect(messageFolders({ mailboxIds: { inbox: true } }, mailboxes, "inbox")).toEqual(
      [],
    );
  });

  it("says nothing for a message in no folder at all", () => {
    expect(messageFolders({ mailboxIds: {} }, tree([INBOX]))).toEqual([]);
    expect(messageFolders({}, tree([INBOX]))).toEqual([]);
  });

  it("uses the localised name for a role folder, the way the pickers do", () => {
    const mailboxes = tree([box("tr", "Trash", { role: "trash" })]);
    // The role's own name, not the server's: mailboxDisplayName's rule.
    expect(messageFolders({ mailboxIds: { tr: true } }, mailboxes)).toEqual([
      "Deleted Items",
    ]);
  });

  it("skips an id the account's tree does not hold", () => {
    // A stale id from another account names no folder here, and inventing a
    // row for it would point the reader at something that is not there.
    expect(messageFolders({ mailboxIds: { gone: true } }, tree([INBOX]))).toEqual([]);
  });

  it("names a path once, even when two folders would render it the same", () => {
    const mailboxes = tree([
      box("a", "News"),
      box("b", "News"),
      box("c", "News", { parentId: "a" }),
    ]);
    expect(messageFolders({ mailboxIds: { a: true, b: true } }, mailboxes)).toEqual([
      "News",
    ]);
  });

  it("ignores a folder whose membership is false", () => {
    const mailboxes = tree([INBOX, ARCHIVE]);
    expect(
      messageFolders({ mailboxIds: { inbox: true, arch: false } }, mailboxes),
    ).toEqual(["Inbox"]);
  });

  it("answers in a stable order, whatever order the ids arrive in", () => {
    const mailboxes = tree([INBOX, ARCHIVE, INVOICES]);
    const one = messageFolders({ mailboxIds: { inv: true, inbox: true } }, mailboxes);
    const two = messageFolders({ mailboxIds: { inbox: true, inv: true } }, mailboxes);
    expect(one).toEqual(two);
    expect(one).toEqual(["Archive / Invoices", "Inbox"]);
  });
});
