import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

/**
 * A group mailbox's address books answer in the composer and in "All
 * contacts" without each member adding the book first: membership of the
 * group is the subscription, exactly as Files treats a group's folders. A
 * stranger's book still stays out until the reader adds it -- this is the
 * guard that keeps unasked-for contacts out of the To field.
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
        if (name === "AddressBook/get") {
          const accountId = args.accountId;
          // The group account's book is unsubscribed: the old rule would have
          // skipped its cards entirely.
          const list =
            accountId === "e"
              ? [{ id: "bk1", name: "Team book", isSubscribed: false }]
              : [];
          methodResponses.push([name, { accountId, state: "1", list, notFound: [] }, id]);
        } else if (name === "ContactCard/query") {
          methodResponses.push([
            name,
            { accountId: args.accountId, state: "1", ids: ["c1"], notFound: [] },
            id,
          ]);
        } else if (name === "ContactCard/get") {
          methodResponses.push([
            name,
            {
              accountId: args.accountId,
              state: "1",
              list: [
                {
                  id: "c1",
                  addressBookIds: { bk1: { isReadOnly: false } },
                },
              ],
              notFound: [],
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

const SESSION = {
  accounts: {
    r: { name: "me@example.org", isPersonal: true },
    e: { name: "team@example.org", isPersonal: false },
  },
  primaryAccounts: { [CAP.contacts]: "r" },
  capabilities: {},
  state: "s1",
} as unknown as JmapSession;

beforeEach(() => {
  client.session = SESSION;
  useSession.setState({ session: SESSION });
  useMail.setState({
    mailAccounts: [{ accountId: "e", name: "team@example.org", kind: "group" }],
  });
  useContacts.setState({
    accountId: "r",
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
  useMail.setState({ mailAccounts: [] });
});

describe("shared contacts of a group mailbox", () => {
  it("loads a group book's cards without the book being added first", async () => {
    const calls = stubServer();
    await useContacts.getState().loadShared();
    expect(
      calls.some((c) => c.name === "AddressBook/get" && c.args.accountId === "e"),
    ).toBe(true);
    const st = useContacts.getState();
    expect(st.sharedBooks).toHaveLength(1);
    expect(st.sharedBooks[0]?.book.name).toBe("Team book");
    expect(st.sharedCards["e:c1"]?.id).toBe("c1");
    expect(st.sharedLoaded).toBe(true);
  });
});
