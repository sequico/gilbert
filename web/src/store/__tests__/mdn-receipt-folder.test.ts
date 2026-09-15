import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Email, UploadResponse } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { sendReadReceipt } from "@/store/mdn";

/**
 * Where a read receipt is filed, and what happens when the server says
 * nothing about it.
 *
 * The receipt is a message of ours, submitted the long way round (upload,
 * import, EmailSubmission/set), and it has to live in a folder before it can
 * be submitted. Falling back to Inbox when the account has no Sent or Archive
 * folder puts it where a received message would be: it reads as mail that
 * arrived, in the folder the reader trusts most. And with no submission
 * response at all -- the chain answered with only the keyword call -- reading
 * `sub.__error` off `undefined` threw a TypeError instead of saying the
 * receipt did not go.
 */

/** A message that asks for a receipt, from the address it asks to reach. */
const ASKS_FOR_RECEIPT = {
  id: "m1",
  messageId: ["<orig@example.com>"],
  subject: "Lunch?",
  from: [{ name: "Ann", email: "ann@example.com" }],
  to: [{ name: "John", email: "john@example.org" }],
  keywords: {},
  mailboxIds: { mb1: true },
  "header:Disposition-Notification-To:asAddresses": [
    { name: null, email: "ann@example.com" },
  ],
} as unknown as Email;

/** The message the receipt is about, filed in Inbox only. */
const FOLDERS = {
  mb1: { id: "mb1", name: "Inbox", role: "inbox" },
  mb2: { id: "mb2", name: "Sent", role: "sent" },
};

/** The two responses a receipt's chain can answer with. */
const answered = new Map<string, Record<string, unknown>[]>([
  ["s", [{ accountId: "a1", created: { s: { id: "sub1" } } }]],
  ["k", [{ accountId: "a1", updated: {} }]],
]);

/**
 * The keyword writes the receipt makes, in order, and a way to fail one.
 *
 * The mark is what records the decision, and the submission is the effect that
 * leaves the process, so which of the two goes first is the whole of what
 * keeps a flaky connection from sending the same receipt twice.
 */
function stubKeywordWrites(opts: { failMark?: boolean; failClear?: boolean } = {}) {
  const seen: Array<{ update: Record<string, unknown> }> = [];
  vi.spyOn(client, "call").mockImplementation((async (
    _method: string,
    args: { update?: Record<string, unknown> },
  ) => {
    const update = args.update ?? {};
    const [id, patch] = Object.entries(update)[0] ?? [];
    const value = patch ? Object.values(patch as Record<string, unknown>)[0] : null;
    if (value === true && opts.failMark)
      return { notUpdated: { [id!]: { type: "serverFail", description: "down" } } };
    if (value === null && opts.failClear)
      return { notUpdated: { [id!]: { type: "serverFail", description: "down" } } };
    seen.push({ update });
    return { updated: { [id!]: null } };
  }) as never);
  return seen;
}

beforeEach(() => {
  vi.restoreAllMocks();
  useMail.setState({
    accountId: "a1",
    identities: [
      { id: "i1", name: "John", email: "john@example.org", replyTo: null },
    ] as never,
    mailboxes: { mb1: FOLDERS.mb1 } as never,
    mailboxesLoaded: true,
    emails: {},
    loadMailboxes: (async () => undefined) as never,
  });
  stubKeywordWrites();
  vi.spyOn(client, "upload").mockResolvedValue({
    accountId: "a1",
    blobId: "b1",
    type: "message/rfc822",
    size: 1,
  } as UploadResponse);
});

afterEach(() => vi.restoreAllMocks());

describe("filing the receipt", () => {
  it("refuses rather than filing it where received mail lives", async () => {
    const imported = vi.fn(async () => "mdn1");
    useMail.setState({ importEml: imported as never });

    await expect(sendReadReceipt(ASKS_FOR_RECEIPT)).rejects.toThrow(
      "No folder to file the receipt in",
    );
    expect(imported).not.toHaveBeenCalled();
  });

  it("files it in Sent once the account has one", async () => {
    const imported = vi.fn(async () => "mdn1");
    useMail.setState({
      mailboxes: { mb1: FOLDERS.mb1, mb2: FOLDERS.mb2 } as never,
      importEml: imported as never,
    });
    vi.spyOn(client, "chain").mockResolvedValue(answered);

    await sendReadReceipt(ASKS_FOR_RECEIPT);
    expect(imported).toHaveBeenCalledWith("b1", "mb2", { $seen: true });
  });
});

