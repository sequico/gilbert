import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { flushMicrotasks as flush } from "@/test/testkit";

/**
 * Two things the mail store must not carry across an account boundary.
 *
 * A switch to another mailbox clears the folders, messages, threads and the
 * selection, and must clear the rest with them: the open conversation, the
 * label counts, the in-flight thread loads and the ids of the last conversation
 * that loaded are ids of the account that was on screen, read against the
 * folders of the new one.
 *
 * And the probe that decides which accounts are group mailboxes is single
 * flight. A second caller must join the run already on its way rather than
 * return as if it had an answer, and an answer that lands after a sign-out
 * belongs to the session it was asked of, not to the one on screen.
 */

const SESSION = {
  accounts: {
    own: {
      name: "me@example.org",
      isPersonal: true,
      accountCapabilities: { [CAP.mail]: {} },
    },
    gg: {
      name: "team@example.org",
      isPersonal: false,
      accountCapabilities: { [CAP.mail]: {} },
    },
  },
  primaryAccounts: { [CAP.mail]: "own" },
} as unknown as JmapSession;

beforeEach(() => {
  useMail.setState({
    accountId: null,
    ownAccountId: null,
    mailAccounts: [],
    accountTrees: {},
    mailboxes: {},
    emails: {},
    threads: {},
    identities: [],
    list: null,
    selected: {},
    labelCounts: {},
    loadingThreads: {},
    lastThreadEmailIds: [],
    lastSeenInboxEmailIds: null,
    openThreadId: null,
  });
  useSession.setState({ status: "loading", session: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useMail.setState({ accountId: null, ownAccountId: null, mailAccounts: [] });
  useSession.setState({ status: "loading", session: null });
});

describe("what a switch to another account drops", () => {
  beforeEach(() => {
    useMail.setState({
      accountId: "a1",
      ownAccountId: "a1",
      mailAccounts: [{ accountId: "a1", name: "me@example.org", kind: "own" }],
      accountTrees: { a1: { mb1: { id: "mb1", name: "Inbox" } as never } },
      openThreadId: "th-old",
      labelCounts: { $label1: { total: 3, unread: 1 } },
      loadingThreads: { "th-old": true },
      lastThreadEmailIds: ["e-old"],
      emails: { "e-old": { id: "e-old" } as never },
      threads: { "th-old": { id: "th-old" } as never },
      selected: { "e-old": true },
    });
  });

  it("keeps no conversation, label count or thread load of the account before", () => {
    useMail.getState().setAccount("a2");
    const s = useMail.getState();
    expect(s.openThreadId).toBeNull();
    expect(s.labelCounts).toEqual({});
    expect(s.loadingThreads).toEqual({});
    expect(s.lastThreadEmailIds).toEqual([]);
    expect(s.emails).toEqual({});
    expect(s.threads).toEqual({});
    expect(s.selected).toEqual({});
  });

  it("keeps the account list and the trees that let the reader come back", () => {
    useMail.getState().setAccount("a2");
    const s = useMail.getState();
    expect(s.accountId).toBe("a2");
    expect(s.ownAccountId).toBe("a1");
    expect(s.mailAccounts.map((a) => a.accountId)).toEqual(["a1"]);
    expect(Object.keys(s.accountTrees)).toEqual(["a1"]);
  });
});

describe("the mail probe", () => {
  it("gives a caller that arrives mid-probe the same answer, not an empty one", async () => {
    const probed: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((res) => {
      release = res;
    });
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method !== "Mailbox/get") return { accountId: args.accountId } as never;
      probed.push(String(args.accountId));
      await held;
      return {
        accountId: args.accountId,
        state: "1",
        list: [{ id: "mb1", name: "Inbox" }],
        notFound: [],
      } as never;
    });
    useSession.setState({ session: SESSION });

    const first = useMail.getState().discoverMailAccounts();
    const second = useMail.getState().discoverMailAccounts();
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await flush();
    // Returning here would be returning as if the mailbox list were known.
    expect(secondDone).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(probed).toEqual(["gg"]);
    expect(useMail.getState().mailAccounts.map((a) => a.accountId)).toEqual([
      "own",
      "gg",
    ]);
  });

  it("probes an account the session advertises nothing on, and lists it as a group", async () => {
    /*
     * The capability list is the credential's rights on the account, not what
     * the account was shared for, so it cannot decide whether an account is
     * asked. A member's group mailbox whose record advertises nothing is still
     * a mailbox: the probe asks it, and its folder tree is the only thing that
     * makes it a group here.
     */
    const MEMBER_SESSION = {
      accounts: {
        own: {
          name: "me@example.org",
          isPersonal: true,
          accountCapabilities: { [CAP.mail]: {} },
        },
        gg: {
          name: "team@example.org",
          isPersonal: false,
          accountCapabilities: {},
        },
      },
      primaryAccounts: { [CAP.mail]: "own" },
    } as unknown as JmapSession;
    vi.spyOn(client, "call").mockImplementation((async (
      method: string,
      args: { accountId?: string },
    ) => {
      if (method !== "Mailbox/get") return { accountId: args.accountId };
      return {
        accountId: args.accountId,
        state: "1",
        list: [{ id: "mb1", name: "Inbox" }],
        notFound: [],
      };
    }) as never);
    useSession.setState({ session: MEMBER_SESSION });

    await useMail.getState().discoverMailAccounts();

    expect(useMail.getState().mailAccounts).toEqual([
      { accountId: "own", name: "me@example.org", kind: "own" },
      { accountId: "gg", name: "team@example.org", kind: "group" },
    ]);
    expect(Object.keys(useMail.getState().accountTrees)).toEqual(["gg"]);
  });

  it("drops an answer that lands after the session it was asked of is gone", async () => {
    let release!: () => void;
    const held = new Promise<void>((res) => {
      release = res;
    });
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method !== "Mailbox/get") return { accountId: args.accountId } as never;
      await held;
      return {
        accountId: args.accountId,
        state: "1",
        list: [{ id: "mb1", name: "Inbox" }],
        notFound: [],
      } as never;
    });
    useMail.setState({
      accountId: "own",
      ownAccountId: "own",
      mailAccounts: [{ accountId: "own", name: "me@example.org", kind: "own" }],
    });
    useSession.setState({ session: SESSION });

    const probe = useMail.getState().discoverMailAccounts();
    // Signing out while the probe is in flight.
    useSession.setState({ status: "anonymous", session: null });
    expect(useMail.getState().mailAccounts).toEqual([]);

    release();
    await probe;
    // The accounts of the session that is gone must not come back on screen.
    expect(useMail.getState().mailAccounts).toEqual([]);
    expect(useMail.getState().ownAccountId).toBeNull();
    expect(useMail.getState().accountTrees).toEqual({});
  });
});
