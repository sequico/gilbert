import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { toast } from "@/ui/toast";

/**
 * What a Send in the undo window is aimed at.
 *
 * Send hides the composer and submits the message five seconds later, and
 * every id the submission needs belongs to the account it was written in: the
 * identity it goes out as and the folder the copy lands in. They are resolved
 * when Send is pressed and travel with the send, so opening another mailbox
 * inside the window -- a group mailbox, say -- cannot redirect the message,
 * and an identity list that comes back in another order cannot change the
 * persona. Only a session that ended stops it, because there is nothing left
 * to submit with.
 */

const jane = { id: "i1", name: "John", email: "john@example.org", replyTo: null };
const team = { id: "i2", name: "Team", email: "team@example.org", replyTo: null };

/** Every method the send chain asked the server to run. */
const chainCalls: Array<[string, Record<string, unknown>]> = [];

/** Every direct call the send chain made, method and arguments. */
const callCalls: Array<[string, Record<string, unknown>]> = [];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  chainCalls.length = 0;
  callCalls.length = 0;
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useMail.setState({
    accountId: "a1",
    identities: [jane] as never,
    mailboxes: {
      mb1: { id: "mb1", name: "Sent", role: "sent" },
      mb2: { id: "mb2", name: "Drafts", role: "drafts" },
    } as never,
    list: null,
    loadMailboxes: (async () => undefined) as never,
    refreshList: (async () => undefined) as never,
  });
  vi.spyOn(client, "call").mockImplementation((async (
    method: string,
    args: Record<string, unknown>,
  ) => {
    callCalls.push([method, args]);
    // The Scheduled folder is created and read where the send is aimed at; the
    // answer names the account it was asked for, so the test can tell them apart.
    if (method === "Mailbox/set")
      return { accountId: args.accountId, created: { sched: { id: "sch1" } } };
    if (method === "Mailbox/get")
      return { accountId: args.accountId, list: [{ id: "sch1", name: "Scheduled" }] };
    return { accountId: "a1", created: {}, destroyed: {} };
  }) as never);
  vi.spyOn(client, "chain").mockImplementation(async (calls) => {
    const out = new Map<string, Record<string, unknown>[]>();
    for (const [method, args, id] of calls) {
      chainCalls.push([method, args]);
      if (method === "Email/set")
        out.set(id, [{ accountId: "a1", created: { m: { id: "m1" } } }]);
      else if (method === "EmailSubmission/set")
        out.set(id, [{ accountId: "a1", created: { s: { id: "sub1" } } }]);
      else out.set(id, [{ accountId: "a1" }]);
    }
    return out;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let the awaits inside the send settle while the clock is faked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A draft ready to send, keyed for the store. */
function openDraft(): string {
  return useCompose.getState().open({
    identityId: "i1",
    to: [{ name: null, email: "ann@example.com" }],
    subject: "Hi",
    html: "<div>v1</div>",
    text: "v1",
  });
}

describe("a switch to another mailbox inside the undo window", () => {
  it("sends all the same, from the mailbox and persona Send was pressed under", async () => {
    const key = openDraft();
    void useCompose.getState().send(key);
    // Send hides the composer at once; the message goes out after the window.
    expect(useCompose.getState().drafts.some((d) => d.key === key)).toBe(false);

    // The reader opens a group mailbox, whose identities and folders are its own.
    useMail.setState({ accountId: "a2", identities: [team] as never });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    const set = chainCalls.find(([method]) => method === "Email/set")?.[1] as
      | { accountId?: string; create?: { m?: { mailboxIds?: Record<string, boolean> } } }
      | undefined;
    expect(set?.accountId).toBe("a1");
    // The copy lands in the Sent folder of the account Send was pressed in:
    // `mb1` is that account's Sent, and the fixture's only one.
    expect(set?.create?.m?.mailboxIds).toEqual({ mb1: true });

    const submit = (
      chainCalls.find(([method]) => method === "EmailSubmission/set")?.[1] as
        | { create?: { s?: { identityId?: string } } }
        | undefined
    )?.create?.s;
    expect(submit?.identityId).toBe("i1");

    // And the message is not put back in Drafts: switching mailbox is not Undo.
    expect(useCompose.getState().drafts.some((d) => d.key === key)).toBe(false);
  });

  it("sends nothing after a sign-out inside the window", async () => {
    const key = openDraft();
    void useCompose.getState().send(key);

    useMail.setState({ accountId: null, identities: [] as never });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    expect(chainCalls).toEqual([]);
  });

  it("holds a scheduled message in the Scheduled folder of the account Send was pressed in", async () => {
    const key = openDraft();
    useCompose.getState().update(key, { sendAt: Date.now() + 60_000 });
    void useCompose.getState().send(key);

    // The reader opens another mailbox inside the window.
    useMail.setState({ accountId: "a2", identities: [team] as never });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    const set = chainCalls.find(([method]) => method === "Email/set")?.[1] as
      | { accountId?: string; create?: { m?: { mailboxIds?: Record<string, boolean> } } }
      | undefined;
    expect(set?.accountId).toBe("a1");
    expect(set?.create?.m?.mailboxIds).toEqual({ sch1: true });
    /*
     * And the folder was read — or created — in that account, not in the mailbox
     * the reader opened since: a "Scheduled" made there would be named by a
     * message in another account, which the server refuses whole, and would sit
     * in a folder nobody asked for.
     */
    expect(
      callCalls.filter(
        ([method, args]) => method.startsWith("Mailbox/") && args.accountId !== "a1",
      ),
      "no folder was read or created anywhere but the captured account",
    ).toEqual([]);
  });
});

describe("the identity a send was pressed under", () => {
  it("is the one the message is submitted from, not the first one by then", async () => {
    const key = openDraft();
    // A draft written before this account's identities landed carries none.
    useCompose.getState().update(key, { identityId: null });
    void useCompose.getState().send(key);

    // The account's identity list comes back in another order inside the window.
    useMail.setState({ identities: [team, jane] as never });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    const submission = chainCalls.find(([method]) => method === "EmailSubmission/set");
    // The submission rides under the reference the chain gave it.
    const create = (submission?.[1].create as { s?: { identityId?: string } } | undefined)
      ?.s;
    expect(create?.identityId).toBe("i1");
  });
});

describe("the undo a send offers", () => {
  it("names the mail, and addresses the undo by its key", async () => {
    const show = vi.spyOn(toast, "show").mockReturnValue(1);
    const key = openDraft();
    await useCompose.getState().send(key);

    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0]).toContain("Hi");
    const action = show.mock.calls[0]![1]!.action!;

    // The reader starts another draft while the send is in flight; taking the
    // first back restores it to the drafts without pulling them out of it.
    const other = useCompose.getState().open({ subject: "Other" });
    void action.onClick();
    const s = useCompose.getState();
    expect(s.drafts.some((d) => d.key === key)).toBe(true);
    expect(s.activeKey).toBe(other);

    show.mockRestore();
  });
});
