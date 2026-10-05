import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession, Mailbox, SieveScript } from "@/jmap/types";
import { newRule, rulesToSieve } from "@/lib/sieve";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { useSieve } from "@/store/sieve";
import { flushMicrotasks as flush } from "@/test/testkit";

/**
 * A folder moved in a group is not a folder the reader's own filters can name.
 *
 * The rules the client keeps are the reader's, in their own account, and a
 * `fileinto` path is resolved inside the script's own account — so a folder in
 * somebody else's tree cannot appear in one. Moving a folder in a group used to
 * retarget them anyway: the paths the group came back with were written into
 * the reader's script, pointing filters at destinations that exist only in the
 * group. Nothing about a group's folders is the reader's to retarget, and a
 * folder that left the group's tree is not a folder their rules ever filed
 * into, so the move is none of that module's business.
 *
 * The control is the honest half of the pair: the same move in the reader's own
 * account still follows the folder, which is the guarantee the retarget exists
 * for.
 */

type Tree = Record<string, Record<string, unknown>>;

const rights = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};

const box = (
  id: string,
  name: string,
  parentId: string | null,
  role: Mailbox["role"] = null,
): Mailbox =>
  ({
    id,
    name,
    parentId,
    role,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights: rights,
  }) as Mailbox;

/* The reader's own mailbox: Work > Invoices, the folder a rule files into. */
const ownTree = (): Tree => ({
  a: box("a", "Inbox", null, "inbox") as unknown as Record<string, unknown>,
  w: box("w", "Work", null) as unknown as Record<string, unknown>,
  i: box("i", "Invoices", "w") as unknown as Record<string, unknown>,
});

/* The group's: Inbox > MS2 > a case, the shape the mailing tool files into. */
const groupTree = (): Tree => ({
  a: box("a", "Inbox", null, "inbox") as unknown as Record<string, unknown>,
  l: box("l", "MS2", "a") as unknown as Record<string, unknown>,
  t: box("t", "277044606", "l") as unknown as Record<string, unknown>,
});

const SCRIPT: SieveScript = {
  id: "s1",
  name: "gilbert",
  isActive: true,
  blobId: "b1",
} as SieveScript;

const RULES = [
  newRule({
    id: "r1",
    name: "Invoices",
    actions: [{ type: "fileinto", mailbox: "Work/Invoices", mailboxId: "i" }],
  }),
  // The rule the bug wrote: a path that exists in the group, not in this account.
  newRule({
    id: "r2",
    name: "Cases",
    actions: [{ type: "fileinto", mailbox: "MS2/277044606" }],
  }),
];

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
        } else if (name === "SieveScript/set") {
          methodResponses.push([
            name,
            { accountId, oldState: "1", newState: "2", updated: { s1: null } },
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
              updated: {},
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

const sieveWrites = (calls: Array<{ name: string }>) =>
  calls.filter((c) => c.name === "SieveScript/set");

beforeEach(() => {
  client.session = SESSION;
  useSession.setState({ session: SESSION });
  /*
   * Saving rules uploads the new script as a blob first, and that upload is an
   * XHR rather than a fetch — so it is the one call the stub server cannot
   * answer, and the one thing here that has to be taken on trust.
   */
  vi.spyOn(client, "upload").mockResolvedValue({
    accountId: "own",
    blobId: "blob-1",
    type: "application/sieve",
    size: 128,
  } as never);
  useSieve.setState({
    accountId: "own",
    available: true,
    scripts: [SCRIPT],
    contents: { s1: rulesToSieve(RULES) },
    loading: false,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSieve.setState({ accountId: null, available: false, scripts: [], contents: {} });
  useMail.setState({ accountId: null, mailboxes: {} });
  useSession.setState({ status: "loading", session: null });
});

describe("moving a folder in a group mailbox", () => {
  it("leaves the reader's own filters alone", async () => {
    const trees = { gg: groupTree(), own: ownTree() };
    const calls = stubServer(trees);
    useMail.setState({ accountId: "gg", mailboxes: trees.gg as never });
    await useMail.getState().updateMailbox("t", { parentId: "a" });
    await flush();
    expect(sieveWrites(calls)).toEqual([]);
  });
});

describe("moving a folder in the reader's own mailbox", () => {
  it("still follows the folder, which is what the retarget is for", async () => {
    const trees = { gg: groupTree(), own: ownTree() };
    const calls = stubServer(trees);
    useMail.setState({ accountId: "own", mailboxes: trees.own as never });
    await useMail.getState().updateMailbox("i", { parentId: null });
    await flush();
    expect(sieveWrites(calls).length).toBe(1);
  });
});