describe("a submission the server never answered", () => {
  it("says the receipt did not go instead of throwing a TypeError", async () => {
    useMail.setState({
      mailboxes: { mb1: FOLDERS.mb1, mb2: FOLDERS.mb2 } as never,
      importEml: (async () => "mdn1") as never,
    });
    vi.spyOn(client, "chain").mockResolvedValue(
      new Map<string, Record<string, unknown>[]>([
        ["k", [{ accountId: "a1", updated: {} }]],
      ]),
    );

    await expect(sendReadReceipt(ASKS_FOR_RECEIPT)).rejects.toThrow(
      "The server would not accept the receipt",
    );
  });
});

/**
 * The order the two writes go in, which is what keeps one receipt one receipt.
 *
 * `$mdnsent` is the record that a receipt exists; `EmailSubmission/set` is the
 * receipt. Writing the record first means an unstable connection cannot leave
 * the second half done and the first half missing — a state in which the
 * message stays offerable and every further look sends another receipt, which
 * is what a reader sees as a burst of them.
 */
describe("the record goes down before the receipt leaves", () => {
  const withSent = () =>
    useMail.setState({
      mailboxes: { mb1: FOLDERS.mb1, mb2: FOLDERS.mb2 } as never,
      importEml: (async () => "mdn1") as never,
    });

  it("marks the message before it submits anything", async () => {
    withSent();
    const order: string[] = [];
    const call = client.call as unknown as ReturnType<typeof vi.fn>;
    call.mockImplementation((async (_m: string, args: { update?: unknown }) => {
      order.push("mark");
      return { updated: { [Object.keys(args.update ?? {})[0]!]: null } };
    }) as never);
    vi.spyOn(client, "chain").mockImplementation((async () => {
      order.push("submit");
      return answered;
    }) as never);

    await sendReadReceipt(ASKS_FOR_RECEIPT);
    expect(order).toEqual(["mark", "submit"]);
  });

  it("sends nothing at all when the mark cannot be written", async () => {
    withSent();
    stubKeywordWrites({ failMark: true });
    const chain = vi.spyOn(client, "chain");

    await expect(sendReadReceipt(ASKS_FOR_RECEIPT)).rejects.toThrow();
    // Nothing left the process, so there is nothing to record and nothing to
    // take back: the message is still offerable and no receipt exists twice.
    expect(chain).not.toHaveBeenCalled();
  });

  it("takes the mark back when the submission did not go, so no receipt is claimed", async () => {
    withSent();
    const writes = stubKeywordWrites();
    vi.spyOn(client, "chain").mockResolvedValue(
      new Map<string, Record<string, unknown>[]>([
        ["s", [{ accountId: "a1", notCreated: { s: { type: "overquota" } } }]],
      ]),
    );

    await expect(sendReadReceipt(ASKS_FOR_RECEIPT)).rejects.toThrow();
    // A mark, then the clearing of it: no receipt exists, so none is recorded.
    // (The orphaned unsent receipt is destroyed in between, which is a write
    // that says nothing about the message's keywords.)
    const patches = writes.map((w) => Object.values(w.update)[0]);
    expect(patches[0]).toEqual({ "keywords/$mdnsent": true });
    expect(patches.at(-1)).toEqual({ "keywords/$mdnsent": null });
  });

  it("says so when the mark cannot be taken back either, rather than pretending", async () => {
    withSent();
    stubKeywordWrites({ failClear: true });
    vi.spyOn(client, "chain").mockResolvedValue(new Map());

    // The message is marked with no receipt behind it. That is the safe
    // direction — no duplicate is possible — and the reader is told which one
    // they are in rather than left believing the receipt went.
    await expect(sendReadReceipt(ASKS_FOR_RECEIPT)).rejects.toThrow(
      /will not offer the receipt again/,
    );
  });

  it("refuses a second receipt for a message the first one is still sending", async () => {
    withSent();
    let releaseMark: () => void = () => {};
    const held = new Promise<void>((res) => {
      releaseMark = res;
    });
    const call = client.call as unknown as ReturnType<typeof vi.fn>;
    call.mockImplementation((async (_m: string, args: { update?: unknown }) => {
      await held;
      return { updated: { [Object.keys(args.update ?? {})[0]!]: null } };
    }) as never);
    const chain = vi.spyOn(client, "chain").mockResolvedValue(answered);

    const first = sendReadReceipt(ASKS_FOR_RECEIPT);
    await expect(sendReadReceipt(ASKS_FOR_RECEIPT)).rejects.toThrow(/already on its way/);
    releaseMark();
    await first;
    // One submission for the two attempts, not two.
    expect(chain).toHaveBeenCalledTimes(1);
  });
});
