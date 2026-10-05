import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useFiles } from "@/store/files";

/**
 * A link names a folder and not the account it lives in, and Files opens a
 * shared account in place: a cold load starts on the reader's own, where the
 * folder is not, so the listing comes back empty.
 *
 * `openOwningAccount` asks each account that could hold the node and opens the
 * one that does. Nothing moves when none does -- an empty folder is not a
 * reason to take the reader somewhere else -- and a node the account on screen
 * already holds is not probed past.
 */

const OWN = "acc-own";
const GROUP = "acc-group";

afterEach(() => {
  vi.restoreAllMocks();
  useFiles.setState({ accountId: OWN, ownAccountId: OWN, sharedAccounts: [] });
});

/** A `FileNode/get` that answers with `nodeId` only in `holder`. */
function serverHolding(holder: string | null, nodeId = "n-7") {
  const asked: string[] = [];
  vi.spyOn(client, "call").mockImplementation((async (
    _method: string,
    args: { accountId: string },
  ) => {
    asked.push(args.accountId);
    return {
      accountId: args.accountId,
      state: "1",
      list: args.accountId === holder ? [{ id: nodeId, nodeType: "directory" }] : [],
      notFound: [],
    };
  }) as never);
  return asked;
}

describe("resolving a file link to its account", () => {
  it("opens the share that holds the node, not the account on screen", async () => {
    const asked = serverHolding(GROUP);
    useFiles.setState({
      accountId: OWN,
      ownAccountId: OWN,
      sharedAccounts: [{ id: GROUP, name: "Team" }],
    });

    await useFiles.getState().openOwningAccount("n-7");

    expect(asked).toEqual([OWN, GROUP]);
    expect(useFiles.getState().accountId).toBe(GROUP);
  });

  it("stays put when no account holds the node", async () => {
    serverHolding(null);
    useFiles.setState({
      accountId: OWN,
      ownAccountId: OWN,
      sharedAccounts: [{ id: GROUP, name: "Team" }],
    });

    await useFiles.getState().openOwningAccount("nope");

    expect(useFiles.getState().accountId).toBe(OWN);
  });

  it("does not probe past the account already holding it", async () => {
    const asked = serverHolding(OWN);
    useFiles.setState({
      accountId: OWN,
      ownAccountId: OWN,
      sharedAccounts: [{ id: GROUP, name: "Team" }],
    });

    await useFiles.getState().openOwningAccount("n-7");

    expect(asked).toEqual([OWN]);
    expect(useFiles.getState().accountId).toBe(OWN);
  });
});
