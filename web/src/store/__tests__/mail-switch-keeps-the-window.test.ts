// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Email, EmailFilter, Mailbox } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { listKey } from "@/store/mail/list";

/**
 * What the list draws while a folder (or a search) is being read.
 *
 * Switching folders used to empty the window first: `query` replaced the rows
 * with nothing and the list drew a dozen skeleton rows until the answer landed
 * — the pane that empties, goes black and fills again on every click. The rows
 * of the window being replaced are now carried for the length of the read, and
 * the messages behind them are held with them, so nothing on screen loses its
 * content under the read that is about to replace it.
 *
 * The carried window is drawing only: `list.ids` stays empty until the answer,
 * so no action can name a row that belongs to another folder.
 */

const email = (id: string): Email =>
  ({ id, threadId: id, mailboxIds: { mb1: true }, keywords: {} }) as unknown as Email;

const answer = (ids: string[], queryState: string) =>
  new Map([
    ["q", [{ ids, total: ids.length, queryState }]],
    ["e", [{ list: ids.map(email) }]],
  ]) as never;

const box = (id: string, name: string): Mailbox =>
  ({
    id,
    name,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights: {},
  }) as unknown as Mailbox;

/** The key the store derives, so a seeded window is recognised as itself. */
const keyFor = (mailboxId: string) =>
  listKey({
    filter: { inMailbox: mailboxId } as EmailFilter,
    sort: [],
    collapseThreads: false,
  });

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  useMail.setState({
    accountId: null,
    emails: {},
    threads: {},
    list: null,
    mailboxes: {},
    accountTrees: {},
    mailboxesLoaded: false,
  });
});

const listOn = (ids: string[], mailboxId: string) => {
  useMail.setState({
    accountId: "a1",
    emails: Object.fromEntries(ids.map((id) => [id, email(id)])),
    threads: {},
    fullIds: {},
    list: {
      key: keyFor(mailboxId),
      filter: { inMailbox: mailboxId } as EmailFilter,
      sort: [],
      collapseThreads: false,
      mailboxId,
      label: undefined,
      ids,
      total: ids.length,
      queryState: "q1",
      loading: false,
      loadingMore: false,
      error: null,
      exhausted: true,
    },
  });
};

describe("a folder being read", () => {
  it("carries the rows it is replacing, and drops them with the answer", async () => {
    listOn(["a", "b"], "mb1");
    vi.spyOn(client, "chain").mockResolvedValueOnce(answer(["c"], "q2"));

    const running = useMail.getState().query({
      key: "",
      filter: { inMailbox: "mb2" } as EmailFilter,
      sort: [],
      collapseThreads: false,
      mailboxId: "mb2",
    });

    // The read is in flight: the new window holds nothing, the old one is still
    // drawable, and its messages were not released from under it.
    const during = useMail.getState();
    expect(during.list?.ids).toEqual([]);
    expect(during.list?.previousIds).toEqual(["a", "b"]);
    expect(during.list?.loading).toBe(true);
    expect(Object.keys(during.emails).sort()).toEqual(["a", "b"]);

    await running;

    const after = useMail.getState();
    expect(after.list?.ids).toEqual(["c"]);
    expect(after.list?.previousIds).toEqual([]);
    expect(after.list?.loading).toBe(false);
  });
});

describe("the account being opened", () => {
  it("adopts the tree already read for it instead of emptying the sidebar", () => {
    useMail.setState({
      accountId: "a1",
      mailboxes: { mb1: box("mb1", "Inbox") },
      accountTrees: { a2: { mb2: box("mb2", "Team inbox") } },
      mailboxesLoaded: true,
    });

    useMail.getState().setAccount("a2");

    const s = useMail.getState();
    expect(Object.keys(s.mailboxes)).toEqual(["mb2"]);
    expect(s.mailboxesLoaded).toBe(true);
    // The mail on screen belongs to the account being left: it is not carried.
    expect(s.list).toBeNull();
    expect(s.emails).toEqual({});
  });

  it("waits for the probe on an account this session has never read", () => {
    useMail.setState({
      accountId: "a1",
      mailboxes: { mb1: box("mb1", "Inbox") },
      accountTrees: {},
      mailboxesLoaded: true,
    });

    useMail.getState().setAccount("a3");

    const s = useMail.getState();
    expect(s.mailboxes).toEqual({});
    expect(s.mailboxesLoaded).toBe(false);
  });
});
