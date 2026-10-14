import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useMail } from "@/store/mail";
import {
  SUBSCRIBE_RETRY_MS,
  subscribing,
  subscriptionBackoff,
} from "@/store/mail/mailboxes";
import { useSession } from "@/store/session";
import { flushMicrotasks as flush } from "@/test/testkit";

/**
 * Every folder of a group is subscribed for the member who reads it.
 *
 * Stalwart hands a freshly added member the whole tree unsubscribed, and a
 * folder created since arrives unsubscribed too, so a member's own record has
 * to be brought up to what membership means — otherwise the group is unreadable
 * from every client that honours subscriptions, which is every client but this
 * one. The write is what this pins: on the read of a group's folders, one
 * `Mailbox/set` naming exactly the folders that are not subscribed, and nothing
 * at all when there is nothing to write.
 *
 * It is deliberately not written for the reader's own mailbox: there, an
 * unsubscribed folder is one they hid themselves.
 */

type Tree = Record<string, Record<string, unknown>>;

const box = (
  id: string,
  name: string,
  parentId: string | null,
  isSubscribed: boolean,
) => ({
  id,
  name,
  parentId,
  role: null,
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  isSubscribed,
  myRights: {},
});

/* A member's group mailbox: Inbox > MS2 > a case, every folder unsubscribed. */
const groupTree = (): Tree => ({
  a: box("a", "Inbox", null, false),
  l: box("l", "MS2", "a", false),
  t: box("t", "277044606", "l", false),
});

/* The reader's own mailbox, with a folder they hid. */
const ownTree = (): Tree => ({
  a: box("a", "Inbox", null, true),
  w: box("w", "Newsletters", null, false),
});

function stubServer(trees: Record<string, Tree>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses: unknown[] = [];
      for (const [name, args, id] of body.methodCalls) {
        calls.push({ name, args });
        const accountId = String(args.accountId ?? "");
        if (name === "Mailbox/get") {
          methodResponses.push([
            name,
            {
              accountId,
              state: "1",
              list: Object.values(trees[accountId] ?? {}),
              notFound: [],
            },
            id,
          ]);
        } else if (name === "Mailbox/set") {
          const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
          for (const [mid, patch] of Object.entries(update))
            Object.assign(trees[accountId]?.[mid] ?? {}, patch);
          methodResponses.push([
            name,
            {
              accountId,
              oldState: "1",
              newState: "2",
              updated: Object.fromEntries(Object.keys(update).map((k) => [k, null])),
            },
            id,
          ]);
        } else {
          methodResponses.push([
            name,
            {
              accountId,
              state: "1",
              list: [],
              notFound: [],
              ids: [],
              total: 0,
              position: 0,
              queryState: "1",
            },
            id,
          ]);
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ methodResponses, sessionState: "1" }),
      } as Response;
    }),
  );
  return calls;
}

const SESSION = {
  accounts: {
    own: { name: "me@example.org", isPersonal: true },
    gg: { name: "team@example.org", isPersonal: false },
  },
  primaryAccounts: { [CAP.mail]: "own" },
  capabilities: {},
  state: "s1",
} as unknown as JmapSession;

const subscribedIds = (calls: Array<{ name: string; args: Record<string, unknown> }>) =>
  calls
    .filter((c) => c.name === "Mailbox/set")
    .flatMap((c) => Object.keys((c.args.update ?? {}) as Record<string, unknown>))
    .sort();

