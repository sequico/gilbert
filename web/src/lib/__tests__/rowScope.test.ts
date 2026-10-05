import { describe, expect, it } from "vitest";
import type { Id } from "@/jmap/types";
import { SEEN_KEYWORD, STARRED_KEYWORD } from "@/lib/keywordCounts";
import { anyCarries, anyLacks, rowScope } from "@/lib/rowScope";

/**
 * What a row stands for, and what it therefore says.
 *
 * One row is a conversation or a message depending on the setting, and every
 * surface that shows or writes a row's state has to agree about which. The
 * defect this pins is a row that *showed* one thing and *did* another: the star
 * inside a conversation showed that message's state and wrote the whole
 * thread's, so one message could be starred by a control that starred three.
 */

const msg = (
  id: string,
  keywords: Record<string, boolean> = {},
  mailboxIds: Record<Id, boolean> = {},
) => ({ id, keywords, mailboxIds });

describe("rowScope", () => {
  it("keeps the messages in the folder the list is about", () => {
    const thread = [
      msg("a", {}, { inbox: true }),
      msg("b", {}, { archive: true }),
      msg("c", {}, { inbox: true }),
    ];
    expect(rowScope(thread, "inbox").map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("keeps the whole conversation when the list is not about a folder", () => {
    // A search, a label, a starred view: all of it is what those lists are.
    const thread = [msg("a", {}, { inbox: true }), msg("b", {}, { archive: true })];
    expect(rowScope(thread, null).map((m) => m.id)).toEqual(["a", "b"]);
    expect(rowScope(thread, undefined).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("falls back to the conversation rather than to nothing", () => {
    // Every message is elsewhere, yet the row is being looked at: an action
    // on it must still have something to act on.
    const thread = [msg("a", {}, { archive: true })];
    expect(rowScope(thread, "inbox").map((m) => m.id)).toEqual(["a"]);
  });
});

describe("what a row carrying a keyword says", () => {
  it("says it when any message does, which is the only answer one row can give", () => {
    const thread = [msg("a"), msg("b", { [STARRED_KEYWORD]: true })];
    expect(anyCarries(thread, STARRED_KEYWORD)).toBe(true);
  });

  it("says nothing when none does", () => {
    const thread = [msg("a"), msg("b")];
    expect(anyCarries(thread, STARRED_KEYWORD)).toBe(false);
  });

  it("reads unread the same way round", () => {
    // Unread is a keyword nobody carries, so it is the same rule seen from the
    // other side -- and it was written out twice, once per view.
    expect(anyLacks([msg("a", { [SEEN_KEYWORD]: true }), msg("b")], SEEN_KEYWORD)).toBe(
      true,
    );
    expect(
      anyLacks(
        [msg("a", { [SEEN_KEYWORD]: true }), msg("b", { [SEEN_KEYWORD]: true })],
        SEEN_KEYWORD,
      ),
    ).toBe(false);
  });

  it("is stable on an empty row", () => {
    expect(anyCarries([], STARRED_KEYWORD)).toBe(false);
    expect(anyLacks([], SEEN_KEYWORD)).toBe(false);
  });
});

/**
 * The rule that follows, stated once for both controls: the *direction* a
 * click takes is decided by what the row says, so a row showing a star can only
 * clear stars.
 */
describe("the direction a row's own state implies", () => {
  it("stars when the row shows none, and clears when it shows one", () => {
    const none = [msg("a"), msg("b")];
    const some = [msg("a"), msg("b", { [STARRED_KEYWORD]: true })];
    expect(!anyCarries(none, STARRED_KEYWORD)).toBe(true);
    expect(!anyCarries(some, STARRED_KEYWORD)).toBe(false);
  });

  it("is the same answer whether it is asked of one message or of three", () => {
    // The old keyboard path asked `every`, so one starred message in a
    // conversation made the row say "starred" and the key say "star them all".
    const one = [msg("a", { [STARRED_KEYWORD]: true }), msg("b")];
    const bySome = !anyCarries(one, STARRED_KEYWORD);
    expect(bySome).toBe(false);
  });
});
