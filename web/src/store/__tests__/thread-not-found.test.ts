import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useMail } from "@/store/mail";

/**
 * loadThread against a Thread/get that says the thread is not there.
 *
 * The failure mode under test is the deep link to a thread that was destroyed
 * on another device: Thread/get answers list: [] (notFound), and the loading
 * flag used to stay up for ever, which left ThreadView's spinner spinning
 * with no error to show. The not-found answer has to clear the flag and come
 * back as a rejection the view's catch can render.
 */

const THREAD = "t1";
const EMAIL = "e1";

/** A server that knows `threads` and hands `emails` back to every Email/get. */
function server(threads: Array<{ id: string; emailIds: string[] }>, emails: unknown[]) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "Thread/get") {
        const wanted = (args.ids as string[]) ?? [];
        return [
          name,
          {
            accountId: "a1",
            state: "s1",
            list: threads.filter((t) => wanted.includes(t.id)),
            notFound: wanted.filter((x) => !threads.some((t) => t.id === x)),
          },
          id,
        ];
      }
      if (name === "Email/get") {
        return [name, { accountId: "a1", state: "s1", list: emails, notFound: [] }, id];
      }
      return [
        name,
        { accountId: "a1", state: "s1", list: [], notFound: [], ids: [], total: 0 },
        id,
      ];
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ methodResponses, sessionState: "s1" }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  client.session = {
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.mail]: {},
    },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useMail.setState({
    accountId: "a1",
    emails: {},
    threads: {},
    loadingThreads: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadThread", () => {
  it("clears the loading flag and rejects when the thread is gone", async () => {
    // The state a deep link leaves behind: the thread was open, so its flag
    // is up, and the server no longer has it.
    server([], []);
    useMail.setState({ loadingThreads: { [THREAD]: true } } as never);
    await expect(useMail.getState().loadThread(THREAD)).rejects.toThrow(
      "This conversation no longer exists.",
    );
    // The flag came down with the error: ThreadView's spinner stops and its
    // catch renders the message instead.
    expect(useMail.getState().loadingThreads).toEqual({});
    expect(useMail.getState().threads[THREAD]).toBeUndefined();
    expect(useMail.getState().emails[EMAIL]).toBeUndefined();
  });

  it("still loads a thread the server has, clearing the flag on success", async () => {
    server(
      [{ id: THREAD, emailIds: [EMAIL] }],
      [{ id: EMAIL, mailboxIds: { mbInbox: true }, keywords: {} }],
    );
    useMail.setState({ loadingThreads: { [THREAD]: true } } as never);
    const emails = await useMail.getState().loadThread(THREAD);
    expect(emails.map((e) => e.id)).toEqual([EMAIL]);
    expect(useMail.getState().threads[THREAD]?.id).toBe(THREAD);
    expect(useMail.getState().loadingThreads).toEqual({});
  });
});
