import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Identity, JmapSession } from "@/jmap/types";
import { ownIdentityAccountId } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

/**
 * The bug this covers, and the rule that closes it.
 *
 * Settings → Identities & signatures read `useMail.identities`, which the store
 * filled from `get().accountId` — the mailbox the reader was *browsing*. The
 * administration reads and writes the account that sends for the person
 * (`primaryAccounts[urn:ietf:params:jmap:submission]`, server/src/identityAdmin.ts),
 * so a reader with a group mailbox open edited the group's list under the
 * heading of their own — and a group mailbox's list is one identity per member.
 *
 * ADR 0007: a person's own list is the account that sends for them, and a
 * person's Settings addresses that account and no other. Under it, one
 * read-only block per group, and the From picker in a group offers the reader
 * their own identity alone.
 */

const OWN = "own";
const GROUP = "gg";

const identity = (id: string, name: string, email: string): Identity =>
  ({
    id,
    name,
    email,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
  }) as Identity;

const OWN_LIST = [
  identity("o1", "Me", "me@example.org"),
  identity("o2", "Me at work", "work@example.org"),
];
const GROUP_LIST = [
  identity("g1", "Someone else", "team@example.org"),
  identity("g2", "Me", "team@example.org"),
];

/** What the server answers with, per account, when a test renames something. */
let ownList: Identity[] = [];
let groupList: Identity[] = [];

