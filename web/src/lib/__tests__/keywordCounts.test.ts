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
      keywords: { $seen: false } as never,
      keyword: "work",
      on: true,
    });
    expect(next.work).toEqual(C(5, 2));
  });

  it("raises only the total when the message was already read", () => {
    const next = keywordCountDelta({
      counts: counts({ work: C(4, 1) }),
      keywords: { [SEEN_KEYWORD]: true },
      keyword: "work",
      on: true,
    });
    expect(next.work).toEqual(C(5, 1));
  });

  it("lowers both when a label is removed from an unread message", () => {
    const next = keywordCountDelta({
      counts: counts({ work: C(4, 2) }),
      keywords: { work: true },
      keyword: "work",
      on: false,
    });
    expect(next.work).toEqual(C(3, 1));
  });

  it("moves the starred count the same way, because a star is the same kind of keyword", () => {
    const removed = keywordCountDelta({
      counts: counts({ [STARRED_KEYWORD]: C(7, 3) }),
      keywords: { [STARRED_KEYWORD]: true, [SEEN_KEYWORD]: true },
      keyword: STARRED_KEYWORD,
      on: false,
    });
    expect(removed[STARRED_KEYWORD]).toEqual(C(6, 3));
  });

  it("moves nothing when the write does not change the keyword", () => {
    const before = counts({ work: C(4, 1) });
    expect(
      keywordCountDelta({
        counts: before,
        keywords: { work: true },
        keyword: "work",
        on: true,
      }),
    ).toBe(before);
  });

  it("moves nothing for a keyword nobody is counting", () => {
    const before = counts({ work: C(4, 1) });
    expect(
      keywordCountDelta({
        counts: before,
        keywords: {},
        keyword: "unwatched",
        on: true,
      }),
    ).toBe(before);
  });

  it("never goes below zero", () => {
    const next = keywordCountDelta({
      counts: counts({ work: C(0, 0) }),
      keywords: { [SEEN_KEYWORD]: true },
      keyword: "work",
      on: false,
    });
    expect(next.work).toEqual(C(0, 0));
  });

  describe("marking a message read or unread", () => {
    it("moves no total, and the unread half of every keyword it carries", () => {
      const next = keywordCountDelta({
        counts: counts({ work: C(9, 4), home: C(2, 2), other: C(1, 1) }),
        keywords: { work: true, home: true },
        keyword: SEEN_KEYWORD,
        on: true,
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
        // Read, and now being marked unread: a real transition, unlike asking
        // for unread on a message that already was.
        keywords: { work: true, [SEEN_KEYWORD]: true },
        keyword: SEEN_KEYWORD,
        on: false,
      });
      expect(next.work).toEqual(C(9, 4));
    });

    it("moves nothing when the message already had that state", () => {
      // Marking unread a message that was never read is not two unread.
      const before = counts({ work: C(9, 3) });
      expect(
        keywordCountDelta({
          counts: before,
          keywords: { work: true },
          keyword: SEEN_KEYWORD,
          on: false,
        }),
      ).toBe(before);
    });
  });
});
