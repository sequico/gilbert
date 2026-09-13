import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/chat";
import { type ChatConversation, unreadOf } from "@/store/chat";

/**
 * Business logic review finding: `unreadOf` always called `unreadCount` with
 * `fromStart` defaulted to `true`, which means "the page in hand is the whole
 * transcript". The transcript is explicitly paged (`CHAT_PAGE`), and
 * `unreadCount`'s own `fromStart` parameter exists precisely to distinguish
 * that case from "this is only a page, and the marker not being in it means
 * it is further back, not that everything is read". A member away longer
 * than one page's worth of messages was told there was nothing unread.
 */

const message = (id: string, at: string): ChatMessage => ({
  v: 1,
  from: "someone@example.org",
  at,
  text: `text of ${id}`,
  id,
  created: at,
});

function conversation(over: Partial<ChatConversation>): ChatConversation {
  return {
    accountId: "gg",
    name: "Group",
    folders: null,
    nodes: [],
    stateToken: null,
    loading: false,
    loaded: true,
    error: null,
    marker: null,
    draft: "",
    replyTo: null,
    sending: false,
    earliestPos: 0,
    pagingMore: false,
    reachedStart: true,
    ...over,
  };
}

const page = [
  message("m1", "2026-01-01T09:00:00Z"),
  message("m2", "2026-01-01T09:01:00Z"),
  message("m3", "2026-01-01T09:02:00Z"),
];

describe("unreadOf", () => {
  it("counts every held message unread when the marker is further back than the loaded page", () => {
    const conv = conversation({
      nodes: page,
      // The reader's marker points at a message from before this page — the
      // page holds up to 200 messages (`CHAT_PAGE`), and the marker sits
      // somewhere the client never fetched.
      marker: { id: "marker-node", lastRead: "an-old-message-not-in-this-page" },
      reachedStart: false,
    });
    expect(unreadOf(conv)).toBe(page.length);
  });

  it("counts zero unread when the whole transcript is held and the marker is missing from it", () => {
    const conv = conversation({
      nodes: page,
      marker: { id: "marker-node", lastRead: "a-message-that-was-deleted" },
      reachedStart: true,
    });
    expect(unreadOf(conv)).toBe(0);
  });

  it("counts from the marker's position when it is in the loaded page", () => {
    const conv = conversation({
      nodes: page,
      marker: { id: "marker-node", lastRead: "m1" },
      reachedStart: false,
    });
    expect(unreadOf(conv)).toBe(2);
  });
});
