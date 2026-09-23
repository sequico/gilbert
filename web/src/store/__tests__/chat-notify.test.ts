import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { ChangesResponse } from "@/jmap/types";
import type { ChatMessage } from "@/lib/chat";
import { type ChatConversation, notifyNewChat, useChat } from "@/store/chat";
import { useSession } from "@/store/session";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { flushMicrotasks as flush } from "@/test/testkit";

/**
 * Chat tells the reader a message arrived, the way mail already does.
 *
 * Two switches mail honours are honoured here — the system notification and the
 * sound — and a message the reader wrote is never announced. The first three
 * tests pin the rules on the helper; the last drives the live re-sync and fails
 * when the store stops calling it.
 */

const message = (id: string, from: string, text: string): ChatMessage => ({
  v: 1,
  from,
  at: "2026-01-01T09:00:00Z",
  text,
  id,
  created: "2026-01-01T09:00:00Z",
});

let shown: Array<{ title: string; body?: string }>;

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async (): Promise<NotificationPermission> => "granted";
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    shown.push({ title, body: options?.body });
  }
  close() {}
}

beforeEach(() => {
  shown = [];
  vi.restoreAllMocks();
  vi.stubGlobal("Notification", FakeNotification as unknown as typeof Notification);
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      desktopNotifications: true,
      notificationSound: false,
    },
  });
  // `notifyNewChat` fails closed without the reader's own address, and the live
  // re-sync reads it from the session.
  useSession.setState({ session: { username: "me@example.org" } as never });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useChat.setState({ conversations: {}, openAccountId: null });
  useSession.setState({ session: null });
});

describe("notifyNewChat", () => {
  it("names the group and the sender for a message from somebody else", () => {
    notifyNewChat(
      "team@example.org",
      "gg",
      [message("m3", "ada@example.org", "hi")],
      "me@example.org",
    );
    expect(shown).toEqual([{ title: "team@example.org", body: "ada@example.org: hi" }]);
  });

  it("says nothing for the reader's own message", () => {
    notifyNewChat(
      "team@example.org",
      "gg",
      [message("m3", "me@example.org", "hi")],
      "me@example.org",
    );
    expect(shown).toEqual([]);
  });

  it("says nothing when desktop notifications are off", () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        desktopNotifications: false,
        notificationSound: false,
      },
    });
    notifyNewChat(
      "team@example.org",
      "gg",
      [message("m3", "ada@example.org", "hi")],
      "me@example.org",
    );
    expect(shown).toEqual([]);
  });
});

describe("the live re-sync", () => {
  const changes = (over: Partial<ChangesResponse>): ChangesResponse => ({
    accountId: "gg",
    oldState: "s1",
    newState: "s2",
    hasMoreChanges: false,
    created: [],
    updated: [],
    destroyed: [],
    ...over,
  });

  function seed(): void {
    const conv: ChatConversation = {
      accountId: "gg",
      name: "team@example.org",
      folders: { chat: "ch", state: "st" },
      nodes: [],
      stateToken: "s1",
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
    };
    useChat.setState({ conversations: { gg: conv }, openAccountId: null });
  }

  it("notifies for a message that arrived over a FileNode change", async () => {
    seed();
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method === "FileNode/changes") return changes({ created: ["m3"] }) as never;
      if (method === "FileNode/get")
        return {
          accountId: "gg",
          state: "s2",
          notFound: [],
          list: [
            {
              id: "m3",
              parentId: "ch",
              nodeType: "file",
              blobId: "b3",
              created: "2026-01-01T09:00:00Z",
            },
          ],
        } as never;
      return { accountId: args.accountId, state: "s2", list: [], notFound: [] } as never;
    });
    vi.spyOn(client, "fetchBlobText").mockImplementation(async () =>
      JSON.stringify({
        v: 1,
        from: "ada@example.org",
        at: "2026-01-01T09:00:00Z",
        text: "hi",
      }),
    );

    await useChat.getState().applyChanges("gg");
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.body).toBe("ada@example.org: hi");
  });
});
