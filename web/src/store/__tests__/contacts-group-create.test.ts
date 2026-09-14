import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";

/**
 * An address book made while acting for a group must be created in the
 * group's own account, exactly like a group calendar or task list: the group
 * owns it from the first second, every member reaches it through their
 * session on the account, and a member added later needs nothing patched.
 * These pins keep the group create on the group account and subscribed, and
 * the reader's own create unchanged (no isSubscribed flag needed there).
 */

function stubServer() {
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
        if (name === "AddressBook/set") {
          const created: Record<string, unknown> = {};
          for (const k of Object.keys((args.create as Record<string, unknown>) ?? {}))
            created[k] = { id: `n${k}` };
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              created,
              updated: {},
              destroyed: [],
              notCreated: {},
              notUpdated: {},
              notDestroyed: {},
            },
            id,
          ]);
        } else {
          methodResponses.push([
            name,
            { accountId: args.accountId, state: "1", list: [], notFound: [] },
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

beforeEach(() => {
  client.session = {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.contacts]: {},
    },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useContacts.setState({
    accountId: "a1",
    available: true,
    books: {},
    cards: {},
    loaded: false,
    loading: false,
    error: null,
    sharedBooks: [],
    sharedCards: {},
    sharedLoaded: false,
    selection: { accountId: null, bookId: "all" },
    principals: [],
    principalsLoaded: false,
    recent: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("creating an address book", () => {
  it("creates a group book in the group's own account, subscribed", async () => {
    const calls = stubServer();
    const id = await useContacts.getState().createBook("Team", "a2");
    expect(id).toBe("nb");
    const sets = calls.filter((c) => c.name === "AddressBook/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args.accountId).toBe("a2");
    expect(sets[0]?.args.create).toEqual({
      b: { name: "Team", isSubscribed: true },
    });
  });

  it("creates the reader's own book in their own account, as before", async () => {
    const calls = stubServer();
    await useContacts.getState().createBook("Private");
    const sets = calls.filter((c) => c.name === "AddressBook/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args.accountId).toBe("a1");
    expect(sets[0]?.args.create).toEqual({ b: { name: "Private" } });
  });
});

/**
 * Renaming one, which is the same question asked of a write.
 *
 * A book is written in the account that holds it, the way a card is: a group's
 * directory lives in the group's account, and the store's `accountId` is the
 * reader's own. Writing the group's book through that renamed a book of the
 * reader's, or nothing at all, while the sidebar showed the group's name
 * changed -- which is why this is pinned per account rather than per call
 * shape.
 */
describe("renaming an address book", () => {
  const rights = (mayWrite: boolean) => ({
    mayRead: true,
    mayWrite,
    mayShare: false,
    mayDelete: false,
  });
  const groupBook = {
    id: "gb1",
    name: "Team directory",
    description: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: false,
    shareWith: {},
    myRights: rights(true),
  } as unknown as AddressBook;

  it("writes a group's book in the group's own account", async () => {
    const calls = stubServer();
    useContacts.setState({
      accountId: "a1",
      books: {},
      sharedBooks: [{ accountId: "a2", accountName: "Team", book: groupBook }],
    });
    await useContacts.getState().updateBook("gb1", { name: "Freight directory" });
    const sets = calls.filter((c) => c.name === "AddressBook/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args.accountId).toBe("a2");
    expect(sets[0]?.args.update).toEqual({ gb1: { name: "Freight directory" } });
  });

  it("writes the reader's own book in their own account", async () => {
    const calls = stubServer();
    useContacts.setState({
      accountId: "a1",
      books: { b1: { ...groupBook, id: "b1", name: "Mine" } as unknown as AddressBook },
      sharedBooks: [],
    });
    await useContacts.getState().updateBook("b1", { name: "Personal" });
    const sets = calls.filter((c) => c.name === "AddressBook/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args.accountId).toBe("a1");
  });

  it("writes the group's book, not the reader's, when both carry the same id", async () => {
    /*
     * A book id is unique inside its account and nowhere else, and a default
     * book is seeded per account -- so the same id in both is the ordinary
     * case, not a curiosity. Resolving the bare id prefers the reader's own,
     * which renamed the wrong book; the caller that holds a row passes the
     * account it came from.
     */
    const calls = stubServer();
    useContacts.setState({
      accountId: "a1",
      books: { b1: { ...groupBook, id: "b1", name: "Mine" } as unknown as AddressBook },
      sharedBooks: [
        { accountId: "a2", accountName: "Team", book: { ...groupBook, id: "b1" } },
      ],
    });
    await useContacts.getState().updateBook("b1", { name: "Freight" }, "a2");
    const sets = calls.filter((c) => c.name === "AddressBook/set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args.accountId).toBe("a2");
    expect(sets[0]?.args.update).toEqual({ b1: { name: "Freight" } });
  });
});
