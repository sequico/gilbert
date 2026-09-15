import { describe, expect, it } from "vitest";
import {
  countedKeywords,
  countOf,
  type KeywordCounts,
  keywordCountDelta,
  SEEN_KEYWORD,
  STARRED_KEYWORD,
} from "@/lib/keywordCounts";

const counts = (over: Record<string, KeywordCounts> = {}) => ({ ...over });
const C = (total: number, unread: number): KeywordCounts => ({ total, unread });
/** One message's keywords, which is what the delta reads. */
const msg = (keywords: Record<string, boolean>) => ({ keywords });

describe("countedKeywords", () => {
  it("counts Starred first, then every label", () => {
    expect(
      countedKeywords([
        { keyword: "work", name: "Work", color: "#000" },
        { keyword: "home", name: "Home", color: "#111" },
      ]),
    ).toEqual([STARRED_KEYWORD, "work", "home"]);
  });

  it("counts Starred even with no labels at all", () => {
    expect(countedKeywords([])).toEqual([STARRED_KEYWORD]);
  });
});

describe("countOf", () => {
  it("answers zero for a keyword nobody counted", () => {
    expect(countOf({}, "work")).toEqual({ total: 0, unread: 0 });
  });

  it("hands back the same object for every miss, so a selector is stable", () => {
    expect(countOf({}, "work")).toBe(countOf({}, "other"));
  });
});

describe("keywordCountDelta", () => {
  it("raises a label's total by one and its unread half when the message was unread", () => {
    const next = keywordCountDelta({
      counts: counts({ work: C(4, 1) }),
      before: [msg({})],
      after: [msg({ work: true })],
    });
    expect(next.work).toEqual(C(5, 2));
  });

  it("raises only the total when the message was already read", () => {
    const next = keywordCountDelta({
      counts: counts({ work: C(4, 1) }),
      before: [msg({ [SEEN_KEYWORD]: true })],
      after: [msg({ work: true, [SEEN_KEYWORD]: true })],
    });
    expect(next.work).toEqual(C(5, 1));
  });

  it("lowers both when a label is removed from an unread message", () => {
    const next = keywordCountDelta({
      counts: counts({ work: C(4, 2) }),
      before: [msg({ work: true })],
      after: [msg({})],
    });
    expect(next.work).toEqual(C(3, 1));
  });

  it("moves the starred count the same way, because a star is the same kind of keyword", () => {
    const next = keywordCountDelta({
      counts: counts({ [STARRED_KEYWORD]: C(7, 3) }),
      before: [msg({ [STARRED_KEYWORD]: true, [SEEN_KEYWORD]: true })],
      after: [msg({ [SEEN_KEYWORD]: true })],
    });
    expect(next[STARRED_KEYWORD]).toEqual(C(6, 3));
  });

  it("moves nothing when the row came out of the write as it went in", () => {
    const before = counts({ work: C(4, 1) });
    // Re-starring a starred message, and marking read what was already read:
    // neither is two of anything, and neither is a new object to re-render on.
    const row = [msg({ work: true, [SEEN_KEYWORD]: true })];
    expect(keywordCountDelta({ counts: before, before: row, after: row })).toBe(before);
  });

  it("moves nothing for a keyword nobody is counting", () => {
    const before = counts({ work: C(4, 1) });
    expect(
      keywordCountDelta({
        counts: before,
        before: [msg({})],
        after: [msg({ unwatched: true })],
      }),
    ).toBe(before);
  });

  it("never goes below zero", () => {
    const next = keywordCountDelta({
      counts: counts({ work: C(0, 0) }),
      before: [msg({ work: true, [SEEN_KEYWORD]: true })],
      after: [msg({ [SEEN_KEYWORD]: true })],
    });
    expect(next.work).toEqual(C(0, 0));
  });

  describe("marking a message read or unread", () => {
    it("moves no total, and the unread half of every keyword it carries", () => {
      const next = keywordCountDelta({
        counts: counts({ work: C(9, 4), home: C(2, 2), other: C(1, 1) }),
        before: [msg({ work: true, home: true })],
        after: [msg({ work: true, home: true, [SEEN_KEYWORD]: true })],
      });
      // Reading files the message nowhere else.
      expect(next.work).toEqual(C(9, 3));
      expect(next.home).toEqual(C(2, 1));
      // A keyword this message does not carry is not moved by it.
      expect(next.other).toEqual(C(1, 1));
    });

    it("puts the unread half back when it is marked unread again", () => {
      const next = keywordCountDelta({
        counts: counts({ work: C(9, 3) }),
        before: [msg({ work: true, [SEEN_KEYWORD]: true })],
        after: [msg({ work: true })],
      });
      expect(next.work).toEqual(C(9, 4));
    });
  });

  /*
   * The row is the unit, and these are the cases counting per message got
   * wrong. The sidebar's numbers are asked per conversation
   * (`countsConversations`), so a write that reaches one message of a
   * conversation moves the number of the conversation and not one per message.
   */
  describe("a conversation, which is one row and one number", () => {
    it("moves the total by one for the conversation, not by its messages", () => {
      const next = keywordCountDelta({
        counts: counts({ [STARRED_KEYWORD]: C(2, 1) }),
        before: [msg({}), msg({}), msg({})],
        after: [
          msg({ [STARRED_KEYWORD]: true }),
          msg({ [STARRED_KEYWORD]: true }),
          msg({ [STARRED_KEYWORD]: true }),
        ],
      });
      expect(next[STARRED_KEYWORD]).toEqual(C(3, 2));
    });

    it("keeps the number when another message still carries the keyword", () => {
      const before = counts({ work: C(6, 2) });
      // What unstarring one message inside an open conversation does: the
      // conversation is still under the label, so the number does not move.
      const next = keywordCountDelta({
        counts: before,
        before: [msg({ work: true }), msg({ work: true })],
        after: [msg({}), msg({ work: true })],
      });
      expect(next).toBe(before);
    });

    it("moves the number when the last message carrying it loses it", () => {
      const next = keywordCountDelta({
        counts: counts({ work: C(6, 2) }),
        before: [msg({ work: true }), msg({})],
        after: [msg({}), msg({})],
      });
      expect(next.work).toEqual(C(5, 1));
    });

    it("counts the row unread for a keyword only when one message is both", () => {
      const before = counts({ work: C(6, 1) });
      // Read is where the two readings part: one message carries the label and
      // is read, another is unread without it, so the row was never in the
      // unread half and reading it takes nothing out.
      const next = keywordCountDelta({
        counts: before,
        before: [msg({ work: true, [SEEN_KEYWORD]: true }), msg({})],
        after: [msg({ work: true, [SEEN_KEYWORD]: true }), msg({ [SEEN_KEYWORD]: true })],
      });
      expect(next).toBe(before);
    });

    it("moves the row into the unread half when the write is what puts it there", () => {
      // The total does not move -- the conversation was already counted -- and
      // the unread half does, because the message that was unseen now carries
      // the keyword. One number, two halves, decided apart.
      const next = keywordCountDelta({
        counts: counts({ [STARRED_KEYWORD]: C(3, 1) }),
        before: [msg({ [STARRED_KEYWORD]: true, [SEEN_KEYWORD]: true }), msg({})],
        after: [
          msg({ [STARRED_KEYWORD]: true, [SEEN_KEYWORD]: true }),
          msg({ [STARRED_KEYWORD]: true }),
        ],
      });
      expect(next[STARRED_KEYWORD]).toEqual(C(3, 2));
    });
  });
});
