import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/**
 * What a Send in the undo window is aimed at.
 *
 * Send hides the composer and submits the message `undoSendSeconds` later.
 * The account and identity used to be read at the end of that window: signing
 * out or switching to a group mailbox inside it submitted the message from
 * whichever account was on screen by then -- or with no account at all, since
 * the store's account id is null when nobody is signed in. The identity had
 * the same problem in reverse: a draft with no identity of its own took
 * `identities[0]` at send time, which after a reload of the list is another
 * persona than the one the composer was showing.
 */

const jane = { id: "i1", name: "John", email: "john@example.org", replyTo: null };
const team = { id: "i2", name: "Team", email: "team@example.org", replyTo: null };

/** Every method the send chain asked the server to run. */
const chainCalls: Array<[string, Record<string, unknown>]> = [];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  chainCalls.length = 0;
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, undoSendSeconds: 2 } });
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
  vi.spyOn(client, "call").mockResolvedValue({
    accountId: "a1",
    created: {},
    destroyed: {},
  } as never);
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
  it("sends nothing rather than sending from the wrong account", async () => {
    const key = openDraft();
    void useCompose.getState().send(key);
    // Send hides the composer at once; the message goes out after the window.
    expect(useCompose.getState().drafts.some((d) => d.key === key)).toBe(false);

    useMail.setState({ accountId: "a2", identities: [team] as never });
    await vi.advanceTimersByTimeAsync(2000);
    await settle();

    expect(chainCalls).toEqual([]);
  });

  it("sends nothing after a sign-out inside the window", async () => {
    const key = openDraft();
    void useCompose.getState().send(key);

    useMail.setState({ accountId: null, identities: [] as never });
    await vi.advanceTimersByTimeAsync(2000);
    await settle();

    expect(chainCalls).toEqual([]);
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
    await vi.advanceTimersByTimeAsync(2000);
    await settle();

    const submission = chainCalls.find(([method]) => method === "EmailSubmission/set");
    // The submission rides under the reference the chain gave it.
    const create = (submission?.[1].create as { s?: { identityId?: string } } | undefined)
      ?.s;
    expect(create?.identityId).toBe("i1");
  });
});
