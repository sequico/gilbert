import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Email, EmailFilter, Id } from "@/jmap/types";
import { BODIES_KEPT, LIST_PROPS, resetBodyOrder, useMail } from "@/store/mail";

/**
 * How much of the mail store's memory the bodies account for.
 *
 * Every message opened kept its full copy — a body of up to 2 MB, parsed
 * headers, the attachment list — for as long as the tab was open, so a long
 * session grew with every message read. What goes back is the *body*: the
 * properties the list draws stay, so the row it belongs to is unaffected, and a
 * message opened again is fetched in full again.
 *
 * Driven through `getEmails(ids, true)`, which is what opening a message does,
 * so the ordering under test is the ordering the app produces.
 */

const A = "a1";

const email = (id: Id, threadId = "t-other"): Email =>
  ({
    id,
    threadId,
    mailboxIds: { mb1: true },
    keywords: { $seen: true },
    subject: `subject ${id}`,
    receivedAt: "2026-09-19T09:00:00Z",
    size: 4096,
    hasAttachment: false,
    preview: "…",
    from: [{ name: "Ada", email: "ada@example.org" }],
    blobId: `blob-${id}`,
    // What `full` fetches and the list never needs.
    bodyValues: { 1: { value: "x".repeat(64), isTruncated: false } },
    htmlBody: [{ partId: "1", blobId: "b1", type: "text/html" }],
  }) as unknown as Email;

/** Answer `Email/get` with this one message, as a full read would. */
function serving(id: Id, threadId = "t-other") {
  vi.spyOn(client, "call").mockImplementation((async (method: string) => {
    if (method === "Email/get") return { list: [email(id, threadId)], state: "s1" };
    return { list: [], state: "s", notFound: [] };
  }) as never);
}

