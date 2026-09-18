import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Identity, JmapSession } from "@/jmap/types";
import { deleteUserIdentity, saveUserIdentity } from "@/lib/identities";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { flushTwice as flush, identity } from "@/test/testkit";

/**
 * An administration write, and the list the person's own section goes on
 * showing.
 *
 * The administration writes identities through its own routes, and the server
 * makes the write by impersonating the account (ADR 0007) — so nothing in the
 * session that asked for it learns that the account changed. `useMail` holds
 * the list it read at sign-in, `IdentitiesSettings` is built on that list, and
 * the composer's From picker is built on it too: without the write saying so,
 * an identity the administrator removed stays on screen, and stays offered, for
 * the rest of the session. Reported live as "I delete one of my own identities
 * from the administration and Settings still shows it".
 *
 * Two mechanisms, and each test fails when its own is taken away:
 *
 *   - a write refreshes the lists the session holds (`afterIdentityWrite` ->
 *     `useMail.refreshIdentities`), because a write is what invalidates them
 *   - a read that was already on its way is spent rather than joined
 *     (`overtakeIdentities` -> the read's own generation), because its
 *     `Identity/get` was asked before the write and answers with the list from
 *     before it — putting the removed identity straight back
 */

const OWN = "own";
const GROUP = "gg";
const ME = "me@example.org";

const SESSION = {
  accounts: {
    [OWN]: {
      name: ME,
      isPersonal: true,
      accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} },
    },
    [GROUP]: {
      name: "team@example.org",
      isPersonal: false,
      accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} },
    },
  },
  primaryAccounts: { [CAP.mail]: OWN, [CAP.submission]: OWN },
} as unknown as JmapSession;

/** What the server answers for the reader's own account, as it changes. */
let ownList: Identity[] = [];

/** A gate the mock can hold the own account's `Identity/get` behind. */
let holdOwn: Array<() => void> | null = null;

/** One read is held, not the next: the refresh behind it has to answer. */
let holdUsed = false;

/** The routes the session asked for, so a test can say a write happened. */
let routes: string[] = [];

beforeEach(async () => {
  vi.restoreAllMocks();
  ownList = [identity("o1", "Me", ME), identity("o2", "Me at work", "work@example.org")];
  holdOwn = null;
  holdUsed = false;
  routes = [];
  vi.spyOn(client, "call").mockImplementation(async (method, args) => {
    /*
     * The answer is what the server held when it was *asked*. A read is held
     * below until the test releases it, and one that read the fixture after
     * the release would hand back a list from after the write -- which is the
     * whole state this file is about, and would make it untestable.
     */
    const answered = String(args.accountId) === OWN ? [...ownList] : [];
    if (
      holdOwn &&
      !holdUsed &&
      method === "Identity/get" &&
      String(args.accountId) === OWN
    ) {
      holdUsed = true;
      await new Promise<void>((res) => holdOwn?.push(res));
    }
    if (method !== "Identity/get") return {} as never;
    return {
      accountId: args.accountId,
      state: "1",
      list: answered,
      notFound: [],
    } as never;
  });
  vi.stubGlobal("fetch", async (input: unknown) => {
    routes.push(String(input));
    return {
      ok: true,
      status: 200,
      statusText: "",
      json: async () => ({ ok: true, id: "written" }),
    } as Response;
  });
  useSession.setState({ status: "authenticated", session: SESSION, accountId: OWN });
  // The store's own sign-in subscription opens the reader's own mailbox here;
  // let it settle before the fixture is placed, or its own setState lands after.
  await flush();
  await flush();
  await flush();
  routes = [];
  useMail.setState({
    accountId: OWN,
    ownAccountId: OWN,
    mailAccounts: [
      { accountId: OWN, name: ME, kind: "own" },
      { accountId: GROUP, name: "team@example.org", kind: "group" },
    ],
    identities: [],
    identitiesByAccount: {},
  });
  // The list as the session read it at sign-in: both identities are here.
  await useMail.getState().loadIdentitiesFor(OWN);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useSession.setState({ status: "loading", session: null, accountId: null });
  useMail.setState({
    accountId: null,
    ownAccountId: null,
    mailAccounts: [],
    identities: [],
    identitiesByAccount: {},
  });
});

describe("a write made from the administration", () => {
  it("leaves the removed identity out of the list the session holds", async () => {
    expect((useMail.getState().identitiesByAccount[OWN] ?? []).map((i) => i.id)).toEqual([
      "o1",
      "o2",
    ]);

    // The server is told to remove it, and its own list stops carrying it.
    ownList = [identity("o1", "Me", ME)];
    await deleteUserIdentity(ME, "o2");

    expect(routes.some((r) => r.includes("/api/admin/identities/user/delete"))).toBe(
      true,
    );
    // What Settings renders, and what the composer offers as a sender.
    expect((useMail.getState().identitiesByAccount[OWN] ?? []).map((i) => i.id)).toEqual([
      "o1",
    ]);
  });

  it("carries a rename through to the list the session holds", async () => {
    ownList = [
      identity("o1", "Robert B", ME),
      identity("o2", "Me at work", "work@example.org"),
    ];
    await saveUserIdentity(ME, "o1", { name: "Robert B" });

    const first = (useMail.getState().identitiesByAccount[OWN] ?? [])[0];
    expect(first?.name).toBe("Robert B");
  });
});

describe("a read already on its way when the write lands", () => {
  it("cannot put the pre-write list back", async () => {
    /*
     * The read is held, so the state the rule is about can be observed: its
     * `Identity/get` was asked while the identity still existed, and it answers
     * with a list holding it. Nothing joins it — it is spent — and the list the
     * write is followed by is the one that stands.
     */
    holdOwn = [];
    holdUsed = false;
    ownList = [
      identity("o1", "Me", ME),
      identity("o2", "Me at work", "work@example.org"),
    ];
    void useMail.getState().loadIdentitiesFor(OWN);
    await flush();

    ownList = [identity("o1", "Me", ME)];
    await useMail.getState().refreshIdentities();

    const waiting = holdOwn;
    holdOwn = null;
    for (const release of waiting ?? []) release();
    await flush();

    expect((useMail.getState().identitiesByAccount[OWN] ?? []).map((i) => i.id)).toEqual([
      "o1",
    ]);
  });
});
