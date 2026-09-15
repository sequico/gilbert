import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Email, JmapSession } from "@/jmap/types";
import { countedKeywords, SEEN_KEYWORD, STARRED_KEYWORD } from "@/lib/keywordCounts";
import { useGroupLabels } from "@/store/groupLabels";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/**
 * The sidebar's numbers: what they are read from, and what moves them.
 *
 * Two things are under test and they are different questions.
 *
 * **What is asked of the server.** One request carrying both halves of every
 * keyword — the total, which the row shows, and the unread count, which decides
 * whether a label set to "while unread" is drawn at all. Starred is counted
 * with them, and it is not a label: the counted set comes from
 * `countedKeywords`, so what is counted and what the sidebar draws cannot
 * drift apart.
 *
 * **What moves without asking.** A write the reader just made has to move the
 * number at once. Unstarring a message and watching the Starred count stay
 * where it was is what this pins: `setKeyword` moves the counts optimistically,
 * through the same arithmetic the sidebar trusts.
 */

const SESSION = {
  capabilities: { [CAP.core]: {}, [CAP.mail]: {} },
  accounts: {
    a1: {
      name: "me@example.org",
      isPersonal: true,
      accountCapabilities: { [CAP.mail]: {} },
    },
  },
  primaryAccounts: { [CAP.mail]: "a1" },
  state: "s1",
} as unknown as JmapSession;

const email = (id: string, keywords: Record<string, boolean>): Email =>
  ({
    id,
    threadId: id,
    mailboxIds: { mb1: true },
    keywords,
    receivedAt: "2026-09-01T09:00:00Z",
  }) as unknown as Email;

/** A server that answers `Email/query` totals from a map keyed by filter shape. */
/**
 * A server that answers `Email/query` totals from a map keyed by filter shape.
 *
 * `queries` is handed the whole argument object of each query, for the tests
 * that are about how a query was *asked* rather than what it matched --
 * `collapseThreads` is a sibling of `filter`, not part of it.
 */
function stub(answers: (filter: unknown) => number, queries?: unknown[]) {
  const asked: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses = body.methodCalls.map(([name, args, id]) => {
        asked.push(args.filter);
        queries?.push(args);
        return [name, { accountId: args.accountId, total: answers(args.filter) }, id];
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ methodResponses, sessionState: "s1" }),
      } as Response;
    }),
  );
  return asked;
}

beforeEach(() => {
  client.session = SESSION;
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      labels: [{ keyword: "work", name: "Work", color: "#000" }],
    },
  });
  useMail.setState({
    accountId: "a1",
    ownAccountId: "a1",
    mailAccounts: [{ accountId: "a1", name: "me@example.org", kind: "own" }],
    mailboxes: { mb1: { id: "mb1", name: "Inbox" } as never },
    emails: {},
    labelCounts: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useMail.setState({ labelCounts: {}, emails: {} });
});

describe("reading the counts", () => {
  it("asks for the total and the unread half of every counted keyword, in one request", async () => {
    const asked = stub(() => 0);
    await useMail.getState().loadLabelCounts();
    // Starred plus the one label, two queries each.
    expect(asked).toHaveLength(
      countedKeywords([{ keyword: "work" } as never]).length * 2,
    );
    expect(asked).toContainEqual({ hasKeyword: STARRED_KEYWORD });
    expect(asked).toContainEqual({ hasKeyword: "work" });
    expect(asked).toContainEqual({
      operator: "AND",
      conditions: [{ hasKeyword: "work" }, { notKeyword: SEEN_KEYWORD }],
    });
  });

  it("records both halves under each keyword", async () => {
    // The total query carries no operator; the unread one is an AND.
    stub((filter) => ((filter as { operator?: string }).operator ? 2 : 7));
    await useMail.getState().loadLabelCounts();
    expect(useMail.getState().labelCounts.work).toEqual({ total: 7, unread: 2 });
    expect(useMail.getState().labelCounts[STARRED_KEYWORD]).toEqual({
      total: 7,
      unread: 2,
    });
  });

  it("counts Starred even when the account has no labels at all", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, labels: [] } });
    const asked = stub(() => 1);
    await useMail.getState().loadLabelCounts();
    expect(asked).toHaveLength(2);
    expect(useMail.getState().labelCounts[STARRED_KEYWORD]).toEqual({
      total: 1,
      unread: 1,
    });
  });

  it("leaves the numbers alone rather than failing the view when the read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await useMail.getState().loadLabelCounts();
    expect(useMail.getState().labelCounts).toEqual({});
  });
});

