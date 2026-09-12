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

beforeEach(() => {
  vi.restoreAllMocks();
  useMail.setState({
    accountId: "a1",
    identities: [
      { id: "i1", name: "John", email: "john@example.org", replyTo: null },
    ] as never,
    mailboxes: { mb1: FOLDERS.mb1 } as never,
    mailboxesLoaded: true,
    loadMailboxes: (async () => undefined) as never,
  });
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
