import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { ChangesResponse } from "@/jmap/types";
import * as appFolder from "@/lib/appFolder";
import type { ChatMessage } from "@/lib/chat";
import { type ChatConversation, useChat } from "@/store/chat";
import { useSession } from "@/store/session";
import { flushMicrotasks as flush } from "@/test/testkit";

/**
 * The live re-sync of an open conversation.
 *
 * ADR 0005's retirement path is an administrator clearing the group's chat
 * folders through Files; what arrives at a running session is FileNode
 * changes, in three lists. Only `created` was read, so a destroyed message
 * stayed on screen for ever, and a marker or a reply that named one fell into
 * `unreadCount`'s `at < 0` branch -- read as nothing unread, with nothing on
 * screen to explain it. An `updated` node is a message document rewritten
 * under us, which the held copy cannot show either.
 */

const message = (id: string, created: string): ChatMessage => ({
  v: 1,
  from: "me@example.org",
  at: created,
  text: `text of ${id}`,
  id,
  created,
});

const M1 = message("m1", "2026-01-01T09:00:00Z");
const M2 = message("m2", "2026-01-02T09:00:00Z");

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

/** The conversation as a loaded session holds it. */
function seed(over: Partial<ChatConversation>): void {
  useChat.setState({
    conversations: {
      gg: {
        accountId: "gg",
        name: "team@example.org",
        folders: { chat: "ch", state: "st" },
        nodes: [M1, M2],
        stateToken: "s1",
        loading: false,
        loaded: true,
        error: null,
        marker: { id: "mk1", lastRead: "m1" },
        draft: "",
        replyTo: null,
        sending: false,
        earliestPos: 0,
        pagingMore: false,
        reachedStart: true,
        ...over,
      },
    },
    openAccountId: null,
  });
}

let next: ChangesResponse = changes({});
/** Transcript reads, so a re-read the store asked for is visible. */
let reads = 0;

beforeEach(() => {
  reads = 0;
  next = changes({});
  vi.restoreAllMocks();
  vi.spyOn(client, "call").mockImplementation(async (method, args) => {
    if (method === "FileNode/changes") return next as never;
    return { accountId: args.accountId, state: "s2", list: [], notFound: [] } as never;
  });
  vi.spyOn(client, "chain").mockImplementation(async () => {
    reads += 1;
    return new Map<string, Record<string, unknown>[]>([
      ["q", [{ accountId: "gg", ids: [], total: 0 }]],
      ["g", [{ accountId: "gg", state: "s2", list: [], notFound: [] }]],
    ]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useChat.setState({ conversations: {}, openAccountId: null });
  useSession.setState({ status: "loading", session: null, accountId: null });
});

describe("a destroyed message", () => {
  it("is taken off the transcript instead of staying on screen", async () => {
    seed({ marker: { id: "mk1", lastRead: "m1" }, replyTo: "m1" });
    next = changes({ destroyed: ["m2"] });

    await useChat.getState().applyChanges("gg");
    const conv = useChat.getState().conversations.gg!;
    expect(conv.nodes.map((n) => n.id)).toEqual(["m1"]);
    expect(conv.stateToken).toBe("s2");
    // Nothing named a destroyed node, so the transcript was patched, not re-read.
    expect(reads).toBe(0);
  });
});

describe("a marker or a reply that names a destroyed node", () => {
  it("goes, and the transcript is re-read", async () => {
    seed({ marker: { id: "mk1", lastRead: "m2" }, replyTo: "m2" });
    next = changes({ destroyed: ["m2"] });

    await useChat.getState().applyChanges("gg");
    await flush();
    const conv = useChat.getState().conversations.gg!;
    expect(conv.marker).toBeNull();
    expect(conv.replyTo).toBeNull();
    expect(reads).toBeGreaterThan(0);
  });

  it("keeps a marker whose message is still there", async () => {
    seed({ marker: { id: "mk1", lastRead: "m1" }, replyTo: null });
    next = changes({ destroyed: ["m2"] });
    await useChat.getState().applyChanges("gg");
    await flush();
    expect(useChat.getState().conversations.gg?.marker).toEqual({
      id: "mk1",
      lastRead: "m1",
    });
  });
});

describe("a message document rewritten under the session", () => {
  it("re-reads the transcript rather than showing the held copy", async () => {
    seed({ marker: { id: "mk1", lastRead: "m1" }, replyTo: null });
    next = changes({ updated: ["m2"] });

    await useChat.getState().applyChanges("gg");
    await flush();
    expect(reads).toBeGreaterThan(0);
  });
});

describe("a message sent while a re-sync is in flight", () => {
  it("is not dropped when the sync writes its transcript back", async () => {
    /*
     * `applyChanges` reads the changes and then the arrived documents; a
     * `send()` can append to the transcript inside that window. The set that
     * lands the sync must rebase on what the conversation holds then, not
     * replace it with the snapshot the sync started from — a lost message is
     * invisible until the next poll.
     */
    seed({});
    next = changes({ created: ["m3"] });
    const local = message("local", "2026-01-03T09:00:00Z");
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method === "FileNode/changes") return next as never;
      if (method === "FileNode/get") {
        // A send lands while the arrived document is being fetched.
        useChat.setState((s) => ({
          conversations: {
            ...s.conversations,
            gg: {
              ...s.conversations.gg!,
              nodes: [...s.conversations.gg!.nodes, local],
            },
          },
        }));
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
              created: "2026-01-03T10:00:00Z",
            },
          ],
        } as never;
      }
      return { accountId: args.accountId, state: "s2", list: [], notFound: [] } as never;
    });
    vi.spyOn(client, "fetchBlobText").mockImplementation(async () =>
      JSON.stringify({
        v: 1,
        from: "ada@example.org",
        at: "2026-01-03T10:00:00Z",
        text: "hi",
      }),
    );

    await useChat.getState().applyChanges("gg");

    const ids = useChat.getState().conversations.gg!.nodes.map((n) => n.id);
    expect(ids).toContain("local");
    expect(ids).toContain("m3");
  });
});