beforeEach(() => {
  resetBodyOrder();
  useMail.setState({
    accountId: A,
    ownAccountId: A,
    emails: {},
    fullIds: {},
    mailboxes: {},
    threads: {},
    emailState: "s0",
    openThreadId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Open `n` messages in full, oldest first. */
async function open(
  n: number,
  threadOf: (i: number) => string = () => "t-other",
): Promise<void> {
  for (let i = 0; i < n; i++) {
    serving(`e${i}`, threadOf(i));
    await useMail.getState().getEmails([`e${i}`], true);
  }
}

describe("bodies past the limit are let go of", () => {
  it("keeps the list's own properties and drops what only a body needs", async () => {
    await open(BODIES_KEPT + 1);
    const s = useMail.getState();
    expect(s.fullIds.e0, "the message read longest ago").toBeUndefined();
    const kept = s.emails.e0!;
    expect(kept.bodyValues).toBeUndefined();
    expect(kept.htmlBody).toBeUndefined();
    // The row is unaffected: everything it draws is a list property, and what
    // was dropped is only what a body needs.
    expect(kept.subject).toBe("subject e0");
    expect(kept.mailboxIds).toEqual({ mb1: true });
    expect(kept.keywords).toEqual({ $seen: true });
    expect(kept.receivedAt).toBe("2026-09-19T09:00:00Z");
    for (const key of Object.keys(kept))
      expect(LIST_PROPS, `${key} is not a list property`).toContain(key);
  });
  it("holds exactly the limit, and the ones it holds are the most recent", async () => {
    await open(BODIES_KEPT + 5);
    const s = useMail.getState();
    expect(Object.keys(s.fullIds).length).toBe(BODIES_KEPT);
    // The last one open is certainly still held.
    expect(s.fullIds[`e${BODIES_KEPT + 4}`]).toBe(true);
  });

  it("does nothing at all while the held count is within the limit", async () => {
    await open(BODIES_KEPT);
    expect(Object.keys(useMail.getState().fullIds).length).toBe(BODIES_KEPT);
    expect(useMail.getState().emails.e0?.bodyValues).toBeDefined();
  });

  /*
   * The open conversation is what the reading pane draws. Releasing one of its
   * messages takes it out of the pane until the refetch puts it back — the pane
   * empties and refills, a flash the reader sees for no gain — so it is never a
   * candidate however long ago it was read.
   */
  it("never lets go of a message in the open conversation", async () => {
    /*
     * The first two messages opened are the oldest, and the conversation they
     * belong to is the one on screen -- so they are the two a straightforward
     * least-recently-wanted rule would give up first.
     */
    useMail.setState({
      openThreadId: "t-open",
      threads: { "t-open": { id: "t-open", emailIds: ["e0", "e1"] } } as never,
    });
    await open(BODIES_KEPT + 3, (i) => (i <= 1 ? "t-open" : "t-other"));

    const s = useMail.getState();
    expect(s.fullIds.e0, "a message of the open thread").toBe(true);
    expect(s.emails.e0?.bodyValues, "and its body is still here").toBeDefined();
    expect(s.fullIds.e1).toBe(true);
    // Something else paid for it, and it was not the open thread.
    const released = Object.keys(s.emails).filter((id) => !s.fullIds[id] && id !== "e0");
    expect(released.length).toBeGreaterThan(0);
    expect(released).not.toContain("e1");
  });
});

/**
 * How much of the mail store's memory the messages account for.
 *
 * The same bound as the bodies, one level down: what stays in `emails` and
 * `threads` is what the list draws and what the reading pane is showing, so
 * what a window has moved past — a folder the reader left, a conversation
 * closed — is fetched again if it is ever shown.
 */
describe("messages the list has moved past are let go of", () => {
  const listOf = (ids: string[]) =>
    ({
      key: "k",
      filter: { inMailbox: "mb1" } as EmailFilter,
      sort: [],
      collapseThreads: false,
      mailboxId: "mb1",
      label: undefined,
      ids,
      total: ids.length,
      queryState: "q0",
      loading: false,
      loadingMore: false,
      error: null,
      exhausted: true,
    }) as never;

  it("keeps the window and the open conversation, and drops the rest", async () => {
    useMail.setState({
      accountId: A,
      emails: {
        e0: email("e0", "t0"), // a folder the list has left
        e1: email("e1", "t1"), // a row of the window being read
        e2: email("e2", "t2"), // the conversation that is open...
        e3: email("e3", "t2"), // ...and its other message
      },
      threads: {
        t0: { id: "t0", emailIds: ["e0"] },
        t1: { id: "t1", emailIds: ["e1"] },
        t2: { id: "t2", emailIds: ["e2", "e3"] },
      } as never,
      list: listOf(["e0"]),
      openThreadId: "t2",
      lastThreadEmailIds: [],
    });
    vi.spyOn(client, "chain").mockResolvedValue(
      new Map([
        ["q", [{ ids: ["e1"], total: 1, queryState: "q1" }]],
        ["e", [{ list: [email("e1", "t1")], state: "s1" }]],
      ]) as never,
    );

    await useMail.getState().query({
      key: "",
      filter: { inMailbox: "mb1" },
      sort: [],
      collapseThreads: false,
      mailboxId: "mb1",
    });

    const s = useMail.getState();
    expect(Object.keys(s.emails).sort()).toEqual(["e1", "e2", "e3"]);
    expect(Object.keys(s.threads).sort()).toEqual(["t1", "t2"]);
  });

  /*
   * A ticked row is on screen in the selection summary and in what the
   * selection does, whatever the window is doing. Releasing the message behind
   * it leaves the summary counting a row whose message is gone, and the action
   * it names would then skip it in silence.
   */
  it("keeps the message behind a ticked row the window has left", async () => {
    useMail.setState({
      accountId: A,
      emails: {
        e0: email("e0", "t0"), // the window being read
        e1: email("e1", "t1"), // ticked, and the window has moved on
        e2: email("e2", "t2"), // a folder the list has left
      },
      threads: {
        t0: { id: "t0", emailIds: ["e0"] },
        t1: { id: "t1", emailIds: ["e1"] },
        t2: { id: "t2", emailIds: ["e2"] },
      } as never,
      list: listOf([]),
      selected: { e1: true },
      openThreadId: null,
      lastThreadEmailIds: [],
    });
    vi.spyOn(client, "chain").mockResolvedValue(
      new Map([
        ["q", [{ ids: ["e0"], total: 1, queryState: "q1" }]],
        ["e", [{ list: [email("e0", "t0")], state: "s1" }]],
      ]) as never,
    );

    await useMail.getState().refreshList();

    const s = useMail.getState();
    expect(Object.keys(s.emails).sort()).toEqual(["e0", "e1"]);
    expect(Object.keys(s.threads).sort()).toEqual(["t0", "t1"]);
  });

  /*
   * A conversation is kept when one of its messages is: a collapsed row counts
   * the messages the conversation holds and draws them when it is opened, so a
   * thread whose other members were released draws fewer messages than it says
   * it has.
   */
  it("keeps the other messages of a conversation held by one of them", async () => {
    useMail.setState({
      accountId: A,
      emails: {
        e0: email("e0", "t0"), // the window being read
        e1: email("e1", "t1"), // a conversation the window has left
        e2: email("e2", "t2"), // one message of the conversation on screen
        e3: email("e3", "t2"), // the conversation's other message
      },
      threads: {
        t0: { id: "t0", emailIds: ["e0"] },
        t1: { id: "t1", emailIds: ["e1"] },
        t2: { id: "t2", emailIds: ["e2", "e3"] },
      } as never,
      list: listOf(["e2"]),
      selected: {},
      openThreadId: null,
      lastThreadEmailIds: [],
    });
    vi.spyOn(client, "chain").mockResolvedValue(
      new Map([
        ["q", [{ ids: ["e0"], total: 1, queryState: "q1" }]],
        ["e", [{ list: [email("e0", "t0")], state: "s1" }]],
      ]) as never,
    );

    await useMail.getState().refreshList();

    const s = useMail.getState();
    expect(Object.keys(s.emails).sort()).toEqual(["e0", "e2", "e3"]);
    expect(Object.keys(s.threads).sort()).toEqual(["t0", "t2"]);
  });
});
