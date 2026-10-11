import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, ContactCard, Id, JmapSession } from "@/jmap/types";
import { sharedKey, useContacts } from "@/store/contacts";
import { useSession } from "@/store/session";

/*
 * Merging two contacts writes the merged card and then destroys the one it
 * absorbed. The order is what keeps a failure safe: a refused destroy after a
 * successful write leaves the merged contact standing with both cards' facts in
 * it, and a write that fails first never reaches the destroy. These pin that
 * order, that the surviving card is the reader's own choice of values, and that
 * a refused destroy is reported rather than hidden.
 */

const BOOK = (id: string) =>
  ({
    id,
    name: id,
    myRights: { mayWrite: true, mayRead: true },
    isSubscribed: true,
    isDefault: false,
  }) as unknown as AddressBook;

const CARD_A: ContactCard = {
  id: "c1",
  "@type": "Card",
  version: "1.0",
  uid: "u1",
  kind: "individual",
  name: { "@type": "Name", full: "Ada Lovelace" },
  emails: { e1: { "@type": "EmailAddress", address: "ada@example.com" } },
  addressBookIds: { b1: true },
} as unknown as ContactCard;

const CARD_B: ContactCard = {
  id: "c2",
  "@type": "Card",
  version: "1.0",
  uid: "u2",
  kind: "individual",
  name: { "@type": "Name", full: "Ada Byron" },
  emails: { e1: { "@type": "EmailAddress", address: "ada.byron@example.com" } },
  phones: { p1: { "@type": "Phone", number: "+39000000" } },
  addressBookIds: { b1: true },
} as unknown as ContactCard;

const CARD_G: ContactCard = {
  id: "c3",
  "@type": "Card",
  version: "1.0",
  uid: "g1",
  kind: "group",
  name: { "@type": "Name", full: "Team" },
  members: { u2: true },
  addressBookIds: { b1: true },
} as unknown as ContactCard;

