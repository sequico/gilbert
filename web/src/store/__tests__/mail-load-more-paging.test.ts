import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Email, EmailFilter } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

/**
 * Loading the next page of a moving window.
 *
 * A page asked for at a bare `position` is the next page only of the window
 * the first one read. When the server's query state has moved -- a message
 * arrived while the reader was scrolling -- that position no longer continues
 * what is on screen, and appending silently skips whatever moved into the gap.
 * These tests pin the two things that keep the window honest: the stored
 * `queryState` decides whether a page is joined or the window is read again,
 * and a full read makes a page already on its way drop its answer.
 */

const email = (id: string): Email =>
  ({
    id,
    threadId: id,
    mailboxIds: { mb1: true },
    keywords: {},
  }) as unknown as Email;

const query = (ids: string[], queryState: string) => ({
  ids,
  total: 4,
  queryState,
});

/** A page answer: the query result and the messages it named. */
const answer = (ids: string[], queryState: string) =>
  new Map([
    ["q", [query(ids, queryState)]],
    ["e", [{ list: ids.map(email) }]],
  ]) as never;

function listOn(ids: string[], queryState: string): void {
  useMail.setState({
    accountId: "a1",
    emails: Object.fromEntries(ids.map((id) => [id, email(id)])),
    threads: {},
    fullIds: {},
    list: {
      key: "k",
      filter: {} as EmailFilter,
      sort: [],
      collapseThreads: false,
      mailboxId: "mb1",
      label: undefined,
      ids,
      total: 4,
      queryState,
      loading: false,
      loadingMore: false,
      error: null,
      exhausted: false,
    },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  useMail.setState({ emails: {}, threads: {}, list: null });
});

describe("the window moved between pages", () => {
  it("re-reads the window instead of appending a page from the old one", async () => {
    listOn(["a", "b"], "q1");
    const chain = vi
      .spyOn(client, "chain")
      // The page the reader asked for belongs to the window that moved...
      .mockResolvedValueOnce(answer(["c", "d"], "q2"))
      // ...so the window is read again from the top instead.
      .mockResolvedValueOnce(answer(["a", "b"], "q2"));

    await useMail.getState().loadMore();

    expect(chain).toHaveBeenCalledTimes(2);
    expect(useMail.getState().list?.ids).toEqual(["a", "b"]);
    expect(useMail.getState().list?.queryState).toBe("q2");
  });

  it("appends the next page when the window is the one it belongs to", async () => {
    listOn(["a", "b"], "q1");
    vi.spyOn(client, "chain").mockResolvedValue(answer(["c", "d"], "q1"));

    await useMail.getState().loadMore();

    expect(useMail.getState().list?.ids).toEqual(["a", "b", "c", "d"]);
  });
});

describe("a delete racing the window's own read", () => {
  /*
   * The query was computed before the delete reached the server, so its answer
   * still names the message the reader just removed. The generation the read
   * was issued under is what the answer is checked against, and `destroy` moves
   * it -- so the answer is dropped rather than putting the row back.
   */
  it("drops the read's answer instead of putting the message back", async () => {
    listOn(["a", "b"], "q1");
    useSession.setState({
      session: { accounts: {}, primaryAccounts: {}, gilbert: { isAdmin: true } } as never,
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    vi.spyOn(client, "chain").mockImplementation((async () => {
      await gate;
      return answer(["a", "b", "gone"], "q1");
    }) as never);
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Email/set") return { destroyed: ["gone"] };
      return { list: [], state: "s1", notFound: [] };
    }) as never);

    const read = useMail.getState().refreshList();
    await useMail.getState().destroy(["gone"]);
    release();
    await read;

    expect(Object.keys(useMail.getState().emails).sort()).toEqual(["a", "b"]);
    expect(useMail.getState().list?.ids).toEqual(["a", "b"]);
  });
});

describe("a full read racing a page", () => {
  it("lets the full read win and drops the page still on its way", async () => {
    listOn(["a", "b"], "q1");
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let calls = 0;
    vi.spyOn(client, "chain").mockImplementation((async () => {
      calls += 1;
      // The page the reader asked for is slow; the full read is not.
      if (calls === 1) {
        await gate;
        return answer(["c", "d"], "q1");
      }
      return answer(["a", "b"], "q1");
    }) as never);

    const more = useMail.getState().loadMore();
    const refresh = useMail.getState().refreshList();
    await refresh;
    release();
    await more;

    expect(useMail.getState().list?.ids).toEqual(["a", "b"]);
    expect(useMail.getState().list?.loadingMore).toBe(false);
  });
});

describe("a change that takes rows off the screen racing a page", () => {
  /*
   * The page sets `loadingMore`, and the window it was paging is left on screen
   * when the page is dropped. Nothing else brings that flag down -- the next
   * page is gated on it and the footer spinner is drawn from it -- so a page
   * dropped without clearing it is a window that never pages again.
   */
  it("brings the page's flag down when a delete overtakes it", async () => {
    listOn(["a", "b"], "q1");
    useSession.setState({
      session: { accounts: {}, primaryAccounts: {}, gilbert: { isAdmin: true } } as never,
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    vi.spyOn(client, "chain").mockImplementation((async () => {
      await gate;
      return answer(["c", "d"], "q1");
    }) as never);
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Email/set") return { destroyed: ["b"] };
      return { list: [], state: "s1", notFound: [] };
    }) as never);

    const more = useMail.getState().loadMore();
    await useMail.getState().destroy(["b"]);
    release();
    await more;

    expect(useMail.getState().list?.loadingMore).toBe(false);
    expect(useMail.getState().list?.ids).toEqual(["a"]);
    // The page was computed before the delete, so it is dropped, not appended.
    expect(useMail.getState().emails.c).toBeUndefined();
  });

  it("brings the page's flag down when a move overtakes it", async () => {
    listOn(["a", "b"], "q1");
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    vi.spyOn(client, "chain").mockImplementation((async () => {
      await gate;
      return answer(["c", "d"], "q1");
    }) as never);
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Email/set") return { updated: { b: null } };
      return { list: [], state: "s1", notFound: [] };
    }) as never);

    const more = useMail.getState().loadMore();
    await useMail.getState().move(["b"], "mb2", { silent: true });
    release();
    await more;

    expect(useMail.getState().list?.ids).toEqual(["a"]);
    expect(useMail.getState().list?.loadingMore).toBe(false);
  });
});

describe("a move racing the window's own read", () => {
  /*
   * The read was computed before the move reached the server, so its answer
   * still names the row the reader just filed away. Only the generation the read
   * was issued under says so, which is why a move that takes a row off the
   * screen moves it.
   */
  it("drops the read's answer instead of putting the moved row back", async () => {
    listOn(["a", "b"], "q1");
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    vi.spyOn(client, "chain").mockImplementation((async () => {
      await gate;
      return answer(["a", "b"], "q1");
    }) as never);
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Email/set") return { updated: { b: null } };
      return { list: [], state: "s1", notFound: [] };
    }) as never);

    const read = useMail.getState().refreshList();
    const outcome = await useMail.getState().move(["b"], "mb2", { silent: true });
    release();
    await read;

    expect(outcome.ok).toBe(true);
    expect(useMail.getState().list?.ids).toEqual(["a"]);
  });
});
