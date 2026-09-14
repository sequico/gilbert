import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Identity, JmapSession } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { IdentitiesSettings } from "../IdentitiesSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The person's own section, and the identity somebody else removed.
 *
 * The list this page is built on is the **server's**, and the administration
 * writes it by impersonating the account (ADR 0007) — from another session, or
 * in Stalwart's own administration, nothing of which this session hears about.
 * So the section reads it when it opens rather than trusting the copy the store
 * read at sign-in: a list read once and then believed shows an identity that no
 * longer exists, with a Delete button on it and a From option in the composer.
 * That is the report this file pins — deleting one's own identity from the
 * administration and still seeing it here.
 *
 * The test fails when the section goes back to reading only a missing cache
 * entry: the store holds a list with `gone` in it, the server's answer does not,
 * and only a section that asks finds out.
 */

const OWN = "own";
const ME = "me@example.org";

const identity = (id: string, name: string): Identity =>
  ({
    id,
    name,
    email: ME,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
  }) as Identity;

const SESSION = {
  accounts: {
    [OWN]: {
      name: ME,
      isPersonal: true,
      accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} },
    },
  },
  primaryAccounts: { [CAP.mail]: OWN, [CAP.submission]: OWN },
} as unknown as JmapSession;

const flush = async () => {
  await new Promise<void>((res) => setTimeout(res, 0));
  await new Promise<void>((res) => setTimeout(res, 0));
};

describe("the person's own identities section", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // What the server still holds: the identity the session is about to be
    // behind on is simply not in it.
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method !== "Identity/get") return {} as never;
      return {
        accountId: args.accountId,
        state: "1",
        list: [identity("o1", "Me")],
        notFound: [],
      } as never;
    });
    useSession.setState({ status: "authenticated", session: SESSION, accountId: OWN });
    await flush();
    useMail.setState({
      accountId: OWN,
      ownAccountId: OWN,
      mailAccounts: [{ accountId: OWN, name: ME, kind: "own" }],
      identities: [identity("o1", "Me")],
      // The session's copy, read at sign-in: it still carries `gone`.
      identitiesByAccount: { [OWN]: [identity("o1", "Me"), identity("gone", "Old")] },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
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

  it("reads the whole list when it opens, not only a missing cache entry", async () => {
    await act(async () => {
      root.render(<IdentitiesSettings />);
    });
    await act(async () => {
      await flush();
    });

    expect(host.textContent).not.toContain("Old");
    expect(host.textContent).toContain(ME);
  });
});

/**
 * The group block, and the one question it answers for a member: which of that
 * group's identities is theirs (ADR 0007).
 *
 * The assignment is the administration's, written from another session, so it
 * is read as this section opens rather than taken from whatever the store
 * happens to hold — a member who has just been assigned an identity should find
 * out here, and a member with none should be told what their mail goes out as
 * instead of being left to guess.
 */
describe("a group's identities in the member's own settings", () => {
  let host: HTMLDivElement;
  let root: Root;

  const GROUP = "team@example.org";
  const GROUP_ACCOUNT = "gg";
  const groupIdentity = (id: string, name: string): Identity =>
    ({ ...identity(id, name), email: GROUP }) as Identity;

  /** What the member-group route answers, as the section reads it. */
  let assignment: { assignedId: string | null; groupSenderId: string | null };

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    assignment = { assignedId: "g2", groupSenderId: "g1" };
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method !== "Identity/get") return {} as never;
      return {
        accountId: args.accountId,
        state: "1",
        list:
          String(args.accountId) === GROUP_ACCOUNT
            ? [groupIdentity("g1", "Team"), groupIdentity("g2", "Me")]
            : [identity("o1", "Me")],
        notFound: [],
      } as never;
    });
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/identities/assignment")) {
        return {
          ok: true,
          status: 200,
          statusText: "",
          json: async () => ({
            group: GROUP,
            assignedId: assignment.assignedId,
            groupSenderId: assignment.groupSenderId,
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "",
        json: async () => ({}),
      } as Response;
    });
    useSession.setState({
      status: "authenticated",
      session: {
        accounts: {
          ...SESSION.accounts,
          gg: {
            name: GROUP,
            isPersonal: false,
            accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} },
          },
        },
        primaryAccounts: { [CAP.mail]: OWN, [CAP.submission]: OWN },
      } as unknown as JmapSession,
      accountId: OWN,
    });
    await flush();
    useMail.setState({
      accountId: OWN,
      ownAccountId: OWN,
      mailAccounts: [
        { accountId: OWN, name: ME, kind: "own" },
        { accountId: GROUP_ACCOUNT, name: GROUP, kind: "group" },
      ],
      identities: [identity("o1", "Me")],
      identitiesByAccount: { [OWN]: [identity("o1", "Me")] },
      assignmentByAccount: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
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

  async function render() {
    await act(async () => {
      root.render(<IdentitiesSettings />);
    });
    /*
     * Both reads are awaited rather than tick-counted: the member-group route is
     * reached through a dynamic import, which resolves in its own time on the
     * first call, and a fixed number of ticks is a test that passes or fails by
     * the order the files happen to run in.
     */
    await act(async () => {
      await vi.waitFor(() => {
        if (!host.textContent?.includes("read-only here")) throw new Error("no block");
        if (!useMail.getState().assignmentByAccount[GROUP_ACCOUNT])
          throw new Error("assignment not read");
      });
    });
  }

  it("marks the identity assigned to the reader", async () => {
    await render();

    const text = host.textContent ?? "";
    expect(text).toContain("Yours");
    expect(text).toContain("You send as the one assigned to you");
    // Both of the group's identities are listed — the member reads them all,
    // which is what the block is for — and only theirs is marked.
    expect(text).toContain("Team");
  });

  it("says what the mail goes out as when nothing is assigned", async () => {
    // The state a member is in before the administration gets to them, and the
    // one the composer answers the same way: the group itself.
    assignment = { assignedId: null, groupSenderId: "g1" };
    await render();

    const text = host.textContent ?? "";
    expect(text).toContain("goes out as the group itself");
    expect(text).not.toContain("Yours");
  });

  it("reads the assignment again as the section opens", async () => {
    /*
     * The store may already hold an answer from an earlier visit, and the
     * administration writes from another session. A cached entry being the end
     * of it is how a member goes on being told they have no identity after
     * being given one.
     */
    useMail.setState({
      assignmentByAccount: {
        [GROUP_ACCOUNT]: { assignedId: "g1", groupSenderId: "g1" },
      },
    });
    await render();

    expect(host.textContent).toContain("You send as the one assigned to you");
  });
});
