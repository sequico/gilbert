// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Identity, Mailbox } from "@/jmap/types";
import { useMail } from "@/store/mail";

/**
 * Switching account, and a read that fails while it happens.
 *
 * A folder click in another account's tree is a switch. The tree is what the
 * screen needs; the identities serve the composer and fall back to the account's
 * own. A failed `Identity/get` used to reject the whole switch, which reached
 * every caller that fires one without awaiting it (the mail route, a click) as
 * an unhandled rejection — what a `Failed to fetch` blip looked like on a
 * switch.
 */

const OWN = "own";
const GROUP = "gg";

const inbox = (id: string): Mailbox =>
  ({
    id,
    name: "Inbox",
    role: "inbox",
    isSubscribed: true,
    totalEmails: 0,
    unreadEmails: 0,
  }) as unknown as Mailbox;

const identity = (id: string): Identity =>
  ({ id, name: "Team", email: "team@example.org" }) as unknown as Identity;

/** A mailbox that answers, an identity read that never does. */
const unreachableIdentities = () =>
  vi.spyOn(client, "call").mockImplementation((async (method: string) => {
    if (method === "Mailbox/get") return { list: [inbox("g-inbox")], state: "s1" };
    if (method === "Identity/get") throw new TypeError("Failed to fetch");
    return { list: [], state: "s", notFound: [] };
  }) as never);

beforeEach(() => {
  useMail.setState({
    accountId: OWN,
    ownAccountId: OWN,
    mailAccounts: [
      { accountId: OWN, name: "me@example.org", kind: "own" },
      { accountId: GROUP, name: "team@example.org", kind: "group" },
    ],
    accountTrees: {},
    mailboxes: {},
    mailboxesLoaded: true,
    identities: [],
    identitiesByAccount: {},
    quotas: [],
    quotaAccountId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("switching account", () => {
  it("opens the account even when its identities cannot be read", async () => {
    unreachableIdentities();

    await expect(useMail.getState().openAccount(GROUP)).resolves.toBeUndefined();

    const state = useMail.getState();
    expect(state.accountId).toBe(GROUP);
    expect(state.mailboxesLoaded).toBe(true);
    expect(state.mailboxes["g-inbox"]?.name).toBe("Inbox");
  });

  it("keeps the identities it already had when a read fails on its own", async () => {
    // No switch here: `setAccount` empties the per-account caches, so what this
    // pins is the read a surface makes for an account it is already on.
    useMail.setState({ identitiesByAccount: { [GROUP]: [identity("g1")] } });
    unreachableIdentities();

    await useMail.getState().loadIdentitiesFor(GROUP);

    expect(useMail.getState().identitiesByAccount[GROUP]).toEqual([identity("g1")]);
  });
});
