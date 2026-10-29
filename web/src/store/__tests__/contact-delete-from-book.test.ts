import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, ContactCard, Id, JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { fakeJmapServer } from "@/test/jmapServer";

/*
 * Deleting from a book is that book's deletion.
 *
 * A contact may be filed in several books of one account, so a Delete made while
 * a book is open must say what it means: the card leaves **this** book, and only
 * a card that lives here alone is destroyed. Destroying the object would take it
 * out of every book at once, which is what a merge and the card on screen mean,
 * and what an id-less destroy cannot be trusted to avoid.
 */

const BOOK = (id: string) =>
  ({
    id,
    name: id,
    myRights: { mayWrite: true, mayReadItems: true },
    isSubscribed: true,
    isDefault: false,
  }) as unknown as AddressBook;

const card = (id: string, ...bookIds: string[]) =>
  ({
    id,
    "@type": "Card",
    version: "1.0",
    uid: `u-${id}`,
    kind: "individual",
    name: { "@type": "Name", full: id },
    emails: {},
    addressBookIds: Object.fromEntries(bookIds.map((b) => [b, true])),
  }) as unknown as ContactCard;

/** Every write the server is asked for, in one place. */
function stubServer() {
  const calls: Array<{
    accountId: string;
    update: Record<string, unknown>;
    destroy: Id[];
  }> = [];
  fakeJmapServer().on("ContactCard/set", (call) => {
    const update = (call.args.update as Record<string, unknown>) ?? {};
    const destroy = (call.args.destroy as Id[]) ?? [];
    calls.push({ accountId: String(call.args.accountId), update, destroy });
    return {
      accountId: call.args.accountId,
      oldState: "1",
      newState: "2",
      created: {},
      updated: Object.fromEntries(Object.keys(update).map((id) => [id, null])),
      destroyed: destroy,
      notCreated: {},
      notUpdated: {},
      notDestroyed: {},
    };
  });
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
    accountId: "own",
    available: true,
    books: { b1: BOOK("b1"), b2: BOOK("b2") },
    cards: {
      shared: card("shared", "b1", "b2"),
      only: card("only", "b1"),
    },
    loaded: true,
    principals: [],
    principalsLoaded: true,
    sharedBooks: [],
    sharedCards: {},
    sharedLoaded: true,
    selection: { accountId: null, bookId: "b1" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deleting from the book that is open", () => {
  it("takes a card filed elsewhere out of this book instead of destroying it", async () => {
    const calls = stubServer();
    const r = await useContacts.getState().destroyCards(
      [
        { id: "shared", accountId: null },
        { id: "only", accountId: null },
      ],
      "b1",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.update).toEqual({ shared: { "addressBookIds/b1": null } });
    expect(calls[0]!.destroy).toEqual(["only"]);
    expect(r).toMatchObject({ destroyed: 1, unfiled: 1 });
  });

  it("leaves the card it kept in the book it kept it in, and drops the other", async () => {
    stubServer();
    await useContacts.getState().destroyCards(
      [
        { id: "shared", accountId: null },
        { id: "only", accountId: null },
      ],
      "b1",
    );
    const { cards } = useContacts.getState();
    expect(cards.shared?.addressBookIds).toEqual({ b2: true });
    expect(cards.only).toBeUndefined();
  });

  it("destroys whatever it is given when no book is named", async () => {
    const calls = stubServer();
    await useContacts.getState().destroyCards([{ id: "shared", accountId: null }]);
    expect(calls[0]!.update).toEqual({});
    expect(calls[0]!.destroy).toEqual(["shared"]);
  });
});
