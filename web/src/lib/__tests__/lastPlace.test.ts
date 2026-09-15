import { beforeEach, describe, expect, it } from "vitest";
import { loadPlace, rememberPlace } from "@/lib/lastPlace";
import { clearAllData, clearSignedInData, setDeviceTrusted } from "@/lib/storage";

/**
 * Where the reader was, for the next session on this device.
 *
 * One record per reader holds the place of every surface -- the mail account,
 * the book, the folder -- because they are one answer to one
 * question. It is written often and never synced, which is why it lives in the
 * device cache rather than in the account's settings file.
 */

describe("the record of where the reader was", () => {
  beforeEach(() => {
    setDeviceTrusted(true);
    localStorage.clear();
  });

  it("keeps one record and merges each surface into it", () => {
    rememberPlace("reader", { mailAccountId: "acc-2" });
    rememberPlace("reader", { book: { accountId: "acc-1", bookId: "book-7" } });
    rememberPlace("reader", { files: { accountId: "acc-1", parentId: "n-9" } });

    expect(loadPlace("reader")).toEqual({
      mailAccountId: "acc-2",
      book: { accountId: "acc-1", bookId: "book-7" },
      files: { accountId: "acc-1", parentId: "n-9" },
    });
  });

  it("does not let one reader's place reach another", () => {
    rememberPlace("reader", { book: { accountId: null, bookId: "book-1" } });
    expect(loadPlace("other")).toEqual({});
  });

  it("remembers nothing when there is no reader to remember it for", () => {
    rememberPlace(null, { mailAccountId: "acc-2" });
    expect(loadPlace(null)).toEqual({});
  });

  it("survives signing out, because a deploy signs everybody out", () => {
    rememberPlace("reader", { mailAccountId: "acc-2" });

    clearSignedInData();
    expect(loadPlace("reader").mailAccountId).toBe("acc-2");

    /* A device we do not trust keeps nothing at all, this record included. */
    clearAllData();
    expect(loadPlace("reader")).toEqual({});
  });
});
