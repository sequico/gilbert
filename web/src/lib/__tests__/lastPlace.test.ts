import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FILES_SORT,
  loadFilesSort,
  loadPlace,
  rememberFilesSort,
  rememberPlace,
} from "@/lib/lastPlace";
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

  it("keeps one order per folder, and only for the folder it was made in", () => {
    rememberFilesSort("reader", "acc-1/root", { key: "modified", desc: true });
    rememberFilesSort("reader", "acc-1/folder-9", { key: "size", desc: false });

    expect(loadFilesSort("reader", "acc-1/root")).toEqual({
      key: "modified",
      desc: true,
    });
    expect(loadFilesSort("reader", "acc-1/folder-9")).toEqual({
      key: "size",
      desc: false,
    });
    // A folder nobody has sorted, another account's folder, and no reader at
    // all: the order the server answers in, rather than no order.
    expect(loadFilesSort("reader", "acc-1/other")).toEqual(DEFAULT_FILES_SORT);
    expect(loadFilesSort("reader", "acc-2/root")).toEqual(DEFAULT_FILES_SORT);
    expect(loadFilesSort(null, "acc-1/root")).toEqual(DEFAULT_FILES_SORT);
  });

  it("reads a column it no longer knows as never sorted", () => {
    // The record is written by one build and read by the next.
    localStorage.setItem(
      "gilbert:reader:lastPlace",
      JSON.stringify({ filesSort: { "acc-1/root": { key: "colour", desc: "yes" } } }),
    );
    expect(loadFilesSort("reader", "acc-1/root")).toEqual(DEFAULT_FILES_SORT);
  });
});
