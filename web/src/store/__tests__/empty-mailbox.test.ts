import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { fakeJmapServer } from "@/test/jmapServer";
import { useToasts } from "@/ui/toast";

/**
 * Emptying a full folder back-references one Email/query straight into one
 * Email/set, so every id in the folder arrives in a single call. Stalwart
 * refuses the whole call over `maxObjectsInSet` with `requestTooLarge` — a
 * Deleted Items with 5192 messages in it cannot be emptied that way at all.
 */

const TRASH = "mbTrash";
const JUNK = "mbJunk";
const MAX = 500;

/** A server that holds `count` messages and enforces MAX objects per call. */
function server(count: number, opts: { refuseDestroy?: boolean; mailbox?: string } = {}) {
  const live = new Set(Array.from({ length: count }, (_, i) => `e${i}`));
  const destroyBatches: number[] = [];
  /* Everything the store refreshes afterwards; shape fits get and query. */
  const fallback = () => ({
    accountId: "a1",
    state: "1",
    list: [],
    notFound: [],
    ids: [],
    total: 0,
    queryState: "q",
    position: 0,
    canCalculateChanges: false,
  });
  const fake = fakeJmapServer()
    .on("Email/query", (call) => {
      if (
        (call.args.filter as { inMailbox?: string })?.inMailbox !==
        (opts.mailbox ?? TRASH)
      )
        return fallback();
      const limit = Math.min((call.args.limit as number) ?? 50, MAX);
      return {
        accountId: "a1",
        queryState: "q",
        canCalculateChanges: false,
        position: 0,
        ids: [...live].slice(0, limit),
        total: live.size,
      };
    })
    .on("Email/set", (call) => {
      const destroy = call.args.destroy as string[] | undefined;
      if (!Array.isArray(destroy)) return fallback();
      destroyBatches.push(destroy.length);
      if (opts.refuseDestroy)
        return {
          accountId: "a1",
          oldState: "1",
          newState: "2",
          destroyed: [],
          notDestroyed: Object.fromEntries(
            destroy.map((x) => [x, { type: "forbidden", description: "no" }]),
          ),
        };
      for (const x of destroy) live.delete(x);
      return {
        accountId: "a1",
        oldState: "1",
        newState: "2",
        destroyed: destroy,
        notDestroyed: {},
      };
    })
    .onError("Email/set", (call) => {
      const destroy = call.args.destroy as string[] | undefined;
      return Array.isArray(destroy) && destroy.length > MAX
        ? {
            type: "requestTooLarge",
            description:
              "The number of ids requested by the client exceeds the maximum number the server is willing to process in a single method call.",
          }
        : undefined;
    });
  return { live, destroyBatches, fake };
}

const messages = () => useToasts.getState().toasts.map((t) => t.message);

beforeEach(() => {
  /*
   * The account under test is the reader's own, which the delete rule has to be
   * able to prove (ADR 0015): the session names it, so this rig says what the
   * app's session always says before any action is taken. A rig that left the
   * account unnamed would be a group as far as the rule can tell.
   */
  client.session = {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: MAX, maxObjectsInSet: MAX },
      [CAP.mail]: {},
    },
    accounts: {
      a1: { name: "me@example.com", isPersonal: true, accountCapabilities: {} },
    },
    primaryAccounts: { [CAP.mail]: "a1" },
    state: "s1",
  } as unknown as JmapSession;
  useSession.setState({ session: client.session, status: "authenticated" });
  useMail.setState({
    accountId: "a1",
    mailboxes: {
      [TRASH]: { id: TRASH, role: "trash", name: "Deleted Items" },
      [JUNK]: { id: JUNK, role: "junk", name: "Junk Mail" },
      mbArchive: { id: "mbArchive", role: "archive", name: "Archive" },
    } as never,
    list: null,
    emails: {},
  });
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("emptyMailbox", () => {
  it("deletes a folder larger than maxObjectsInSet, one accepted batch at a time", async () => {
    const s = server(5192);
    await useMail.getState().emptyMailbox(TRASH);
    expect(Math.max(...s.destroyBatches)).toBeLessThanOrEqual(MAX);
    expect(s.live.size).toBe(0);
    expect(messages()).toContain("Deleted 5192 messages");
  });

  it("needs no batching when the folder already fits in one call", async () => {
    const s = server(12);
    await useMail.getState().emptyMailbox(TRASH);
    expect(s.destroyBatches).toEqual([12]);
    expect(messages()).toContain("Deleted 12 messages");
  });

  /**
   * Junk Mail is emptiable too, and the messages are destroyed rather than
   * moved to Deleted Items — routing spam through the bin on its way out
   * would leave the user with the same problem in a different folder.
   */
  it("empties Junk Mail, destroying rather than moving to Deleted Items", async () => {
    const s = server(1200, { mailbox: JUNK });
    await useMail.getState().emptyMailbox(JUNK);
    expect(s.live.size).toBe(0);
    expect(Math.max(...s.destroyBatches)).toBeLessThanOrEqual(MAX);
    expect(messages()).toContain("Deleted 1200 messages");
    // Nothing was moved anywhere: every mutating call was a destroy.
    const sets = s.fake.callsTo("Email/set").map((c) => c.args);
    expect(sets.length).toBeGreaterThan(0);
    for (const a of sets) {
      expect(Array.isArray(a.destroy)).toBe(true);
      expect(a.update).toBeUndefined();
    }
  });

  it("refuses a folder that is neither Deleted Items nor Junk Mail", async () => {
    const s = server(5192, { mailbox: "mbArchive" });
    const outcome = await useMail.getState().emptyMailbox("mbArchive");
    expect(s.destroyBatches).toEqual([]);
    expect(s.live.size).toBe(5192);
    expect(messages()).toContain("Only Deleted Items and Junk Mail can be emptied.");
    // Refused for the rule's own reason, and a caller must not read it as an
    // emptied folder.
    expect(outcome).toEqual({ ok: false, code: "not_final_folder" });
  });

  it("stops instead of looping when the server destroys nothing", async () => {
    const s = server(5192, { refuseDestroy: true });
    /*
     * Nothing went, so the folder is still full — and the answer says so rather
     * than leaving a caller to read silence as an emptied folder.
     */
    const outcome = await useMail.getState().emptyMailbox(TRASH);
    expect(s.destroyBatches).toHaveLength(1);
    expect(messages().some((m) => m.startsWith("Could not empty folder"))).toBe(true);
    expect(outcome).toEqual({ ok: false, code: "server_refused" });
    expect(s.live.size).toBe(5192);
  });
});

describe("destroy", () => {
  it("splits a selection bigger than maxObjectsInSet across calls", async () => {
    const s = server(1200);
    await useMail.getState().destroy(Array.from({ length: 1200 }, (_, i) => `e${i}`));
    expect(s.destroyBatches).toEqual([MAX, MAX, 200]);
    expect(s.live.size).toBe(0);
    expect(messages()).toContain("1200 messages deleted forever");
  });
});
