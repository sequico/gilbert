import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Email } from "@/jmap/types";
import { useMail } from "@/store/mail";

/**
 * A refresh hands back the same object when the message did not change.
 *
 * The list's rows are memoized, and a change to mail re-fetches the list-level
 * properties of every message it touches — so a fresh object per message,
 * holding the same data, re-rendered every row of the list after any change at
 * all. `mergeEmail` compares what came back with the copy already held and
 * returns that copy when nothing differs, which is what lets the memo work.
 *
 * Identity is the whole assertion: the data being equal was never in doubt, and
 * the failure this prevents is invisible in a value comparison.
 *
 * `applyChanges` is the path that does this — the EventSource and push
 * dispatcher both land there — and the reason `getEmails` is not the one under
 * test is that it skips what it already holds, so it never has two objects to
 * compare.
 */

const A = "a1";
const one = (over: Partial<Email> = {}): Email =>
  ({
    id: "e1",
    threadId: "t1",
    mailboxIds: { mb1: true },
    keywords: { $seen: true },
    receivedAt: "2026-09-19T09:00:00Z",
    subject: "Invoice 42",
    from: [{ name: "Ada", email: "ada@example.org" }],
    ...over,
  }) as unknown as Email;

beforeEach(() => {
  useMail.setState({
    accountId: A,
    ownAccountId: A,
    emails: { e1: one() },
    fullIds: {},
    mailboxes: {},
    threads: {},
    emailState: "s0",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** One `Email/changes` reporting `e1` updated, then `Email/get` answering with it. */
function changes(updated: Email) {
  vi.spyOn(client, "call").mockImplementation((async (method: string) => {
    if (method === "Email/changes")
      return {
        created: [],
        updated: ["e1"],
        destroyed: [],
        newState: "s1",
        hasMoreChanges: false,
      };
    if (method === "Email/get") return { list: [updated], state: "s1" };
    // Anything else the store reaches for on its own -- a mailbox tree, a
    // label list -- is answered empty rather than throwing into a background
    // path; this file is about one message's identity.
    return { list: [], state: "s", notFound: [] };
  }) as never);
}

describe("a change to mail keeps the objects it did not change", () => {
  it("hands back the same message when what came back is identical", async () => {
    const before = useMail.getState().emails.e1;
    changes(one());
    await useMail.getState().applyChanges(new Set(["Email"]));
    expect(useMail.getState().emails.e1).toBe(before);
  });

  /*
   * The other half: a change must produce a new object, or the list would never
   * redraw the message that actually moved.
   */
  it("hands back a new message when one of its properties changed", async () => {
    const before = useMail.getState().emails.e1;
    changes(one({ subject: "Invoice 43" }));
    await useMail.getState().applyChanges(new Set(["Email"]));
    const after = useMail.getState().emails.e1;
    expect(after).not.toBe(before);
    expect(after?.subject).toBe("Invoice 43");
  });

  /*
   * The case that matters most in practice: marking something read rewrites
   * `keywords`, which is a new object holding the same flags on every echo of
   * our own change. A shallow compare would see a change every time and redraw
   * the list for nothing.
   */
  it("sees through a nested object holding the same values", async () => {
    useMail.setState({
      emails: { e1: one({ keywords: { $seen: true, $label1: true } }) },
    });
    const before = useMail.getState().emails.e1;
    changes(one({ keywords: { $label1: true, $seen: true } }));
    await useMail.getState().applyChanges(new Set(["Email"]));
    expect(useMail.getState().emails.e1).toBe(before);
  });

  it("drops a message the server says is gone", async () => {
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Email/changes")
        return {
          created: [],
          updated: [],
          destroyed: ["e1"],
          newState: "s1",
          hasMoreChanges: false,
        };
      return { list: [], state: "s", notFound: [] };
    }) as never);
    await useMail.getState().applyChanges(new Set(["Email"]));
    expect(useMail.getState().emails.e1).toBeUndefined();
  });
});
