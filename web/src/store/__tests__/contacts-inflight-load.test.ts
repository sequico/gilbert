import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { AddressBook, ContactCard, JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

/*
 * Two races the contacts store has to lose gracefully.
 *
 * The first is the shared load's single flight: a writer that owns the write
 * must re-read past the load already in flight, or its change is answered by a
 * snapshot taken before it.
 *
 * The second is a sign-out during a load: an answer that lands afterwards must
 * be dropped rather than repopulated for whoever signs in next.
 */

const asBook = (id: string, name = id) => ({ id, name }) as unknown as AddressBook;

/** A session with the reader's own account and one shared with them. */
function session(shared = true): JmapSession {
  return {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.contacts]: {},
    },
    accounts: {
      own: {
        name: "Own",
        isPersonal: true,
        accountCapabilities: { [CAP.contacts]: {}, [CAP.mail]: {} },
      },
      ...(shared
        ? {
            g1: {
              name: "Team",
              isPersonal: false,
              accountCapabilities: { [CAP.contacts]: {} },
            },
          }
        : {}),
    },
    primaryAccounts: { [CAP.contacts]: "own", [CAP.mail]: "own" },
    state: "s1",
  } as unknown as JmapSession;
}

beforeEach(() => {
  client.session = session();
  useMail.setState({ mailAccounts: [{ accountId: "own", name: "Own", kind: "own" }] });
  useContacts.setState({ accountId: "own", available: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useSession.setState({ status: "anonymous", session: null, accountId: null });
});

describe("a write made while a shared load is in flight", () => {
  it("re-reads past the load so the write is not lost", async () => {
    // The directory route is not part of this test; a failure leaves it out.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no directory");
      }),
    );

    const books: Array<{ id: string; name: string }> = [{ id: "s1", name: "First" }];
    let addressBookGets = 0;
    const releases: Array<() => void> = [];
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "AddressBook/get") {
        addressBookGets += 1;
        // The snapshot is what the route would answer at call time.
        const snapshot = books.map((b) => asBook(b.id, b.name));
        if (addressBookGets === 1) await new Promise<void>((r) => releases.push(r));
        return { list: snapshot };
      }
      if (method === "AddressBook/set") return { updated: { s1: null } };
      return {};
    }) as never);
    vi.spyOn(client, "chain").mockImplementation(
      (async () =>
        new Map([
          ["q", [{ ids: [] }]],
          ["g", [{ list: [], state: "1" }]],
        ])) as never,
    );

    useSession.setState({
      status: "authenticated",
      session: session(),
      accountId: "own",
    });

    const first = useContacts.getState().loadShared();
    await vi.waitFor(() => expect(addressBookGets).toBe(1));

    // The server accepts a write and a second book now exists.
    books.push({ id: "s2", name: "Second" });
    const write = useContacts.getState().setBookSubscribed("g1", "s1", true);

    // The writer waits the in-flight load out; release it and let the writer's
    // own re-read land.
    await Promise.resolve();
    releases[0]!();
    await write;
    await first.catch(() => undefined);

    const ids = useContacts.getState().sharedBooks.map((b) => b.book.id);
    expect(ids).toContain("s2");
  });
});

describe("a contacts load that lands after a sign-out", () => {
  it("does not repopulate the own cards", async () => {
    const releases: Array<() => void> = [];
    vi.spyOn(client, "chain").mockImplementation((async () => {
      await new Promise<void>((r) => releases.push(r));
      return new Map([
        ["q", [{ ids: ["c1"], total: 1 }]],
        ["g", [{ list: [{ id: "c1" } as unknown as ContactCard], state: "1" }]],
      ]);
    }) as never);

    useSession.setState({
      status: "authenticated",
      session: session(false),
      accountId: "own",
    });

    const loading = useContacts.getState().loadAll();
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    useSession.setState({ status: "anonymous", session: null, accountId: null });
    releases[0]!();
    await loading;

    expect(useContacts.getState().cards).toEqual({});
    expect(useContacts.getState().loaded).toBe(false);
  });

  it("does not repopulate the shared books", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no directory");
      }),
    );
    const releases: Array<() => void> = [];
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "AddressBook/get") {
        await new Promise<void>((r) => releases.push(r));
        return { list: [asBook("s1")] };
      }
      return {};
    }) as never);

    useSession.setState({
      status: "authenticated",
      session: session(),
      accountId: "own",
    });

    const loading = useContacts.getState().loadShared();
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    useSession.setState({ status: "anonymous", session: null, accountId: null });
    releases[0]!();
    await loading;

    expect(useContacts.getState().sharedBooks).toEqual([]);
    expect(useContacts.getState().sharedLoaded).toBe(false);
  });
});
