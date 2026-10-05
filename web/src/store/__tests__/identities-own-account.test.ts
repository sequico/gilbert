import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Identity, JmapSession } from "@/jmap/types";
import { ownIdentityAccountId } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { flushTwice as flush, identity } from "@/test/testkit";

/**
 * The two views of one identity cache, and what binds a member to a group's
 * identity.
 *
 * Settings → Identities & signatures read `useMail.identities`, which the store
 * filled from `get().accountId` — the mailbox the reader was *browsing*. The
 * administration reads and writes the account that sends for the person
 * (`primaryAccounts[urn:ietf:params:jmap:submission]`, server/src/identityAdmin.ts),
 * so a reader with a group mailbox open edited the group's list under the
 * heading of their own — and a group mailbox's list is one identity per member.
 *
 * ADR 0007: a person's own list is the account that sends for them, and a
 * person's Settings addresses that account and no other. The From picker in a
 * group mailbox offers the identity the administration **assigned** to the
 * reader, and the group's own behind it — an assignment recorded in the group's
 * own app folder, not a display name compared on both sides.
 */

const OWN = "own";
const GROUP = "gg";

const OWN_LIST = [
  identity("o1", "Me", "me@example.org"),
  identity("o2", "Me at work", "work@example.org"),
];
const GROUP_LIST = [
  identity("g1", "Someone else", "team@example.org"),
  identity("g2", "Me", "team@example.org"),
];

/**
 * What the group's own assignment document says, as the server answers it: the
 * identity assigned to the person signed in. The group's own identity is not
 * part of that answer — it is step 2 of the cascade, derived here from this
 * group's list and its own address — so nothing below sets it.
 */
let assignment: { assignedId: string | null } = { assignedId: "g2" };

/** What the server answers with, per account, when a test renames something. */
let ownList: Identity[] = [];
let groupList: Identity[] = [];

