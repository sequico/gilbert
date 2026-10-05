import { afterEach, describe, expect, it } from "vitest";
import type { Mailbox } from "@/jmap/types";
import { useMail } from "@/store/mail";

/**
 * A route names a folder and not the account it lives in. On a cold load the
 * active account is whatever this device was last on, which need not be the
 * folder's owner -- and a conversation asked of the wrong account comes back
 * "no such conversation".
 *
 * `accountOfMailbox` is how the folder is resolved back to its owner, from the
 * trees every account already answered with. The account on screen wins when
 * its own tree holds the id, so a folder that exists in two trees is never a
 * reason to move the reader.
 */

const mb = (id: string) => ({ id, name: id }) as unknown as Mailbox;

afterEach(() => {
  useMail.setState({ accountId: null, accountTrees: {}, mailboxes: {} });
});

describe("resolving a folder to its account", () => {
  it("names the account whose tree holds it", () => {
    useMail.setState({
      accountId: "own",
      mailboxes: { inbox: mb("inbox") },
      accountTrees: {
        own: { inbox: mb("inbox") },
        gg: { "g-inbox": mb("g-inbox") },
      },
    });
    expect(useMail.getState().accountOfMailbox("g-inbox")).toBe("gg");
    expect(useMail.getState().accountOfMailbox("inbox")).toBe("own");
    expect(useMail.getState().accountOfMailbox("nope")).toBeNull();
  });

  it("keeps the account on screen when its own tree holds the folder too", () => {
    useMail.setState({
      accountId: "own",
      mailboxes: { inbox: mb("inbox") },
      accountTrees: {
        own: { inbox: mb("inbox") },
        gg: { inbox: mb("inbox") },
      },
    });
    expect(useMail.getState().accountOfMailbox("inbox")).toBe("own");
  });
});
