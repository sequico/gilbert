import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import {
  deleteEffect,
  deleteEntryOffered,
  folderDestroyTakesMail,
  mayDestroy,
} from "@/lib/mailDelete";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { useToasts } from "@/ui/toast";

/**
 * The invariant ADR 0015 rests on: in a group mailbox, mail is ended by an
 * installation administrator and by nobody else.
 *
 * Every case here fails if the guard is removed rather than merely observing
 * that the code ran — a member's destroy must reach **no server at all**, which
 * is what the stubbed transport counts, and an administrator's must reach one.
 * The three entry points are the three the record names, and the failure that
 * matters is the one nobody notices: a refusal that still issued the call would
 * leave the group's mail destroyable while the surface said otherwise.
 *
 * The fail-closed case is here for the same reason: the group classifier
 * answers "not a group" until the account probe has listed the account, so the
 * rule asks whether the account is the reader's own instead — a question that
 * is answerable at any moment. Without that, a reload on a group's address
 * would destroy that group's mail.
 */

const OWN = "a1";
const GROUP = "aGroup";
const MAIL = CAP.mail;

/** The session as the client holds it: own account, a group, and the admin flag. */
function sessionOf(opts: { isAdmin: boolean; withGroup?: boolean }): JmapSession {
  const accounts: Record<string, unknown> = {
    [OWN]: {
      name: "me@example.com",
      isPersonal: true,
      accountCapabilities: { [MAIL]: {} },
    },
  };
  if (opts.withGroup) {
    accounts[GROUP] = {
      name: "team@example.com",
      isPersonal: false,
      accountCapabilities: { [MAIL]: {} },
    };
  }
  return {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [MAIL]: {},
    },
    accounts,
    primaryAccounts: { [MAIL]: OWN },
    state: "s1",
    gilbert: { isAdmin: opts.isAdmin },
  } as unknown as JmapSession;
}

