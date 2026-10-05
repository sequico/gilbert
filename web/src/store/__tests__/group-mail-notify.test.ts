import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { flushMicrotasks as flush } from "@/test/testkit";

/**
 * A group's mail announces from the same store change the reader's own does.
 *
 * The closed client is woken by the delivery (ADR 0016); a reader who keeps
 * Gilbert open on a group must not go quiet. `applyAccountChanges` routes a
 * non-active account's change, refreshes its tree and announces what it
 * received -- and says nothing for a backlog the page never showed.
 */

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

const mailGet = (email: Record<string, unknown>) =>
  ({
    accountId: "gg",
    state: "s",
    notFound: [],
    list: [email],
  }) as never;

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
  useMail.setState({
    accountId: "a1",
    mailAccounts: [
      { accountId: "a1", name: "me@example.org", kind: "own" },
      { accountId: "gg", name: "team@example.org", kind: "group" },
    ],
    accountTrees: {
      gg: { "g-inbox": { id: "g-inbox", name: "Inbox", role: "inbox" } },
    },
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useMail.setState({ accountId: null, mailAccounts: [], accountTrees: {} } as never);
});

describe("a group's mail while a tab is open", () => {
  it("names the group and the sender for a delivery this page has not shown", async () => {
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method === "Email/query")
        return { accountId: args.accountId, ids: ["e9"] } as never;
      if (method === "Email/get")
        return mailGet({
          id: "e9",
          threadId: "t9",
          from: [{ email: "ada@example.org" }],
          subject: "Hi",
          preview: "there",
          receivedAt: "2999-01-01T00:00:00Z",
        });
      return { accountId: args.accountId, state: "s", notFound: [], list: [] } as never;
    });
    await useMail.getState().applyAccountChanges("gg", new Set(["Email"]));
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("ada@example.org · team@example.org");
  });

  it("says nothing for a backlog that predates this page", async () => {
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method === "Email/query")
        return { accountId: args.accountId, ids: ["e1"] } as never;
      if (method === "Email/get")
        return mailGet({
          id: "e1",
          threadId: "t1",
          from: [{ email: "ada@example.org" }],
          subject: "Old",
          preview: "",
          receivedAt: "2020-01-01T00:00:00Z",
        });
      return { accountId: args.accountId, state: "s", notFound: [], list: [] } as never;
    });
    await useMail.getState().applyAccountChanges("gg", new Set(["Email"]));
    await flush();
    expect(shown).toEqual([]);
  });

  it("ignores an account that is not one of the reader's mailboxes", async () => {
    const spy = vi.spyOn(client, "call").mockResolvedValue({ list: [] } as never);
    await useMail.getState().applyAccountChanges("zz", new Set(["Email"]));
    expect(spy).not.toHaveBeenCalled();
  });
});