describe("a group mailbox's own labels", () => {
  /** The group in the foreground, with its catalog already read. */
  const onGroup = () => {
    useMail.setState({
      accountId: "g1",
      ownAccountId: "a1",
      mailAccounts: [
        { accountId: "a1", name: "me@example.org", kind: "own" },
        { accountId: "g1", name: "team@example.org", kind: "group" },
      ],
      mailboxes: { mb1: { id: "mb1", name: "Inbox" } as never },
      labelCounts: {},
    });
    useGroupLabels.setState({
      byAccount: {
        g1: [{ keyword: "freight", name: "Freight", color: "#111" } as never],
      },
    });
  };

  beforeEach(onGroup);
  afterEach(() => useGroupLabels.setState({ byAccount: {} }));

  it("counts the group's own catalog, not the reader's personal labels", async () => {
    const asked = stub(() => 0);
    await useMail.getState().loadLabelCounts();
    expect(asked).toContainEqual({ hasKeyword: "freight" });
    expect(asked).toContainEqual({ hasKeyword: STARRED_KEYWORD });
    // The reader's personal label is not what a group mailbox files under.
    expect(asked).not.toContainEqual({ hasKeyword: "work" });
  });

  it("counts the unit the list will show: conversations when conversation view is on", async () => {
    // A conversation of three messages carrying a label counts once when the
    // list collapses threads, because that is the row the reader will see. A
    // number that contradicts the list it opens is worse than no number.
    useSettings.setState((s) => ({
      settings: { ...s.settings, conversationMode: true },
    }));
    const queries: unknown[] = [];
    stub(() => 0, queries);
    await useMail.getState().loadLabelCounts();
    expect(queries.length).toBeGreaterThan(0);
    expect(
      queries.every((q) => (q as { collapseThreads?: boolean }).collapseThreads),
    ).toBe(true);
  });

  it("counts messages when conversation view is off", async () => {
    useSettings.setState((s) => ({
      settings: { ...s.settings, conversationMode: false },
    }));
    const queries: unknown[] = [];
    stub(() => 0, queries);
    await useMail.getState().loadLabelCounts();
    expect(queries.length).toBeGreaterThan(0);
    expect(
      queries.every((q) => (q as { collapseThreads?: boolean }).collapseThreads),
    ).toBe(false);
  });

  it("counts nothing but Starred while the group's catalog is not read yet", async () => {
    // The catalog is a file in the group's app folder and arrives after the
    // folder tree does, so the first recount of a freshly opened group has
    // nothing to count but the star -- which is an account's anyway.
    useGroupLabels.setState({ byAccount: {} });
    const asked = stub(() => 0);
    await useMail.getState().loadLabelCounts();
    expect(asked).toEqual([
      { hasKeyword: STARRED_KEYWORD },
      {
        operator: "AND",
        conditions: [{ hasKeyword: STARRED_KEYWORD }, { notKeyword: SEEN_KEYWORD }],
      },
    ]);
  });

  it("refreshes them when another member changes a message, which is the live path", async () => {
    // The observable claim: after an `Email` StateChange for the group -- as
    // the push rail delivers it when somebody else stars or labels a message
    // there -- the counts are asked for again, so the numbers the sidebar
    // shows are the ones that just moved.
    const asked = stub(() => 0);
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Email/changes")
        return {
          created: [],
          updated: [],
          destroyed: [],
          newState: "s2",
          hasMoreChanges: false,
        };
      if (method === "Mailbox/get") return { list: [], state: "m2" };
      return { list: [], state: "s2" };
    }) as never);
    useMail.setState({ emailState: "s1" });

    await useMail.getState().applyChanges(new Set(["Email"]));

    // The group's own label and the star, both halves of each.
    expect(asked).toContainEqual({ hasKeyword: "freight" });
    expect(asked).toContainEqual({ hasKeyword: STARRED_KEYWORD });
    expect(asked).toContainEqual({
      operator: "AND",
      conditions: [{ hasKeyword: "freight" }, { notKeyword: SEEN_KEYWORD }],
    });
  });
});

describe("a write moves the number without asking", () => {
  it("drops the starred count when a star is removed", async () => {
    stub(() => 0);
    useMail.setState({
      emails: { e1: email("e1", { [STARRED_KEYWORD]: true, [SEEN_KEYWORD]: true }) },
      labelCounts: { [STARRED_KEYWORD]: { total: 5, unread: 2 } },
    });
    await useMail.getState().star(["e1"], false);
    expect(useMail.getState().labelCounts[STARRED_KEYWORD]).toEqual({
      total: 4,
      unread: 2,
    });
  });

  it("drops a label's count when the label is taken off an unread message", async () => {
    stub(() => 0);
    useMail.setState({
      emails: { e1: email("e1", { work: true }) },
      labelCounts: { work: { total: 3, unread: 3 } },
    });
    await useMail.getState().setKeyword(["e1"], "work", false);
    expect(useMail.getState().labelCounts.work).toEqual({ total: 2, unread: 2 });
  });

  it("moves the unread halves but no total when a message is marked read", async () => {
    stub(() => 0);
    useMail.setState({
      emails: { e1: email("e1", { work: true, home: true }) },
      labelCounts: {
        work: { total: 3, unread: 3 },
        home: { total: 3, unread: 3 },
      },
    });
    await useMail.getState().markRead(["e1"], true);
    expect(useMail.getState().labelCounts.work).toEqual({ total: 3, unread: 2 });
    expect(useMail.getState().labelCounts.home).toEqual({ total: 3, unread: 2 });
  });
});