beforeEach(() => {
  client.session = SESSION;
  useSession.setState({ session: SESSION });
  // The back-off and the in-flight map are module state shared by every case:
  // a refusal one case leaves behind would silence the next one's first read.
  subscribing.clear();
  subscriptionBackoff.clear();
  useMail.setState({
    accountId: null,
    ownAccountId: "own",
    mailboxes: {},
    mailboxesLoaded: false,
    accountTrees: {},
    mailAccounts: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useMail.setState({ accountId: null, mailboxes: {}, accountTrees: {} });
  useSession.setState({ status: "loading", session: null });
});

describe("a group's folders, read by a member", () => {
  it("are subscribed in one write, for exactly the ones that are not", async () => {
    const trees = { gg: groupTree(), own: ownTree() };
    const calls = stubServer(trees);
    useMail.setState({ accountId: "gg" });
    await useMail.getState().loadMailboxes();
    await flush();
    expect(subscribedIds(calls)).toEqual(["a", "l", "t"]);
    const write = calls.find((c) => c.name === "Mailbox/set");
    expect(write?.args.accountId).toBe("gg");
    expect(Object.values(write?.args.update ?? {})).toEqual([
      { isSubscribed: true },
      { isSubscribed: true },
      { isSubscribed: true },
    ]);
  });

  it("are subscribed when the tree arrives on its own beat, not only when opened", async () => {
    const trees = { gg: groupTree(), own: ownTree() };
    const calls = stubServer(trees);
    await useMail.getState().refreshAccountTree("gg");
    await flush();
    expect(subscribedIds(calls)).toEqual(["a", "l", "t"]);
  });

  it("are written once: a tree that is already subscribed costs no request", async () => {
    const trees = { gg: { a: box("a", "Inbox", null, true) }, own: ownTree() };
    const calls = stubServer(trees);
    useMail.setState({ accountId: "gg" });
    await useMail.getState().loadMailboxes();
    await flush();
    // And again with the tree the first read left behind.
    await useMail.getState().loadMailboxes();
    await flush();
    expect(calls.filter((c) => c.name === "Mailbox/set")).toEqual([]);
  });
});

describe("the reader's own mailbox", () => {
  it("keeps its own subscriptions -- there, unsubscribed is something they said", async () => {
    const trees = { gg: groupTree(), own: ownTree() };
    const calls = stubServer(trees);
    useMail.setState({ accountId: "own" });
    await useMail.getState().loadMailboxes();
    await flush();
    expect(calls.filter((c) => c.name === "Mailbox/set")).toEqual([]);
  });
});

describe("a subscription write that is refused", () => {
  /*
   * A refusal is not the end of it: the write is what makes the group readable
   * in every client but this one, so it is asked again — but only after a short
   * back-off, because a group's tree is read by the probe, the account's change
   * beat and every folder action, and one write per read is a storm against a
   * server that keeps saying no. A clock the suite controls stands in for the
   * wall clock the back-off is measured against.
   */
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  it("is asked again once the back-off has passed, not on the next read", async () => {
    const tree = groupTree();
    let attempts = 0;
    let fail = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Mailbox/get")
        return { accountId: "gg", state: "1", list: Object.values(tree), notFound: [] };
      if (method === "Mailbox/set") {
        attempts += 1;
        if (fail) throw new Error("refused");
        return { accountId: "gg", oldState: "1", newState: "2" };
      }
      return { accountId: "gg", state: "1", list: [], notFound: [] };
    }) as never);

    await useMail.getState().refreshAccountTree("gg");
    await flush();
    // The first read was refused, so it wrote and failed.
    expect(attempts).toBe(1);

    // ...and a read still inside the back-off does not ask again, however well
    // the server would answer now.
    fail = false;
    await useMail.getState().refreshAccountTree("gg");
    await flush();
    expect(attempts).toBe(1);

    // Once the back-off has passed the write is asked again, so a transient
    // refusal heals within the session rather than after a reload.
    now += SUBSCRIBE_RETRY_MS;
    await useMail.getState().refreshAccountTree("gg");
    await flush();
    expect(attempts).toBe(2);
  });

  it("asks once for a burst of reads, and reports the refusal once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Mailbox/get")
        return {
          accountId: "gg",
          state: "1",
          list: Object.values(groupTree()),
          notFound: [],
        };
      if (method === "Mailbox/set") {
        attempts += 1;
        throw new Error("refused");
      }
      return { accountId: "gg", state: "1", list: [], notFound: [] };
    }) as never);

    // Five reads inside one back-off: the probe, the beat and a person's clicks
    // all land here, and the server repeats the same "no" to each.
    for (let i = 0; i < 5; i++) {
      await useMail.getState().refreshAccountTree("gg");
      await flush();
    }

    expect(attempts).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns for a second account refused too, not only the first", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Both accounts carry the same unsubscribed tree and the same refusal: a
    // report keyed globally would be silenced by the first account's refusal.
    vi.spyOn(client, "call").mockImplementation((async (
      method: string,
      args: Record<string, unknown>,
    ) => {
      const accountId = String(args.accountId ?? "gg");
      if (method === "Mailbox/get")
        return { accountId, state: "1", list: Object.values(groupTree()), notFound: [] };
      if (method === "Mailbox/set") throw new Error("refused");
      return { accountId, state: "1", list: [], notFound: [] };
    }) as never);

    await useMail.getState().refreshAccountTree("gg");
    await flush();
    await useMail.getState().refreshAccountTree("gg2");
    await flush();

    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("a folder tree that cannot be read", () => {
  it("keeps the tree on screen and says so once for the outage", async () => {
    const tree = { a: box("a", "Inbox", null, true) };
    useMail.setState({
      accountId: "own",
      mailboxes: tree as never,
      mailboxesLoaded: true,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let mode: "fail" | "ok" = "fail";
    vi.spyOn(client, "call").mockImplementation((async () => {
      if (mode === "fail") throw new Error("offline");
      return { accountId: "own", state: "1", list: [tree.a], notFound: [] };
    }) as never);

    // A read that fails is not an answer: the tree already on screen stays, and
    // the dozen fire-and-forget callers do not each report it.
    await useMail.getState().loadMailboxes();
    await useMail.getState().loadMailboxes();
    expect(useMail.getState().mailboxes).toEqual(tree);
    expect(useMail.getState().mailboxesLoaded).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    // A read that lands answers the outage, so a later failure is news again.
    mode = "ok";
    await useMail.getState().loadMailboxes();
    mode = "fail";
    await useMail.getState().loadMailboxes();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
