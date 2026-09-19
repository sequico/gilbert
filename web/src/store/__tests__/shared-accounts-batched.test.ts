import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { useContacts } from "@/store/contacts";
import { useFiles } from "@/store/files";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

/**
 * Shared accounts are asked together, not one after another.
 *
 * At sign-in the contacts and calendar stores each walked every account shared
 * with the reader -- a request apiece, before anything had been opened. Files
 * asked the same way, and asks it now only when a view that lists those
 * accounts opens.
 *
 * The mechanism this rests on is the client's own batching: `client.call`
 * queues and flushes on a microtask, so the calls started in one tick travel as
 * **one** request. What would break it is not a wrong answer but a wrong order
 * -- awaiting each call before starting the next, which is what this asserts
 * against by counting how many calls were dispatched before any answered.
 */

const ACCOUNTS = {
  own: { name: "me@example.org", isPersonal: true, accountCapabilities: {} },
  shareA: { name: "a@example.org", isPersonal: false, accountCapabilities: {} },
  shareB: { name: "b@example.org", isPersonal: false, accountCapabilities: {} },
  shareC: { name: "c@example.org", isPersonal: false, accountCapabilities: {} },
} as unknown as JmapSession["accounts"];

/** How many calls were in flight before the first one was allowed to answer. */
let inFlight: number;
let peakInFlight: number;
let pending: Array<() => void>;

beforeEach(() => {
  inFlight = 0;
  peakInFlight = 0;
  pending = [];
  useSession.setState({
    status: "authenticated",
    session: {
      accounts: ACCOUNTS,
      primaryAccounts: {},
      state: "s",
    } as unknown as JmapSession,
  });
  vi.spyOn(client, "call").mockImplementation((async (method: string) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise<void>((resolve) => {
      pending.push(() => {
        inFlight -= 1;
        resolve();
      });
    });
    if (method === "AddressBook/get") return { list: [], state: "s" };
    if (method === "Calendar/get") return { list: [], state: "s" };
    if (method === "FileNode/query") return { ids: [], state: "s" };
    return { list: [], state: "s", notFound: [] };
  }) as never);
  vi.spyOn(client, "chain").mockImplementation((async () => new Map()) as never);
  /*
   * The contacts store waits for the mail probe before it can tell a group
   * mailbox from an account that merely shared a folder. It waits only while
   * that probe may still be running, so landing it here is what keeps this file
   * off a six-second timer -- and it is the state the reader is in, not a
   * shortcut.
   */
  useMail.setState({
    mailAccounts: [{ accountId: "own", name: "me@example.org", kind: "own" }],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useSession.setState({ status: "loading", session: null });
});

/**
 * Answer everything the run asks for, until it finishes.
 *
 * Driven by the run rather than by a single drain: the store awaits something
 * before it starts asking -- the mail probe, in the contacts case -- so a drain
 * taken immediately would find nothing queued, return, and leave the run
 * waiting on an answer nobody sends.
 */
async function settle(run: Promise<unknown>): Promise<void> {
  let done = false;
  void run.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 500 && !done; i++) {
    for (const resolve of pending) resolve();
    pending = [];
    await Promise.resolve();
  }
  await run;
}

describe("the accounts are asked together", () => {
  it("asks every shared account for its address books in one turn", async () => {
    await settle(useContacts.getState().loadShared());
    expect(peakInFlight).toBeGreaterThan(1);
  });

  it("asks every shared account for its calendars in one turn", async () => {
    await settle(useCalendar.getState().loadSharedCalendars());
    expect(peakInFlight).toBeGreaterThan(1);
  });

  /*
   * Files answers the same question for the same accounts, but only when a view
   * that lists them opens -- so `init` must not ask at all.
   */
  it("does not ask about shared files at sign-in, and does when asked", async () => {
    useFiles.setState({ ownAccountId: "own", accountId: null, initialized: false });
    await useFiles.getState().init();
    expect(peakInFlight).toBe(0);

    await settle(useFiles.getState().discoverShared());
    expect(peakInFlight).toBeGreaterThan(1);
  });
});
