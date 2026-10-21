import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useSession } from "@/store/session";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { fakeJmapServer } from "@/test/jmapServer";

/*
 * Saving the people you write to as contacts. What has to hold: only addresses
 * no card holds yet are added, never the sender's own; the book is created once
 * and remembered by id, and replaced when it has been deleted; and nothing is
 * collected while a group's mailbox is the account in view -- the books that
 * store holds are that account's, and a reader's correspondents belong in
 * their own.
 */

const SESSION = {
  accounts: {
    r: { name: "me@example.org", isPersonal: true },
    g: { name: "team@example.org", isPersonal: false },
  },
  primaryAccounts: { [CAP.contacts]: "r" },
  capabilities: {},
  state: "s1",
} as unknown as JmapSession;

function server() {
  return fakeJmapServer()
    .on("AddressBook/set", () => ({
      accountId: "r",
      oldState: "1",
      newState: "2",
      created: { b: { id: "bk-collected" } },
      notCreated: null,
    }))
    .on("AddressBook/get", () => ({
      accountId: "r",
      state: "1",
      list: [{ id: "bk-collected", name: "Collected" }],
      notFound: [],
    }))
    .on("ContactCard/set", (call) => {
      const create = (call.args.create ?? {}) as Record<string, unknown>;
      return {
        accountId: "r",
        oldState: "1",
        newState: "2",
        created: Object.fromEntries(
          Object.keys(create).map((k) => [k, { id: `k-${k}` }]),
        ),
        notCreated: null,
      };
    });
}

beforeEach(() => {
  client.session = SESSION;
  useSession.setState({ session: SESSION });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useContacts.setState({
    accountId: "r",
    available: true,
    books: {},
    cards: {},
    loaded: true,
    loading: false,
    error: null,
    sharedBooks: [],
    sharedCards: {},
    sharedLoaded: false,
    selection: { accountId: null, bookId: "all" },
    principals: [],
    principalsLoaded: true,
    recent: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("collecting the people written to", () => {
  it("adds only addresses no card holds, never the sender's own", async () => {
    const calls = server();
    useContacts.setState({
      cards: {
        c1: {
          id: "c1",
          emails: { e: { address: "known@example.com" } },
        } as never,
      },
    });

    const created = await useContacts.getState().collectRecipients(
      [
        { name: "New Person", email: "new@example.com" },
        { name: "Known", email: "known@example.com" },
        { name: "Me", email: "me@example.org" },
        { name: "New again", email: "NEW@example.com" },
      ],
      ["me@example.org"],
    );

    expect(created).toBe(1);
    const set = calls.callsTo("ContactCard/set")[0]!;
    const create = set.args.create as Record<
      string,
      { emails: Record<string, { address: string }> }
    >;
    expect(Object.values(create)).toHaveLength(1);
    expect(Object.values(Object.values(create)[0]!.emails)[0]!.address).toBe(
      "new@example.com",
    );
  });

  it("creates the book once and remembers it in the synced settings", async () => {
    const calls = server();
    await useContacts
      .getState()
      .collectRecipients([{ name: null, email: "new@example.com" }], []);
    expect(useSettings.getState().settings.collectedBookId).toBe("bk-collected");

    useContacts.setState({
      books: { "bk-collected": { id: "bk-collected", name: "Collected" } } as never,
    });
    await useContacts
      .getState()
      .collectRecipients([{ name: null, email: "another@example.com" }], []);
    expect(calls.callsTo("AddressBook/set")).toHaveLength(1);
    expect(calls.callsTo("ContactCard/set")).toHaveLength(2);
  });

  it("replaces a book that has been deleted", async () => {
    const calls = server();
    useSettings.setState((s) => ({
      settings: { ...s.settings, collectedBookId: "bk-gone" },
    }));
    await useContacts
      .getState()
      .collectRecipients([{ name: null, email: "new@example.com" }], []);
    expect(calls.callsTo("AddressBook/set")).toHaveLength(1);
    expect(useSettings.getState().settings.collectedBookId).toBe("bk-collected");
  });

  it("collects nothing while a group's mailbox is the account in view", async () => {
    const calls = server();
    useContacts.setState({ accountId: "g" });
    const created = await useContacts
      .getState()
      .collectRecipients([{ name: null, email: "new@example.com" }], []);
    expect(created).toBe(0);
    expect(calls.callsTo("ContactCard/set")).toHaveLength(0);
  });
});
