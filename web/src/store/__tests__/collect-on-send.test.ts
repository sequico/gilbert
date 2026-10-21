import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { UNDO_SEND_SECONDS, useCompose } from "@/store/compose";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/*
 * A confirmed send hands its recipients to the contacts store, unless the
 * reader turned that off. What the store then does with them -- which book,
 * which account, who is left out -- is `collect-recipients.test.ts`; this is
 * the call site.
 */

const jane = { id: "i1", name: "John", email: "john@example.org", replyTo: null };

let collect: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS },
  });
  useMail.setState({
    accountId: "a1",
    identities: [jane] as never,
    mailboxes: { mb1: { id: "mb1", name: "Sent", role: "sent" } } as never,
    loadMailboxes: (async () => undefined) as never,
    refreshList: (async () => undefined) as never,
  });
  vi.spyOn(client, "call").mockImplementation((async (
    method: string,
    args: Record<string, unknown>,
  ) => {
    if (method === "Mailbox/set")
      return { accountId: args.accountId, created: { sched: { id: "sch1" } } };
    if (method === "Mailbox/get")
      return { accountId: args.accountId, list: [{ id: "sch1", name: "Scheduled" }] };
    return { accountId: "a1", created: {}, destroyed: {} };
  }) as never);
  vi.spyOn(client, "chain").mockImplementation(async (calls) => {
    const out = new Map<string, Record<string, unknown>[]>();
    for (const [method, , id] of calls) {
      if (method === "Email/set")
        out.set(id, [{ accountId: "a1", created: { m: { id: "m1" } } }]);
      else if (method === "EmailSubmission/set")
        out.set(id, [{ accountId: "a1", created: { s: { id: "sub1" } } }]);
      else out.set(id, [{ accountId: "a1" }]);
    }
    return out;
  });
  collect = vi.fn(async () => 1);
  useContacts.setState({ collectRecipients: collect as never });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let the awaits inside the send settle while the clock is faked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function send(): Promise<void> {
  const key = useCompose.getState().open({
    identityId: "i1",
    to: [{ name: "Ann", email: "ann@example.com" }],
    cc: [{ name: null, email: "bob@example.com" }],
    subject: "Hi",
    html: "<div>Hi</div>",
    text: "Hi",
  });
  void useCompose.getState().send(key);
  await vi.advanceTimersByTimeAsync(UNDO_SEND_SECONDS * 1000);
  await settle();
}

describe("collecting recipients when a message is sent", () => {
  it("passes every recipient, the sender's own addresses to leave out, and the account it went out from", async () => {
    await send();
    expect(collect).toHaveBeenCalledTimes(1);
    const [addrs, own, from] = collect.mock.calls[0]!;
    expect((addrs as { email: string }[]).map((a) => a.email)).toEqual([
      "ann@example.com",
      "bob@example.com",
    ]);
    expect(own).toEqual(["john@example.org"]);
    expect(from).toBe("a1");
  });

  it("does not when the reader turned it off", async () => {
    useSettings.setState((s) => ({
      settings: { ...s.settings, collectRecipients: false },
    }));
    await send();
    expect(collect).not.toHaveBeenCalled();
  });

  it("does not when the send failed", async () => {
    vi.mocked(client.chain).mockRejectedValueOnce(new Error("no route to the server"));
    await send();
    expect(collect).not.toHaveBeenCalled();
  });
});
