import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_CHANGE_WINDOW_MS, useKnowledge } from "@/store/knowledge";

/*
 * A group's chat, knowledge base and settings ride the same FileNode rail, and
 * the KB store is offered every change. Answering each one with a tree walk
 * would re-read the KB once per message, so the first change of a burst opens a
 * window and its close is the one re-list. This fails if the store reads on the
 * spot.
 */

const groupTier = {
  scope: "group" as const,
  accountId: "a3",
  group: "team@example.org",
  canApprove: false,
  articles: [],
};

beforeEach(() => {
  useKnowledge.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the KB's FileNode window", () => {
  it("reads nothing while a burst is still arriving, then reads once", async () => {
    let calls = 0;
    // The re-list fails without a server, which the store absorbs; what is
    // measured is that it was not asked for before the window closed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        throw new Error("no server in this test");
      }),
    );
    useKnowledge.setState({ tiers: [groupTier] });

    await useKnowledge.getState().applyChanges("a3");
    await useKnowledge.getState().applyChanges("a3");
    expect(calls).toBe(0);

    await vi.advanceTimersByTimeAsync(KNOWLEDGE_CHANGE_WINDOW_MS);
    expect(calls).toBeGreaterThan(0);
  });

  it("ignores an account it does not hold", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("no server in this test");
    });
    vi.stubGlobal("fetch", fetch);
    useKnowledge.setState({ tiers: [groupTier] });

    await useKnowledge.getState().applyChanges("other");
    await vi.advanceTimersByTimeAsync(KNOWLEDGE_CHANGE_WINDOW_MS);
    expect(fetch).not.toHaveBeenCalled();
  });
});