/** Counts what actually left the client, so a refusal that called is visible. */
function transport() {
  const destroys: { accountId: string; ids: string[] }[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const methodResponses = body.methodCalls.map(
      ([name, args, id]: [string, Record<string, unknown>, string]) => {
        if (name === "Email/set" && Array.isArray(args.destroy)) {
          destroys.push({
            accountId: String(args.accountId),
            ids: args.destroy as string[],
          });
          return [
            name,
            {
              accountId: args.accountId,
              oldState: "1",
              newState: "2",
              destroyed: args.destroy,
              notDestroyed: {},
            },
            id,
          ];
        }
        return [
          name,
          {
            accountId: args.accountId ?? OWN,
            state: "1",
            list: [],
            notFound: [],
            ids: [],
            total: 0,
            queryState: "q",
            position: 0,
            canCalculateChanges: false,
          },
          id,
        ];
      },
    );
    return { ok: true, status: 200, json: async () => ({ methodResponses }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { destroys };
}

const messages = () => useToasts.getState().toasts.map((t) => t.message);

const TRASH = "mbTrash";
const JUNK = "mbJunk";

function mount(accountId: string, opts: { isAdmin: boolean; withGroup?: boolean }) {
  client.session = sessionOf(opts);
  useSession.setState({ session: client.session, status: "authenticated" });
  useMail.setState({
    accountId,
    ownAccountId: OWN,
    // The probe's answer. An empty set is the state before it lands.
    mailAccounts: opts.withGroup
      ? [
          { accountId: OWN, name: "me@example.com", kind: "own" },
          { accountId: GROUP, name: "team@example.com", kind: "group" },
        ]
      : [{ accountId: OWN, name: "me@example.com", kind: "own" }],
    mailboxes: {
      [TRASH]: {
        id: TRASH,
        role: "trash",
        name: "Deleted Items",
        totalEmails: 3,
        myRights: { mayDelete: true },
      },
      [JUNK]: {
        id: JUNK,
        role: "junk",
        name: "Junk Mail",
        totalEmails: 5,
        myRights: { mayDelete: true },
      },
      mbEmpty: {
        id: "mbEmpty",
        role: null,
        name: "Old",
        totalEmails: 0,
        myRights: { mayDelete: true },
      },
    } as never,
    emails: {
      e1: { id: "e1", mailboxIds: { [TRASH]: true } },
      e2: { id: "e2", mailboxIds: { [JUNK]: true } },
      e3: { id: "e3", mailboxIds: { mbInbox: true } },
    } as never,
    list: null,
  });
  useToasts.setState({ toasts: [] });
}

beforeEach(() => {
  vi.useFakeTimers();
  mount(OWN, { isAdmin: false, withGroup: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("destroying mail in a group (ADR 0015)", () => {
  it("refuses a member's final delete without asking any server", async () => {
    const s = transport();
    mount(GROUP, { isAdmin: false, withGroup: true });
    await useMail.getState().destroy(["e1"]);
    expect(s.destroys).toEqual([]);
    // And says why, naming what still works rather than only what does not.
    expect(messages().join(" ")).toContain("installation administrator");
  });

  it("lets an administrator's final delete through", async () => {
    const s = transport();
    mount(GROUP, { isAdmin: true, withGroup: true });
    await useMail.getState().destroy(["e1"]);
    expect(s.destroys).toEqual([{ accountId: GROUP, ids: ["e1"] }]);
  });

  it("leaves the reader's own mailbox alone, administrator or not", async () => {
    const s = transport();
    mount(OWN, { isAdmin: false, withGroup: true });
    await useMail.getState().destroy(["e1"]);
    expect(s.destroys).toEqual([{ accountId: OWN, ids: ["e1"] }]);
  });

  /**
   * The window this rule exists for: the account probe has not listed the
   * account yet, so "not a group" and "not discovered yet" are one answer. The
   * reader's own account is still provable, and a group's mail is not.
   */
  it("refuses an account nobody has classified yet, and still serves the reader's own", async () => {
    const s = transport();
    mount(GROUP, { isAdmin: false });
    await useMail.getState().destroy(["e1"]);
    expect(s.destroys).toEqual([]);

    mount(OWN, { isAdmin: false });
    await useMail.getState().destroy(["e1"]);
    expect(s.destroys).toEqual([{ accountId: OWN, ids: ["e1"] }]);
  });

  it("refuses a member's emptying of the group's Deleted Items", async () => {
    const s = transport();
    mount(GROUP, { isAdmin: false, withGroup: true });
    await useMail.getState().emptyMailbox(TRASH);
    expect(s.destroys).toEqual([]);
    expect(messages().join(" ")).toContain("installation administrator");
  });

  it("refuses deleting a group folder that holds mail, and allows an empty one", async () => {
    const s = transport();
    mount(GROUP, { isAdmin: false, withGroup: true });
    await useMail.getState().destroyMailbox(TRASH, true);
    expect(s.destroys).toEqual([]);

    // An empty folder is not mail: the group's tree stays the group's to shape.
    mount(GROUP, { isAdmin: false, withGroup: true });
    await useMail.getState().destroyMailbox("mbEmpty", true);
    expect(messages().join(" ")).not.toContain("folder holding mail");
  });
});

/** The rule's own answers, which the surfaces read rather than restating. */
describe("the delete rule's parts", () => {
  const ctx = (over: {
    accountId?: string | null;
    isAdmin?: boolean;
    session?: JmapSession | null;
  }) => ({
    accountId: OWN as string | null,
    session: sessionOf({ isAdmin: false, withGroup: true }),
    isAdmin: false,
    ...over,
  });

  it("counts Junk Mail as final, which is what the surfaces disagreed about", () => {
    const folders = { trash: TRASH, junk: JUNK };
    expect(deleteEffect({ mailboxIds: { [JUNK]: true } }, folders)).toBe("final");
    expect(deleteEffect({ mailboxIds: { mbInbox: true } }, folders)).toBe("move");
  });

  it("treats an empty folder as nothing to destroy", () => {
    expect(folderDestroyTakesMail({ totalEmails: 0 }, true)).toBe(false);
    expect(folderDestroyTakesMail({ totalEmails: 1 }, true)).toBe(true);
    // Without removeEmails the mail stays whatever the folder holds.
    expect(folderDestroyTakesMail({ totalEmails: 1 }, false)).toBe(false);
  });

  it("answers the same question the guards do", () => {
    expect(mayDestroy(ctx({}))).toBe(true);
    expect(mayDestroy(ctx({ accountId: GROUP }))).toBe(false);
    expect(mayDestroy(ctx({ accountId: GROUP, isAdmin: true }))).toBe(true);
    expect(mayDestroy(ctx({ accountId: null }))).toBe(false);
  });

  /**
   * The entry a surface draws is withdrawn only where the action would *end* a
   * message. Filing one is not ending it — deleting from a group's Inbox still
   * moves to that group's Deleted Items — so a group's list and thread keep
   * their delete wherever it would move. This is the half a guard on the effect
   * alone cannot express, and getting it wrong takes the main action away from
   * every member of every group.
   */
  it("withdraws only the final delete in a group, not the filing one", () => {
    expect(deleteEntryOffered(false, "move")).toBe(true);
    expect(deleteEntryOffered(false, "final")).toBe(false);
    expect(deleteEntryOffered(true, "final")).toBe(true);
  });
});
