import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import {
  deleteEffect,
  deleteEntryOffered,
  folderDestroyTakesMail,
  mayDestroy,
} from "@/lib/mailDelete";
import { describeSwipe } from "@/lib/swipe";
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
function transport(mode: "ok" | "refuse" | "partial" | "throw" = "ok") {
  const destroys: { accountId: string; ids: string[] }[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    if (mode === "throw") throw new Error("the server is unreachable");
    const body = JSON.parse(init.body as string) as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const methodResponses = body.methodCalls.map(
      ([name, args, id]: [string, Record<string, unknown>, string]) => {
        if (name === "Email/set" && Array.isArray(args.destroy)) {
          const ids = args.destroy as string[];
          destroys.push({ accountId: String(args.accountId), ids });
          /*
           * The server's own refusal, in the shape JMAP answers it: the ids it
           * would not destroy come back under `notDestroyed` with a reason, and
           * `destroyed` carries only the ones that went.
           */
          const refused: Record<string, unknown> = {};
          if (mode !== "ok")
            for (const one of mode === "partial" ? ids.slice(0, 1) : ids)
              refused[one] = { type: "forbidden" };
          const gone = ids.filter((one) => !(one in refused));
          return [
            name,
            {
              accountId: args.accountId,
              oldState: "1",
              newState: "2",
              destroyed: gone,
              notDestroyed: refused,
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
    const outcome = await useMail.getState().destroy(["e1"]);
    expect(s.destroys).toEqual([]);
    // And says why, naming what still works rather than only what does not.
    expect(messages().join(" ")).toContain("installation administrator");
    /*
     * And *answers*, which is what no caller can guess from silence: the list
     * uses this to decide whether to move its focus off a row that is still
     * there, and a menu whether to report a deletion that did not happen.
     */
    expect(outcome).toEqual({ ok: false, code: "group_mail_final" });
  });

  it("answers ok on a delete that went through", async () => {
    const s = transport();
    mount(OWN, { isAdmin: false, withGroup: true });
    expect(await useMail.getState().destroy(["e1"])).toEqual({ ok: true });
    expect(s.destroys).toEqual([{ accountId: OWN, ids: ["e1"] }]);
  });

  /**
   * The other half of "a caller can tell a refusal from work done": the refusal
   * can come from the *server*, not only from the rule. Silence read as success
   * is the same defect on either path — the list clears its selection and moves
   * the focus off a row the server just left in place.
   */
  it("answers the server's own refusal, which is not the rule's", async () => {
    transport("refuse");
    mount(OWN, { isAdmin: false, withGroup: true });
    expect(await useMail.getState().destroy(["e1"])).toEqual({
      ok: false,
      code: "server_refused",
    });
  });

  /**
   * And the partial case is deliberately *not* a refusal: some of the mail went,
   * the toast named the mail that stayed, and a caller that undid the action
   * would be undoing something that happened.
   */
  it("still answers ok when the server refused only part of the selection", async () => {
    transport("partial");
    mount(OWN, { isAdmin: false, withGroup: true });
    expect(await useMail.getState().destroy(["e1", "e3"])).toEqual({ ok: true });
    expect(messages().join(" ")).toContain("could not be deleted");
  });

  it("answers a failure that never reached the server", async () => {
    transport("throw");
    mount(OWN, { isAdmin: false, withGroup: true });
    expect(await useMail.getState().destroy(["e1"])).toEqual({
      ok: false,
      code: "server_refused",
    });
  });

  /**
   * A mixed selection whose destroy half the server refused, with nothing to
   * file the rest into, is the case where "did anything happen" has to answer
   * no: the trash half went nowhere and there was no Deleted Items to move to.
   */
  it("answers the refusal when no half of a mixed selection happened", async () => {
    transport("refuse");
    mount(OWN, { isAdmin: false, withGroup: true });
    useMail.setState({ mailboxes: {} as never });
    expect(await useMail.getState().trash(["e1"])).toEqual({
      ok: false,
      code: "server_refused",
    });
  });

  /**
   * A mixed selection is the case a single boolean would get wrong. `trash`
   * destroys what sits in Deleted Items or Junk Mail and files the rest, and in
   * a group only the first half is refused — so the answer has to be "something
   * happened", or a caller would undo a move that did happen.
   */
  it("still reports success when only part of a selection was refused", async () => {
    const s = transport();
    mount(GROUP, { isAdmin: false, withGroup: true });
    const outcome = await useMail.getState().trash(["e1", "e3"]);
    expect(outcome).toEqual({ ok: true });
    // e3 was filed into the group's Deleted Items; e1 was refused.
    expect(messages().join(" ")).toContain("installation administrator");
    expect(s.destroys).toEqual([]);
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
    const outcome = await useMail.getState().emptyMailbox(TRASH);
    expect(s.destroys).toEqual([]);
    expect(messages().join(" ")).toContain("installation administrator");
    expect(outcome).toEqual({ ok: false, code: "group_mail_empty" });
  });

  it("refuses deleting a group folder that holds mail, and allows an empty one", async () => {
    const s = transport();
    mount(GROUP, { isAdmin: false, withGroup: true });
    const refused = await useMail.getState().destroyMailbox(TRASH, true);
    expect(s.destroys).toEqual([]);
    expect(refused).toEqual({ ok: false, code: "group_mail_folder" });

    // An empty folder is not mail: the group's tree stays the group's to shape.
    mount(GROUP, { isAdmin: false, withGroup: true });
    const allowed = await useMail.getState().destroyMailbox("mbEmpty", true);
    expect(allowed).toEqual({ ok: true });
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

  /**
   * The direction a row is refused in does not move at all — the same treatment
   * a swipe out of the archive gets, and the reason is the same: a strip that
   * reveals an action it cannot take is worse than one that does not open.
   */
  it("resolves a swipe to nothing where the delete would be refused", () => {
    const offered = {
      role: "inbox",
      deleteEffect: "final" as const,
      deleteOffered: true,
      unread: false,
      starred: false,
    };
    expect(describeSwipe("delete", offered)?.label).toBe("Delete forever");
    expect(describeSwipe("delete", { ...offered, deleteOffered: false })).toBe(null);
    // And a direction that files is untouched by the rule, whatever the reader
    // may end: moving to Deleted Items is what a group's member still does.
    expect(
      describeSwipe("delete", {
        ...offered,
        deleteEffect: "move",
        deleteOffered: false,
      })?.label,
    ).toBe("Delete");
  });
});
