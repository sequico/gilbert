import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession, Mailbox } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { fakeJmapServer } from "@/test/jmapServer";
import { useToasts } from "@/ui/toast";

/**
 * Archive puts a conversation back where it was filed.
 *
 * A reply arrives, joins the thread, and the conversation is back in the Inbox
 * while the rest of it sits in the folder it was filed under -- a case folder
 * under Archive, or any folder the reader made. Archiving it then means putting
 * it back there, and only a conversation that was never filed anywhere goes to
 * Archive itself.
 *
 * Two things this pins beyond the folder: the thread is read from the account
 * the action is aimed at and nowhere else (a group's copy of a conversation and
 * the reader's own copy are two threads, each filed on its own), and a message
 * already in that folder -- archiving out of the folder itself -- is still
 * filed away, so the action never becomes a no-op.
 */

const TREE: Record<string, Partial<Mailbox> & { id: string; name: string }> = {
  mbInbox: { id: "mbInbox", name: "Inbox", role: "inbox", parentId: null },
  mbSent: { id: "mbSent", name: "Sent Items", role: "sent", parentId: null },
  mbArchive: { id: "mbArchive", name: "Archive", role: "archive", parentId: null },
  mbCases: { id: "mbCases", name: "MS2", role: null, parentId: "mbArchive" },
  mbCase: { id: "mbCase", name: "277045275 Ennore", role: null, parentId: "mbCases" },
  mbProject: { id: "mbProject", name: "Projects", role: null, parentId: null },
};

/** The thread's other message, which the list is not showing. */
interface Elsewhere {
  threadId: string;
  message: { id: string; mailboxIds: Record<string, boolean>; receivedAt: string };
}

function server(elsewhere: Elsewhere | null, threadIds: string[] = ["t1"]) {
  const moved: Array<{ accountId: string; id: string; to: string }> = [];
  const fake = fakeJmapServer()
    .on("Thread/get", ({ args }) => ({
      accountId: args.accountId,
      state: "1",
      list: threadIds.map((id) => ({ id, emailIds: ["e1", "e0"] })),
      notFound: [],
    }))
    .on("Email/get", ({ args }) => ({
      accountId: args.accountId,
      state: "1",
      list:
        elsewhere && (args.ids as string[]).includes(elsewhere.message.id)
          ? [elsewhere.message]
          : [],
      notFound: [],
    }))
    .on("Email/set", ({ args }) => {
      for (const [emailId, patch] of Object.entries(
        (args.update ?? {}) as Record<string, Record<string, unknown>>,
      )) {
        for (const [path, v] of Object.entries(patch)) {
          if (!path.startsWith("mailboxIds/") || v !== true) continue;
          moved.push({
            accountId: String(args.accountId),
            id: emailId,
            to: path.slice("mailboxIds/".length),
          });
        }
      }
      return { accountId: args.accountId, oldState: "1", newState: "2" };
    });
  return { moved, fake };
}

const messages = () => useToasts.getState().toasts.map((t) => t.message);

function seed(accountId: string) {
  useMail.setState({
    accountId,
    mailboxes: TREE as never,
    // The Inbox is the folder whose row this is: that is where the reply landed.
    list: { mailboxId: "mbInbox", ids: ["e1"] } as never,
    threads: {},
    emails: {
      e1: {
        id: "e1",
        threadId: "t1",
        receivedAt: "2026-09-22T10:00:00Z",
        mailboxIds: { mbInbox: true },
      },
    } as never,
    selected: {},
  });
}

beforeEach(() => {
  client.session = {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500, maxCallsInRequest: 16 },
      [CAP.mail]: {},
    },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useToasts.setState({ toasts: [] });
  seed("a1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("archiving a conversation that was filed somewhere", () => {
  it("puts it back in the folder it was filed under, not in Archive", async () => {
    const s = server({
      threadId: "t1",
      message: {
        id: "e0",
        mailboxIds: { mbCase: true },
        receivedAt: "2026-09-14T10:00:00Z",
      },
    });
    await useMail.getState().archive(["e1"]);
    expect(s.moved).toEqual([{ accountId: "a1", id: "e1", to: "mbCase" }]);
    expect(messages()).toEqual(["Conversation moved to 277045275 Ennore"]);
  });

  it("follows a folder the reader made, which is not under Archive at all", async () => {
    const s = server({
      threadId: "t1",
      message: {
        id: "e0",
        mailboxIds: { mbProject: true },
        receivedAt: "2026-09-14T10:00:00Z",
      },
    });
    await useMail.getState().archive(["e1"]);
    expect(s.moved).toEqual([{ accountId: "a1", id: "e1", to: "mbProject" }]);
  });

  it("goes to Archive when the conversation was never filed anywhere", async () => {
    // The thread's other message is in Sent: answering a message is not filing it.
    const s = server({
      threadId: "t1",
      message: {
        id: "e0",
        mailboxIds: { mbSent: true },
        receivedAt: "2026-09-14T10:00:00Z",
      },
    });
    await useMail.getState().archive(["e1"]);
    expect(s.moved).toEqual([{ accountId: "a1", id: "e1", to: "mbArchive" }]);
    expect(messages()).toEqual(["Conversation moved to Archive"]);
  });

  it("still files a message that is already in that folder", async () => {
    // Archiving out of the case folder itself: its own folder is not "back
    // there", and doing nothing is not what the entry says it does.
    const s = server({
      threadId: "t1",
      message: {
        id: "e0",
        mailboxIds: { mbCase: true },
        receivedAt: "2026-09-14T10:00:00Z",
      },
    });
    useMail.setState({
      list: { mailboxId: "mbCase", ids: ["e1"] } as never,
      emails: {
        e1: {
          id: "e1",
          threadId: "t1",
          receivedAt: "2026-09-22T10:00:00Z",
          mailboxIds: { mbCase: true },
        },
      } as never,
    });
    await useMail.getState().archive(["e1"]);
    expect(s.moved).toEqual([{ accountId: "a1", id: "e1", to: "mbArchive" }]);
  });
});

describe("the same in a group mailbox", () => {
  it("reads the group's own thread and files into the group's own folder", async () => {
    seed("g1");
    const s = server({
      threadId: "t1",
      message: {
        id: "e0",
        mailboxIds: { mbCase: true },
        receivedAt: "2026-09-14T10:00:00Z",
      },
    });
    await useMail.getState().archive(["e1"]);
    // Every read and the write are the group's: the reader's own copy of the
    // same conversation is another account's mail, filed from there.
    expect(s.moved).toEqual([{ accountId: "g1", id: "e1", to: "mbCase" }]);
    expect(s.fake.callsTo("Thread/get").map((c) => c.args.accountId)).toEqual(["g1"]);
    expect(s.fake.callsTo("Email/set").map((c) => c.args.accountId)).toEqual(["g1"]);
  });
});