/** A server that records every call and answers the update and the destroy. */
function stubServer(opts: { refuseDestroy?: boolean; refuseUpdate?: boolean } = {}) {
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
        if (name === "ContactCard/set") {
          const update = args.update as
            | Record<string, Record<string, unknown>>
            | undefined;
          const destroy = args.destroy as Id[] | undefined;
          const updated: Record<string, unknown> = {};
          if (update) for (const key of Object.keys(update)) updated[key] = null;
          const notUpdated: Record<string, unknown> = {};
          if (opts.refuseUpdate && update)
            for (const key of Object.keys(update)) {
              notUpdated[key] = { type: "invalidProperties", description: "No" };
              delete updated[key];
            }
          const notDestroyed: Record<string, unknown> = {};
          if (opts.refuseDestroy && destroy?.length)
            notDestroyed[destroy[0]!] = { type: "forbidden", description: "Cannot" };
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              oldState: "1",
              newState: "2",
              created: {},
              updated,
              destroyed: opts.refuseDestroy ? [] : (destroy ?? []),
              notCreated: {},
              notUpdated,
              notDestroyed,
            },
            id,
          ]);
        } else if (name === "ContactCard/get") {
          methodResponses.push([
            name,
            { accountId: args.accountId, state: "1", list: [], notFound: [] },
            id,
          ]);
        } else {
          methodResponses.push([
            name,
            { accountId: args.accountId, state: "1", list: [], ids: [], total: 0 },
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

const updateBody = (calls: Array<{ name: string; args: Record<string, unknown> }>) => {
  const call = calls.find((c) => c.name === "ContactCard/set" && c.args.update);
  return (call?.args.update as Record<string, Record<string, unknown>> | undefined)?.c1;
};

beforeEach(() => {
  client.session = {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.contacts]: {},
    },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
    gilbert: { isAdmin: true },
  } as unknown as JmapSession;
  useSession.setState({ status: "authenticated", session: client.session });
  useContacts.setState({
    accountId: "a1",
    available: true,
    books: { b1: BOOK("b1") },
    cards: { c1: CARD_A, c2: CARD_B },
    loaded: true,
    principals: [],
    principalsLoaded: true,
    sharedBooks: [],
    sharedCards: {},
    sharedLoaded: true,
    selection: { accountId: null, bookId: "all" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSession.setState({ status: "loading", session: null, accountId: null });
});

describe("merging two contacts", () => {
  it("writes the merged card first, then destroys the one it absorbed", async () => {
    const calls = stubServer();
    await useContacts
      .getState()
      .mergeCards({ card: CARD_A, accountId: null }, { card: CARD_B, accountId: null });

    const write = calls.findIndex((c) => c.name === "ContactCard/set" && c.args.update);
    const destroy = calls.findIndex(
      (c) => c.name === "ContactCard/set" && !c.args.update && c.args.destroy,
    );
    expect(write).toBeGreaterThanOrEqual(0);
    expect(destroy).toBeGreaterThan(write);
    expect(calls[destroy]!.args.destroy).toEqual(["c2"]);
    expect(calls[destroy]!.args.accountId).toBe("a1");
  });

  it("combines the lists and takes the value chosen for a conflicting field", async () => {
    const calls = stubServer();
    await useContacts.getState().mergeCards(
      { card: CARD_A, accountId: null },
      { card: CARD_B, accountId: null },
      {
        name: "b",
      },
    );

    const body = updateBody(calls)!;
    expect(body.name).toEqual(CARD_B.name);
    const addresses = Object.values(body.emails as Record<string, { address: string }>)
      .map((e) => e.address)
      .sort();
    expect(addresses).toEqual(["ada.byron@example.com", "ada@example.com"]);
    expect(Object.keys(body.phones as Record<string, unknown>)).toHaveLength(1);
  });

  it("writes the merged card and keeps it when the destroy is refused", async () => {
    const calls = stubServer({ refuseDestroy: true });
    const result = await useContacts
      .getState()
      .mergeCards({ card: CARD_A, accountId: null }, { card: CARD_B, accountId: null });

    expect(result.destroyed).toBe(0);
    expect(result.refused).toBeDefined();
    // The write went through, carrying the merged fields...
    const body = updateBody(calls)!;
    expect(body).toBeDefined();
    expect(body.name).toEqual(CARD_A.name);
    expect(Object.keys(body.phones as Record<string, unknown>)).toHaveLength(1);
    // ...and the card the server still holds is still listed.
    expect(useContacts.getState().cards.c2).toBe(CARD_B);
  });

  it("never destroys when the write fails", async () => {
    const calls = stubServer({ refuseUpdate: true });
    await expect(
      useContacts
        .getState()
        .mergeCards({ card: CARD_A, accountId: null }, { card: CARD_B, accountId: null }),
    ).rejects.toThrow();
    expect(calls.some((c) => c.args.destroy)).toBe(false);
    expect(useContacts.getState().cards.c1).toBe(CARD_A);
    expect(useContacts.getState().cards.c2).toBe(CARD_B);
  });

  it("refuses a card against itself, or two cards of different accounts", async () => {
    stubServer();
    await expect(
      useContacts
        .getState()
        .mergeCards({ card: CARD_A, accountId: null }, { card: CARD_A, accountId: null }),
    ).rejects.toThrow(/cannot be merged/);
    await expect(
      useContacts
        .getState()
        .mergeCards({ card: CARD_A, accountId: null }, { card: CARD_B, accountId: "a2" }),
    ).rejects.toThrow(/cannot be merged/);
  });

  it("re-points a group's member from the absorbed uid to the survivor, before the destroy", async () => {
    useContacts.setState({ cards: { c1: CARD_A, c2: CARD_B, c3: CARD_G } });
    const calls = stubServer();
    await useContacts
      .getState()
      .mergeCards({ card: CARD_A, accountId: null }, { card: CARD_B, accountId: null });

    const updates = calls
      .filter((c) => c.name === "ContactCard/set" && c.args.update)
      .map((c) => c.args.update as Record<string, Record<string, unknown>>);
    expect(updates.find((u) => u.c3 !== undefined)?.c3?.members).toEqual({
      u2: null,
      u1: true,
    });
    // The re-point is written before the destroy, never after it.
    const repoint = calls.findIndex(
      (c) =>
        c.name === "ContactCard/set" &&
        c.args.update &&
        (c.args.update as Record<string, unknown>).c3 !== undefined,
    );
    const destroy = calls.findIndex(
      (c) => c.name === "ContactCard/set" && c.args.destroy,
    );
    expect(repoint).toBeGreaterThanOrEqual(0);
    expect(destroy).toBeGreaterThan(repoint);
  });

  it("names the account holding each card, so a group's merge acts on the group", async () => {
    const calls = stubServer();
    useContacts.setState({
      accountId: "a1",
      cards: {},
      sharedBooks: [{ accountId: "a2", accountName: "Team", book: BOOK("b1") }],
      sharedCards: {
        [sharedKey("a2", "c1")]: CARD_A,
        [sharedKey("a2", "c2")]: CARD_B,
      },
      sharedLoaded: true,
    });
    await useContacts
      .getState()
      .mergeCards({ card: CARD_A, accountId: "a2" }, { card: CARD_B, accountId: "a2" });

    const setCalls = calls.filter((c) => c.name === "ContactCard/set");
    expect(setCalls.every((c) => c.args.accountId === "a2")).toBe(true);
    expect(useContacts.getState().sharedCards[sharedKey("a2", "c2")]).toBeUndefined();
  });
});
