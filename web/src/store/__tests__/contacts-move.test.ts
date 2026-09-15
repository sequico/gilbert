import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, ContactCard, Id, JmapSession } from "@/jmap/types";
import { sharedKey, useContacts } from "@/store/contacts";

/*
 * Moving a card between accounts must carry the reader's edits: a copy built
 * from what the store last fetched leaves edits sitting in the editor — a
 * renamed contact, a photo just uploaded — out of what reaches the server,
 * while the toast says "Contact moved". The calendar move has the same shape
 * and the calendar store fixes it by carrying the reader's changes into the
 * copy; here the editor hands the form object to `moveCardTo`, and these tests
 * pin that the copy is the card as edited, that the original is destroyed only
 * after the copy exists, and that a refused destroy keeps the source on screen.
 */

const BOOK = (id: string) =>
  ({
    id,
    name: id,
    myRights: { mayWrite: true, mayReadItems: true },
    isSubscribed: true,
    isDefault: false,
  }) as unknown as AddressBook;

const CARD: ContactCard = {
  id: "c1",
  "@type": "Card",
  version: "1.0",
  uid: "u1",
  kind: "individual",
  name: { "@type": "Name", full: "Old name" },
  emails: { e1: { "@type": "EmailAddress", address: "old@example.com" } },
  addressBookIds: { b1: true },
} as unknown as ContactCard;

/** A server that records every /set and answers gets with the last thing made. */
function stubServer(opts: { refuseDestroy?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let made: Record<string, unknown> = { ...CARD };
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
          const create = args.create as
            | Record<string, Record<string, unknown>>
            | undefined;
          const destroy = args.destroy as Id[] | undefined;
          const key = Object.keys(create ?? {})[0];
          if (key && create)
            made = { ...(create[key] as Record<string, unknown>), id: "new-c1" };
          const notDestroyed: Record<string, unknown> = {};
          if (opts.refuseDestroy && destroy?.length)
            notDestroyed[destroy[0]!] = { type: "forbidden", description: "Cannot" };
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              oldState: "1",
              newState: "2",
              created: key ? { [key]: { id: "new-c1" } } : {},
              updated: {},
              destroyed: opts.refuseDestroy ? [] : (destroy ?? []),
              notCreated: {},
              notUpdated: {},
              notDestroyed: notDestroyed,
            },
            id,
          ]);
        } else if (name === "ContactCard/get") {
          const ids = (args.ids as Id[]) ?? [];
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              list: ids.map((x) => ({ ...made, id: x })),
              notFound: [],
            },
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

const edited = {
  name: { "@type": "Name", full: "New name" },
  emails: {
    e1: { "@type": "EmailAddress", address: "new@example.com" },
  },
  media: {
    p1: {
      "@type": "Media",
      kind: "photo",
      blobId: "b-photo",
      mediaType: "image/jpeg",
    },
  },
} as unknown as Partial<ContactCard>;

const createBodies = (calls: Array<{ name: string; args: Record<string, unknown> }>) =>
  calls
    .filter((c) => c.name === "ContactCard/set" && c.args.create)
    .map((c) => (c.args.create as Record<string, Record<string, unknown>>).c!);

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
    books: { b1: BOOK("b1") },
    cards: { c1: CARD },
    loaded: true,
    principals: [],
    principalsLoaded: true,
    sharedBooks: [{ accountId: "a2", accountName: "Team", book: BOOK("s1") }],
    sharedCards: {},
    sharedLoaded: true,
    selection: { accountId: null, bookId: "all" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("moving a card to a book in another account", () => {
  it("files the edited card, not the cached copy, into the target book", async () => {
    const calls = stubServer();
    const newId = await useContacts.getState().moveCardTo("c1", "a1", "a2", "s1", edited);
    expect(newId).toBe("new-c1");
    expect(createBodies(calls)).toHaveLength(1);
    const body = createBodies(calls)[0]!;
    // The edits made it into the copy...
    expect(body.name).toEqual({ "@type": "Name", full: "New name" });
    expect((body.emails as { e1: { address: string } }).e1.address).toBe(
      "new@example.com",
    );
    expect(body.media).toBeDefined();
    // ...the copy's own identity is fresh (the target book replaces the
    // source's, never the other way round) and the card's uid survives...
    expect(body.id).toBeUndefined();
    expect(body.addressBookIds).toEqual({ s1: true });
    expect(body.uid).toBe("u1");
    // The copy goes to the target account, the original is destroyed after it.
    const create = calls.find((c) => c.name === "ContactCard/set" && c.args.create)!;
    expect(create.args.accountId).toBe("a2");
    const destroy = calls.find(
      (c) => c.name === "ContactCard/set" && !c.args.create && c.args.destroy,
    )!;
    expect(destroy.args.accountId).toBe("a1");
    expect(destroy.args.destroy).toEqual(["c1"]);
    // The source leaves the list only once the server says it is gone.
    expect(useContacts.getState().cards.c1).toBeUndefined();
    expect(useContacts.getState().sharedCards[sharedKey("a2", "new-c1")]).toBeDefined();
  });

  it("keeps an unchanged card whole when nothing was edited", async () => {
    const calls = stubServer();
    await useContacts.getState().moveCardTo("c1", "a1", "a2", "s1");
    const body = createBodies(calls)[0]!;
    expect(body.name).toEqual({ "@type": "Name", full: "Old name" });
    expect((body.emails as { e1: { address: string } }).e1.address).toBe(
      "old@example.com",
    );
    expect(body.uid).toBe("u1");
  });

  it("keeps the source card in the list when the destroy is refused", async () => {
    const calls = stubServer({ refuseDestroy: true });
    await expect(
      useContacts.getState().moveCardTo("c1", "a1", "a2", "s1", edited),
    ).rejects.toThrow(/could not be deleted/);
    // The copy exists (created on the server, and cached), and the original is
    // still listed because the server still holds it.
    expect(createBodies(calls)).toHaveLength(1);
    expect(useContacts.getState().cards.c1).toBe(CARD);
    expect(useContacts.getState().sharedCards[sharedKey("a2", "new-c1")]).toBeDefined();
  });

  it("moves a shared card into the reader's own book the same way", async () => {
    useContacts.setState({
      books: { b1: BOOK("b1") },
      cards: {},
      sharedBooks: [{ accountId: "a2", accountName: "Team", book: BOOK("s1") }],
      sharedCards: { [sharedKey("a2", "c2")]: { ...CARD, id: "c2" } },
    });
    const calls = stubServer();
    await useContacts
      .getState()
      .moveCardTo("c2", "a2", "a1", "b1", edited as Partial<ContactCard>);
    const create = calls.find((c) => c.name === "ContactCard/set" && c.args.create)!;
    expect(create.args.accountId).toBe("a1");
    const body = createBodies(calls)[0]!;
    expect(body.name).toEqual({ "@type": "Name", full: "New name" });
    const destroy = calls.find(
      (c) => c.name === "ContactCard/set" && !c.args.create && c.args.destroy,
    )!;
    expect(destroy.args.accountId).toBe("a2");
    expect(destroy.args.destroy).toEqual(["c2"]);
    // The shared source is gone from its cache; the copy is among the own cards.
    expect(useContacts.getState().sharedCards[sharedKey("a2", "c2")]).toBeUndefined();
    expect(useContacts.getState().cards["new-c1"]).toBeDefined();
  });
});
