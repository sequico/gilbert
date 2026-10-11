import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { flushMicrotasks as flush } from "@/test/testkit";
import { useToasts } from "@/ui/toast";

/**
 * A refused archive or spam answers `ok: false` (finding 1).
 *
 * `archive` and `spam` used to return nothing, so a caller read the ids'
 * folders back to guess whether anything had moved -- and a refused write
 * rolls its optimistic patch back through a refetch that has not landed yet
 * when the action returns, so the read-back said yes and the focus slid off a
 * row that was still here. Both now answer with the same `DeleteOutcome`
 * `trash` does, so the caller gates on the outcome and not on the state.
 */

const TREE = {
  mbInbox: { id: "mbInbox", name: "Inbox", role: "inbox", parentId: null },
  mbArchive: { id: "mbArchive", name: "Archive", role: "archive", parentId: null },
  mbJunk: { id: "mbJunk", name: "Junk Mail", role: "junk", parentId: null },
};

function seed(mailboxes: Record<string, unknown> = TREE) {
  useMail.setState({
    accountId: "a1",
    mailboxes: mailboxes as never,
    list: { mailboxId: "mbInbox", ids: ["e1"] } as never,
    threads: {},
    emails: {
      e1: {
        id: "e1",
        threadId: "t1",
        receivedAt: "2026-09-22T10:00:00Z",
        mailboxIds: { mbInbox: true },
      },
    } as never,
    selected: {},
  });
}

/**
 * The reads both paths need. `write` decides what `Email/set` does: `true`
 * accepts it, `false` refuses it the way a server does.
 */
function stubServer(write: boolean) {
  vi.spyOn(client, "call").mockImplementation((async (method: string) => {
    if (method === "Thread/get")
      return { accountId: "a1", state: "1", list: [{ id: "t1", emailIds: ["e1"] }] };
    if (method === "Email/set") {
      if (!write) throw new Error("refused");
      return { accountId: "a1", oldState: "1", newState: "2", updated: {} };
    }
    return { accountId: "a1", state: "1", list: [], notFound: [] };
  }) as never);
  vi.spyOn(client, "chain").mockResolvedValue(new Map() as never);
  vi.spyOn(client, "request").mockResolvedValue({ methodResponses: [] } as never);
}

beforeEach(() => {
  client.session = {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500, maxCallsInRequest: 16 },
      [CAP.mail]: {},
    },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useToasts.setState({ toasts: [] });
  seed();
});

afterEach(() => {
  vi.restoreAllMocks();
  useMail.setState({ emails: {}, threads: {}, list: null });
});

describe("archive answers with its outcome", () => {
  it("reports ok when the move went through", async () => {
    stubServer(true);
    await expect(useMail.getState().archive(["e1"])).resolves.toEqual({ ok: true });
  });

  it("reports a refusal when the write was refused", async () => {
    stubServer(false);
    await expect(useMail.getState().archive(["e1"])).resolves.toEqual({
      ok: false,
      code: "server_refused",
    });
    await flush();
  });

  it("reports a refusal when there is no Archive folder to file into", async () => {
    seed({ mbInbox: TREE.mbInbox, mbJunk: TREE.mbJunk });
    stubServer(true);
    await expect(useMail.getState().archive(["e1"])).resolves.toEqual({
      ok: false,
      code: "server_refused",
    });
  });
});

describe("spam answers with its outcome", () => {
  it("reports a refusal when the write was refused", async () => {
    stubServer(false);
    await expect(useMail.getState().spam(["e1"], true)).resolves.toEqual({
      ok: false,
      code: "server_refused",
    });
    await flush();
  });

  it("reports a refusal when there is no Junk Mail folder", async () => {
    seed({ mbInbox: TREE.mbInbox, mbArchive: TREE.mbArchive });
    stubServer(true);
    await expect(useMail.getState().spam(["e1"], true)).resolves.toEqual({
      ok: false,
      code: "server_refused",
    });
  });
});
