// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { client, JmapMethodError } from "@/jmap/client";
import type { ChatConversation } from "@/store/chat";
import { useChat } from "@/store/chat";

/**
 * What a transcript does with a token the server no longer honours.
 *
 * `FileNode/changes` refuses a `sinceState` older than the change window with
 * `cannotCalculateChanges`. That is not a failure that heals: every later pass
 * asks from the same token and is refused for the same reason, so the group's
 * chat would stop syncing until a reload. The store answers with the wholesale
 * read it already takes when a pass overruns its guard.
 */

const ACCOUNT = "gg";

function conversation(over: Partial<ChatConversation> = {}): ChatConversation {
  return {
    accountId: ACCOUNT,
    name: "Group",
    folders: { chat: "f-chat", state: "f-state" } as ChatConversation["folders"],
    nodes: [],
    stateToken: "a-token-from-last-week",
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

afterEach(() => {
  vi.restoreAllMocks();
  useChat.setState({ conversations: {} });
});

describe("a transcript whose change window has passed", () => {
  it("re-reads the whole transcript instead of asking from the dead token again", async () => {
    useChat.setState({ conversations: { [ACCOUNT]: conversation() } });
    vi.spyOn(client, "call").mockRejectedValue(
      new JmapMethodError("FileNode/changes", {
        type: "cannotCalculateChanges",
        description: "The sinceState is too old",
      }),
    );
    const reload = vi
      .spyOn(useChat.getState(), "reload")
      .mockResolvedValue(undefined as never);

    await useChat.getState().applyChanges(ACCOUNT);

    expect(reload).toHaveBeenCalledWith(ACCOUNT);
  });

  it("asks again from the same token after any other failure", async () => {
    useChat.setState({ conversations: { [ACCOUNT]: conversation() } });
    vi.spyOn(client, "call").mockRejectedValue(new Error("the network dropped"));
    const reload = vi
      .spyOn(useChat.getState(), "reload")
      .mockResolvedValue(undefined as never);

    await useChat.getState().applyChanges(ACCOUNT);

    // The token is still the one it held: the next event or open retries it,
    // which is right for a failure that may heal.
    expect(reload).not.toHaveBeenCalled();
    expect(useChat.getState().conversations[ACCOUNT]?.stateToken).toBe(
      "a-token-from-last-week",
    );
  });
});