describe("an older page fetched while a message arrives", () => {
  it("keeps the arrival instead of replacing the transcript with the page snapshot", async () => {
    seed({ nodes: [M2], earliestPos: 5, reachedStart: false });
    const local = message("local", "2026-01-05T09:00:00Z");
    vi.spyOn(appFolder, "listChildrenWithState").mockImplementation(async () => {
      // A live sync or a send appends while the older page is in flight.
      useChat.setState((s) => ({
        conversations: {
          ...s.conversations,
          gg: { ...s.conversations.gg!, nodes: [...s.conversations.gg!.nodes, local] },
        },
      }));
      return {
        list: [
          {
            id: "m0",
            parentId: "ch",
            nodeType: "file",
            blobId: "b0",
            created: "2025-12-30T09:00:00Z",
          },
        ],
        state: "s2",
        total: 6,
      } as never;
    });
    vi.spyOn(client, "fetchBlobText").mockImplementation(async () =>
      JSON.stringify({
        v: 1,
        from: "ada@example.org",
        at: "2025-12-30T09:00:00Z",
        text: "old",
      }),
    );

    await useChat.getState().loadOlder("gg");

    const ids = useChat.getState().conversations.gg!.nodes.map((n) => n.id);
    expect(ids).toContain("m0");
    expect(ids).toContain("local");
    expect(ids).toContain("m2");
  });
});

describe("an unreadable marker lookup", () => {
  it("is treated as an absent marker rather than failing the open", async () => {
    useSession.setState({
      status: "authenticated",
      session: {
        username: "me@example.org",
        capabilities: {},
        accounts: {},
        primaryAccounts: {},
        state: "s1",
      } as never,
      accountId: "gg",
    });
    seed({ marker: null });
    vi.spyOn(appFolder, "findInFolder").mockRejectedValue(new Error("blob unavailable"));

    // The lookup that finds the marker node rejects: that is "no marker we can
    // trust", the same as a document that does not parse, not a failed open.
    await expect(useChat.getState().ensureAccount("gg")).resolves.toBeUndefined();
  });
});

describe("the module state a session left behind", () => {
  it("forgets an in-flight sync, so a re-sync after reset is not skipped", async () => {
    seed({});
    let release: () => void = () => {};
    const held = new Promise<void>((res) => {
      release = res;
    });
    let changesCalls = 0;
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method === "FileNode/changes") {
        changesCalls += 1;
        await held;
        return changes({}) as never;
      }
      return { accountId: args.accountId, state: "s2", list: [], notFound: [] } as never;
    });

    const first = useChat.getState().applyChanges("gg");
    await flush();
    // The session ends while the sync is in flight.
    useChat.getState().reset();
    seed({});
    const second = useChat.getState().applyChanges("gg");
    await flush();

    // With the in-flight marker cleared, this is a real sync, not a skip.
    expect(changesCalls).toBe(2);
    release();
    await first;
    await second;
  });
});
