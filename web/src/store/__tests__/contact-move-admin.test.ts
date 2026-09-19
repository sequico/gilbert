import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, ContactCard, JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useSession } from "@/store/session";

/*
 * Who may move a card from one account to another (ADR 0018).
 *
 * A card lives in one account, and a group mailbox's card is the group's, so
 * moving one between accounts changes whose it is: it is an installation
 * administrator's, and nobody else's -- the same posture ADR 0015 takes for a
 * group's mail. What this pins is that the refusal is on the **write** and not
 * on the menu that offers it, so a form that changes a card's account is
 * refused too, and that a refusal reaches no server at all.
 *
 * The other half is the case the rule deliberately does not cover: filing a card
 * into another book of the **same** account is a filing change, and a member
 * does it in a group's directory every day.
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
  name: { "@type": "Name", full: "Ada Person" },
  emails: {},
  addressBookIds: { b1: true },
} as unknown as ContactCard;

/** A server that answers every call, counting what reached it. */
function stubServer() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses = body.methodCalls.map(([name, args, id]) => {
        calls.push({ name, args });
        return [
          name,
          {
            accountId: args.accountId,
            state: "1",
            list: [{ ...CARD, id: "new-c1" }],
            notFound: [],
            created: name === "ContactCard/set" ? { c: { id: "new-c1" } } : {},
            updated: {},
            destroyed: Array.isArray(args.destroy) ? args.destroy : [],
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
  return calls;
}

const session = (isAdmin: boolean) =>
  ({
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.contacts]: {},
    },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
    gilbert: { isAdmin },
  }) as unknown as JmapSession;

beforeEach(() => {
  client.session = session(false);
  useSession.setState({ status: "authenticated", session: client.session });
  useContacts.setState({
    accountId: "own",
    available: true,
    books: { b1: BOOK("b1") },
    cards: { c1: CARD },
    loaded: true,
    principals: [],
    principalsLoaded: true,
    sharedBooks: [{ accountId: "grp", accountName: "Team", book: BOOK("g1") }],
    sharedCards: {},
    sharedLoaded: true,
    selection: { accountId: null, bookId: "all" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("moving a contact between accounts (ADR 0018)", () => {
  it("refuses a non-administrator's move without asking any server", async () => {
    const calls = stubServer();
    await expect(
      useContacts.getState().moveCardTo("c1", "own", "grp", "g1"),
    ).rejects.toThrow(/installation administrator/);
    expect(calls).toEqual([]);
    // The card is still where it was, in the list that showed it.
    expect(useContacts.getState().cards.c1).toBe(CARD);
  });

  it("lets an administrator's move through, to the group's own account", async () => {
    client.session = session(true);
    useSession.setState({ session: client.session });
    const calls = stubServer();
    const newId = await useContacts.getState().moveCardTo("c1", "own", "grp", "g1");
    expect(newId).toBe("new-c1");
    const create = calls.find((c) => c.name === "ContactCard/set" && c.args.create)!;
    expect(create.args.accountId).toBe("grp");
    const destroy = calls.find(
      (c) => c.name === "ContactCard/set" && !c.args.create && c.args.destroy,
    )!;
    expect(destroy.args.accountId).toBe("own");
  });

  it("does not stand in the way of another book in the same account", async () => {
    // Not a move in the rule's sense, and a member files cards in a group's
    // directory this way every day: it is a patch, served without asking the
    // admin flag. The card is the group's to begin with, which is where such a
    // card lives.
    useContacts.setState({ cards: {}, sharedCards: { "grp:c1": CARD } });
    const calls = stubServer();
    const id = await useContacts.getState().moveCardTo("c1", "grp", "grp", "g2");
    expect(id).toBe("c1");
    const update = calls.find((c) => c.name === "ContactCard/set" && c.args.update)!;
    expect(update.args.accountId).toBe("grp");
  });
});
