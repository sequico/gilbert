import { describe, expect, it, vi } from "vitest";

/**
 * One dialog, one sentence per action.
 *
 * Four surfaces ask before a delete and each used to carry its own copy of the
 * sentences, which is how the same action came to be described two ways ("{n}
 * message will be permanently deleted" in a folder list, "This permanently
 * deletes the folder and its {n} messages" in the sidebar beside it). These pin
 * the composition, and the plural forms a language with more than two of them
 * depends on.
 *
 * `confirmDialog` is mocked so the test reads what a reader *would* be shown —
 * the point is the sentence, not the dialog's own rendering, which
 * `dialog-focus.test.tsx` covers.
 */
const asked: Array<Record<string, unknown>> = [];
vi.mock("@/ui/dialog", () => ({
  confirmDialog: (opts: Record<string, unknown>) => {
    asked.push(opts);
    return Promise.resolve(true);
  },
}));

const { askDeleteFolder, askDeleteMessages, deletedMessages, trashedMessages } =
  await import("@/lib/deleteConfirm");

describe("the sentences a delete is confirmed with", () => {
  it("agrees in number, singular and plural", () => {
    expect(deletedMessages(1)).toBe("1 message will be permanently deleted.");
    expect(deletedMessages(2)).toBe("2 messages will be permanently deleted.");
    expect(trashedMessages(1)).toBe("Move 1 message to Trash?");
    expect(trashedMessages(3)).toBe("Move 3 messages to Trash?");
  });

  it("asks about a message differently by what the delete does to it", async () => {
    asked.length = 0;
    await askDeleteMessages({ count: 1, permanent: true });
    await askDeleteMessages({ count: 1, permanent: false });
    expect(asked[0]!.title).toBe("Delete forever?");
    expect(asked[0]!.danger).toBe(true);
    expect(asked[1]!.title).toBe("Delete?");
    expect(asked[1]!.danger).toBe(false);
  });

  it("names the folder and the mail that goes with it, once", async () => {
    asked.length = 0;
    await askDeleteFolder({ name: "Archive 2026", emails: 2 });
    expect(asked[0]!.title).toBe("Delete “Archive 2026”?");
    expect(asked[0]!.message).toBe(
      "This permanently deletes the folder and its 2 messages.",
    );
  });
});