const SESSION = {
  username: "me@example.org",
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

let calls: Array<{ method: string; accountId: unknown }>;

beforeEach(async () => {
  vi.restoreAllMocks();
  calls = [];
  ownList = OWN_LIST;
  groupList = GROUP_LIST;
  vi.spyOn(client, "call").mockImplementation(async (method, args) => {
    calls.push({ method, accountId: args.accountId });
    if (method !== "Identity/get") return {} as never;
    return {
      accountId: args.accountId,
      state: "1",
      list: String(args.accountId) === OWN ? ownList : groupList,
      notFound: [],
    } as never;
  });
  /*
   * The member-facing read behind the composer's cascade: answered in the shape
   * `GET /api/identities/assignment` gives it, without a server.
   */
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/identities/assignment")) {
      return {
        ok: true,
        status: 200,
        statusText: "",
        json: async () => ({
          group: "team@example.org",
          assignedId: assignment.assignedId,
        }),
      } as Response;
    }
    return { ok: true, status: 200, statusText: "", json: async () => ({}) } as Response;
  });
  assignment = { assignedId: "g2" };
  await flush();
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
    assignmentByAccount: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useSession.setState({ status: "loading", session: null, accountId: null });
  useMail.setState({
    accountId: null,
    ownAccountId: null,
    mailAccounts: [],
    identities: [],
    identitiesByAccount: {},
    assignmentByAccount: {},
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

  it("offers a group mailbox the identity assigned to the reader", async () => {
    await useMail.getState().loadIdentitiesFor(OWN);
    await useMail.getState().loadIdentitiesFor(GROUP);
    await useMail.getState().loadAssignmentFor(GROUP);

    // The assignment says g2; g1 is the group's own, and another member's.
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);
    // The cache still holds the group's whole list: Settings lists it
    // read-only, and the picker narrowing is not a fetch filter.
    expect(
      (useMail.getState().identitiesByAccount[GROUP] ?? []).map((i) => i.id),
    ).toEqual(["g1", "g2"]);
  });

  it("offers the group's own identity to a member nothing is assigned to", async () => {
    /*
     * The middle step of the cascade (ADR 0007), and the reason a member is
     * never stuck: an identity nobody is assigned is the group's own voice — the
     * one the agent sends as — so somebody the administration has not got to yet
     * writes as the group rather than being refused a sender. Never another
     * member's: g2 belongs to somebody, and g1 is what is offered.
     */
    assignment = { assignedId: null };
    await useMail.getState().loadIdentitiesFor(GROUP);
    await useMail.getState().loadAssignmentFor(GROUP);

    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g1"]);
  });

  it("shows the group's own identity, never nothing, until the assignment is read", async () => {
    /*
     * The read is a round trip, so there is a window where the group's list is
     * here and its assignment is not. An empty From in that window is not a
     * neutral state: the composer reports it as a group that holds no identity,
     * which is false. The group's own identity is step 2 of the cascade — what
     * the answer will be for a member nothing is assigned to — and it is what
     * stands in, computed by the same function from the same list.
     */
    await useMail.getState().loadIdentitiesFor(GROUP);
    expect(useMail.getState().assignmentByAccount[GROUP]).toBeUndefined();
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g1"]);
  });

  it("offers nothing when the group holds no identity at all", async () => {
    assignment = { assignedId: null };
    groupList = [];
    await useMail.getState().loadIdentitiesFor(GROUP);
    await useMail.getState().loadAssignmentFor(GROUP);

    // The one state with nothing to send as, and the only one the composer
    // reports.
    expect(useMail.getState().identities).toEqual([]);
  });

  it("moves with the assignment when the administration changes it", async () => {
    await useMail.getState().loadIdentitiesFor(GROUP);
    await useMail.getState().loadAssignmentFor(GROUP);
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);

    // The administration gives the reader the group's own identity, and the
    // writer refreshes this session's answer (ADR 0007): the next read is the
    // new one.
    assignment = { assignedId: "g1" };
    await useMail.getState().refreshIdentities();

    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g1"]);
  });

  it("reads the assignment again when a surface asks it to", async () => {
    /*
     * The assignment is written from **another** session — the administrator's —
     * so nothing pushes it here. A surface that showed it would go on saying
     * "nothing assigned" for the rest of the session if a cached entry were the
     * end of it, which is the same rule the person's own identity section
     * follows when it reads its list as it opens.
     */
    assignment = { assignedId: null };
    await useMail.getState().loadIdentitiesFor(GROUP);
    await useMail.getState().loadAssignmentFor(GROUP);
    // Assigned nothing, so the group's own stands in — and it is now cached.
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g1"]);

    assignment = { assignedId: "g2" };
    await useMail.getState().loadAssignmentFor(GROUP, { force: true });

    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);
  });

  it("is unmoved by a rename of the reader's own identity", async () => {
    /*
     * The reason the binding is a record: a display name is what a recipient
     * reads, and a binding kept in one breaks on a rename. The assignment is an
     * address, so renaming the reader's own identity leaves it exactly where it
     * was — which is the whole of what this change is for.
     */
    await useMail.getState().loadIdentitiesFor(OWN);
    await useMail.getState().loadIdentitiesFor(GROUP);
    await useMail.getState().loadAssignmentFor(GROUP);
    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);

    ownList = [identity("o1", "Someone else", "me@example.org")];
    await useMail.getState().loadIdentitiesFor(OWN);

    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);
  });

  it("answers which addresses are the reader's own from their own account, not the mailbox on screen", async () => {
    /*
     * `identities` is the account on screen, and in a group mailbox it is one
     * identity -- the sender there -- so a surface asking "which addresses are
     * mine?" is answered wrongly by it: the group's address, or nothing.
     * `ownIdentities` is that question's answer, and PrivacySettings (which
     * domains to trust for images), the recipient summary's "me" and the guest
     * list of a message made into an event all read it.
     */
    await useMail.getState().loadIdentitiesFor(OWN);
    await useMail.getState().loadIdentitiesFor(GROUP);
    await useMail.getState().loadAssignmentFor(GROUP);

    expect(useMail.getState().identities.map((i) => i.id)).toEqual(["g2"]);
    expect(
      useMail
        .getState()
        .ownIdentities()
        .map((i) => i.id),
    ).toEqual(["o1", "o2"]);

    // Empty rather than stale while that account's list is unknown: an account
    // with no identity read has no address to call its own.
    useMail.setState({ identitiesByAccount: {} });
    expect(useMail.getState().ownIdentities()).toEqual([]);
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
