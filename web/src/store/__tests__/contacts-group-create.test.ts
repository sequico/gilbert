import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
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