const SESSION = {
  accounts: {
    [OWN]: {
      name: "me@example.org",
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

const flush = async () => {
  await new Promise<void>((res) => setTimeout(res, 0));
  await new Promise<void>((res) => setTimeout(res, 0));
};

let calls: Array<{ method: string; accountId: unknown }>;

/**
 * A gate the mock can hold the reader's own list behind, so one test can watch
 * the view while that list is still in flight. `null` means no gate.
 */
let holdOwn: Array<() => void> | null = null;

beforeEach(async () => {
  vi.restoreAllMocks();
  calls = [];
  ownList = OWN_LIST;
  groupList = GROUP_LIST;
  vi.spyOn(client, "call").mockImplementation(async (method, args) => {
    calls.push({ method, accountId: args.accountId });
    if (holdOwn && method === "Identity/get" && String(args.accountId) === OWN)
      await new Promise<void>((res) => holdOwn?.push(res));
    if (method !== "Identity/get") return {} as never;
    return {
      accountId: args.accountId,
      state: "1",
      list: String(args.accountId) === OWN ? ownList : groupList,
      notFound: [],
    } as never;
  });
  useSession.setState({ status: "authenticated", session: SESSION, accountId: GROUP });
  /*
   * The store's own sign-in subscription runs on that state transition: it
   * opens the reader's own mailbox and probes the group's tree with
   * `Mailbox/get`. Let it settle before the fixture is placed, or its
   * `setAccount` and its probe's answer land afterwards and put the fixture
   * back where the store, not this file, wants it.
   */
  await flush();
  await flush();
  await flush();
  calls = [];
  useMail.setState({
    // The reader is reading the group's mail, which is the whole point: the
    // account on screen is not the account their identities live in.
    accountId: GROUP,
    ownAccountId: OWN,
    mailAccounts: [
      { accountId: OWN, name: "me@example.org", kind: "own" },
      { accountId: GROUP, name: "team@example.org", kind: "group" },
    ],
    identities: [],
    identitiesByAccount: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useSession.setState({ status: "loading", session: null, accountId: null });
  useMail.setState({
    accountId: null,
    ownAccountId: null,
    mailAccounts: [],
    identities: [],
    identitiesByAccount: {},
  });
});

describe("the two views of one cache", () => {
  it("holds the reader's own list under the account that sends for them", async () => {
    const ownId = ownIdentityAccountId(useSession.getState().session);
    expect(ownId).toBe(OWN);

    await useMail.getState().loadIdentitiesFor(OWN);
    await useMail.getState().loadIdentitiesFor(GROUP);

    // What Settings reads for the reader's own block: their own account's
    // identities, whatever mailbox is open.
    expect(
      (useMail.getState().identitiesByAccount[ownId!] ?? []).map((i) => i.id),
    ).toEqual(["o1", "o2"]);
    // The default Settings marks, read from that same account.
    expect(useMail.getState().defaultIdentityFor(ownId)?.id).toBe("o1");
  });

  it("offers a group mailbox only the reader's own identity", async () => {
    await useMail.getState().loadIdentitiesFor(OWN);
    await useMail.getState().loadIdentitiesFor(GROUP);

    // g2 carries the reader's name; g1 is another member's.
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);
    // The cache still holds the group's whole list: Settings lists it
    // read-only, and the picker narrowing is not a fetch filter.
    expect(
      (useMail.getState().identitiesByAccount[GROUP] ?? []).map((i) => i.id),
    ).toEqual(["g1", "g2"]);
  });

  it("offers one identity, never the whole membership, while the reader's own list is in flight", async () => {
    // Held, so the state this rule is about can be observed: nobody's name is
    // here to match, and the account's own default stands in -- one identity.
    holdOwn = [];
    useMail.setState({ identitiesByAccount: {} });
    try {
      await useMail.getState().loadIdentitiesFor(GROUP);
      expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g1"]);
    } finally {
      const waiting = holdOwn;
      holdOwn = null;
      for (const release of waiting) release();
    }

    // Once the reader's own list lands, the view is theirs.
    await flush();
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);
  });

  it("recomputes the view when the reader's own list changes", async () => {
    await useMail.getState().loadIdentitiesFor(OWN);
    await useMail.getState().loadIdentitiesFor(GROUP);
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);

    // The name binding is the display name, so a rename in the reader's own
    // account is a different identity of the group's.
    ownList = [identity("o1", "Someone else", "me@example.org")];
    await useMail.getState().loadIdentitiesFor(OWN);

    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g1"]);
  });

  it("empties the group's view when no name in it is the reader's", async () => {
    await useMail.getState().loadIdentitiesFor(OWN);
    await useMail.getState().loadIdentitiesFor(GROUP);
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);

    // The reader's own list is here and carries no name any member of the
    // group has, so there is nothing of theirs to send as -- and somebody
    // else's identity is never offered in their place.
    ownList = [identity("o1", "Nobody", "me@example.org")];
    await useMail.getState().loadIdentitiesFor(OWN);

    expect(useMail.getState().identities).toEqual([]);
    // The cache still holds the group's whole list: Settings lists it
    // read-only, and the picker narrowing is not a fetch filter.
    expect(
      (useMail.getState().identitiesByAccount[GROUP] ?? []).map((i) => i.id),
    ).toEqual(["g1", "g2"]);
  });
});

describe("where a write goes", () => {
  it("writes a new identity into the account that sends for the reader", async () => {
    await useMail.getState().saveIdentity(null, { name: "Me", email: "me@example.org" });

    const sets = calls.filter((c) => c.method === "Identity/set");
    expect(sets.map((c) => c.accountId)).toEqual([OWN]);
    // And the list it reloads afterwards is that account's, not the group's.
    expect(calls.some((c) => c.method === "Identity/get" && c.accountId === OWN)).toBe(
      true,
    );
  });

  it("destroys from the account that sends for the reader", async () => {
    await useMail.getState().destroyIdentity("o2");

    expect(
      calls.filter((c) => c.method === "Identity/set").map((c) => c.accountId),
    ).toEqual([OWN]);
  });

  it("says so rather than writing anywhere when there is no session", async () => {
    useSession.setState({ session: null });
    await expect(useMail.getState().saveIdentity(null, { name: "x" })).rejects.toThrow(
      "Not signed in",
    );
    // Nothing was written. The sign-in subscription still reacts to the
    // session going away -- that is the store's own wiring, not this write.
    expect(calls.filter((c) => c.method === "Identity/set")).toEqual([]);
  });
});
