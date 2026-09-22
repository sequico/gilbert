import { describe, expect, it } from "vitest";
import type { Id, Mailbox } from "@/jmap/types";
import { filedFolderOf } from "@/lib/archiveTarget";

/**
 * Where Archive puts a conversation: the folder it already lives in, or nowhere
 * (which the caller reads as "Archive itself").
 *
 * The story it exists for: a reply arrives, joins the thread, and the
 * conversation is back in the Inbox while the rest of it is still in the case
 * folder it was filed under. Archiving it must put it back there -- the reader
 * already decided where that conversation lives -- and only a conversation that
 * was never filed anywhere belongs in Archive.
 */

const box = (id: string, role: Mailbox["role"], parentId: string | null = null) =>
  ({ id, name: id, role, parentId }) as Mailbox;

const TREE: Record<Id, Mailbox> = {
  inbox: box("inbox", "inbox"),
  sent: box("sent", "sent"),
  drafts: box("drafts", "drafts"),
  junk: box("junk", "junk"),
  trash: box("trash", "trash"),
  archive: box("archive", "archive"),
  dated: box("dated", null, "archive"),
  case: box("case", null),
  project: box("project", null),
};

const message = (mailboxIds: Id[], receivedAt: string) => ({
  mailboxIds: Object.fromEntries(mailboxIds.map((id) => [id, true])),
  receivedAt,
});

describe("the folder a conversation is already filed in", () => {
  it("is the one holding the newest filed message", () => {
    expect(
      filedFolderOf(
        [
          message(["case"], "2026-09-14T10:00:00Z"),
          message(["inbox"], "2026-09-22T10:00:00Z"),
        ],
        TREE,
      ),
    ).toBe("case");
  });

  it("follows a conversation that was moved from one folder to another", () => {
    // Everything moved to the project; the one message left behind does not win.
    expect(
      filedFolderOf(
        [
          message(["case"], "2026-08-01T10:00:00Z"),
          message(["project"], "2026-09-01T10:00:00Z"),
          message(["project"], "2026-09-20T10:00:00Z"),
          message(["inbox"], "2026-09-22T10:00:00Z"),
        ],
        TREE,
      ),
    ).toBe("project");
  });

  it("is not the inbox, nor Sent, nor a folder mail waits in", () => {
    // A conversation that only ever arrived and was answered: nothing was filed.
    expect(
      filedFolderOf(
        [
          message(["inbox"], "2026-09-22T10:00:00Z"),
          message(["sent"], "2026-09-22T10:05:00Z"),
          message(["drafts"], "2026-09-22T10:06:00Z"),
          message(["junk", "trash"], "2026-09-22T10:07:00Z"),
        ],
        TREE,
      ),
    ).toBeNull();
  });

  it("counts Archive, and the dated folders under it", () => {
    expect(filedFolderOf([message(["archive"], "2026-09-01T10:00:00Z")], TREE)).toBe(
      "archive",
    );
    expect(filedFolderOf([message(["dated"], "2026-09-01T10:00:00Z")], TREE)).toBe(
      "dated",
    );
  });

  it("takes the folder of the message that is filed, not the one that is not", () => {
    // The reply that brought the conversation back is the newest of all, and it
    // is in no filing folder: it has nothing to say about where "there" is.
    expect(
      filedFolderOf(
        [
          message(["case"], "2026-01-01T10:00:00Z"),
          message(["inbox"], "2026-09-22T10:00:00Z"),
        ],
        TREE,
      ),
    ).toBe("case");
  });

  it("lets the folder holding most of the thread settle a tie", () => {
    // The newest filed message is in two folders at once (a filed conversation
    // that also carries a folder of its own): the thread's weight decides.
    expect(
      filedFolderOf(
        [
          message(["project"], "2026-09-01T10:00:00Z"),
          message(["project"], "2026-09-02T10:00:00Z"),
          message(["case", "project"], "2026-09-20T10:00:00Z"),
        ],
        TREE,
      ),
    ).toBe("project");
  });

  it("is null for a folder the account does not have", () => {
    // A mailbox nobody can name is not a destination: it would be a path into
    // a tree this session cannot see.
    expect(filedFolderOf([message(["gone"], "2026-09-01T10:00:00Z")], TREE)).toBeNull();
  });

  it("is null when there are no messages at all", () => {
    expect(filedFolderOf([], TREE)).toBeNull();
    expect(filedFolderOf([{ mailboxIds: {}, receivedAt: null }], TREE)).toBeNull();
  });
});
