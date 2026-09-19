import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, ContactCard, Id, JmapSession } from "@/jmap/types";
import { sharedKey, useContacts } from "@/store/contacts";

/*
 * Deleting a whole selection, when that selection spans accounts.
 *
 * "All contacts" holds the reader's own cards and the cards of every group they
 * belong to, so one tick, shift-click or Select-all can name cards that live in
 * two accounts -- and `ContactCard/set` takes one account per call. Sending the
 * lot to the account of the selection's *first* id deleted nothing from the
 * others while the toast counted a deletion that had not happened.
 *
 * Both halves are asserted: each account is asked for its own cards, and what
 * the server confirmed is what leaves the cache it left from.
 */

const BOOK = (id: string) =>
  ({
    id,
    name: id,
    myRights: { mayWrite: true, mayReadItems: true },
    isSubscribed: true,
    isDefault: false,
  }) as unknown as AddressBook;

const card = (id: string, bookId: string) =>
  ({
    id,
    "@type": "Card",
    version: "1.0",
    uid: `u-${id}`,
    kind: "individual",
    name: { "@type": "Name", full: id },
    emails: {},
    addressBookIds: { [bookId]: true },
  }) as unknown as ContactCard;

/** A server that records every destroy and confirms exactly what it was given. */
function stubServer() {
  const destroys: Array<{ accountId: string; ids: Id[] }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses = body.methodCalls.map(([name, args, id]) => {
        const destroy = args.destroy as Id[] | undefined;
        if (name === "ContactCard/set" && destroy?.length)
          destroys.push({ accountId: String(args.accountId), ids: destroy });
        return [
          name,
          {
            accountId: args.accountId,
            oldState: "1",
            newState: "2",
            created: {},
            updated: {},
            destroyed: destroy ?? [],
            notCreated: {},
            notUpdated: {},
            notDestroyed: {},
          },
          id,
        ];
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ methodResponses, sessionState: "1" }),
      } as Response;
    }),
  );
  return destroys;
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
    accountId: "own",
    available: true,
    books: { b1: BOOK("b1") },
    cards: { c1: card("c1", "b1") },
    loaded: true,
    principals: [],
    principalsLoaded: true,
    sharedBooks: [
      { accountId: "grpA", accountName: "A", book: BOOK("ga1") },
      { accountId: "grpB", accountName: "B", book: BOOK("gb1") },
    ],
    sharedCards: {
      [sharedKey("grpA", "g1")]: card("g1", "ga1"),
      [sharedKey("grpB", "g2")]: card("g2", "gb1"),
    },
    sharedLoaded: true,
    selection: { accountId: null, bookId: "all" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deleting a selection that spans accounts", () => {
  it("asks each account for the cards it holds", async () => {
    const destroys = stubServer();
    const { destroyed } = await useContacts.getState().destroyCards(["c1", "g1", "g2"]);
    expect(destroyed).toBe(3);
    expect(destroys).toHaveLength(3);
    expect(destroys.find((d) => d.accountId === "own")!.ids).toEqual(["c1"]);
    expect(destroys.find((d) => d.accountId === "grpA")!.ids).toEqual(["g1"]);
    expect(destroys.find((d) => d.accountId === "grpB")!.ids).toEqual(["g2"]);
  });

  it("takes each confirmed card out of the cache it came from", async () => {
    stubServer();
    await useContacts.getState().destroyCards(["c1", "g1", "g2"]);
    const st = useContacts.getState();
    expect(st.cards.c1).toBeUndefined();
    expect(st.sharedCards[sharedKey("grpA", "g1")]).toBeUndefined();
    expect(st.sharedCards[sharedKey("grpB", "g2")]).toBeUndefined();
  });

  it("batches within one account rather than across them", async () => {
    /* The ceiling is what makes a big selection need more than one call, and it
       is the server's own number. Set to one so a group holding two cards needs
       two calls -- neither of which may carry the other account's card. */
    client.session = {
      ...client.session!,
      capabilities: {
        ...client.session!.capabilities,
        [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 1 },
      },
    } as unknown as JmapSession;
    useContacts.setState((s) => ({
      sharedCards: { ...s.sharedCards, [sharedKey("grpA", "g3")]: card("g3", "ga1") },
    }));
    const destroys = stubServer();
    await useContacts.getState().destroyCards(["c1", "g1", "g3", "g2"]);
    expect(destroys.filter((d) => d.accountId === "grpA")).toHaveLength(2);
    for (const d of destroys) {
      expect(d.ids).toHaveLength(1);
      // Every call carries cards of exactly one account.
      const held =
        d.accountId === "own" ? ["c1"] : d.accountId === "grpA" ? ["g1", "g3"] : ["g2"];
      for (const id of d.ids) expect(held).toContain(id);
    }
  });
});
