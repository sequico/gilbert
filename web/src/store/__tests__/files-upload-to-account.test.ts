import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useFiles } from "@/store/files";

/**
 * Saving a message's attachments into Files can mean an account nobody is
 * browsing: the reader's own files or a group's, neither of which is where the
 * Files view happens to be looking.
 *
 * The failure this guards against is quiet and expensive. Every write in the
 * store reads `accountId` -- the account being browsed -- so a save that went
 * through `upload` would put the reader's attachments in whatever folder they
 * last opened, and put a group's in their own account, where nobody else ever
 * finds them. So what is asserted is not that the upload worked but *where*:
 * both requests have to carry the destination account, and the browsed one has
 * to be left alone.
 */

const BROWSE = "acc-own";
const GROUP = "acc-group";

const file = () => new File(["hello"], "report.txt", { type: "text/plain" });

/** Record the account every request went to, and answer as the server would. */
function record() {
  const uploads: string[] = [];
  const calls: string[] = [];
  vi.spyOn(client, "upload").mockImplementation((async (accountId: string) => {
    uploads.push(accountId);
    return { accountId, blobId: "blob-1", type: "text/plain", size: 5 };
  }) as never);
  vi.spyOn(client, "call").mockImplementation((async (
    _method: string,
    args: { accountId: string },
  ) => {
    calls.push(args.accountId);
    return { created: { f: { id: "node-1" } } };
  }) as never);
  return { uploads, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  useFiles.setState({ accountId: BROWSE, ownAccountId: BROWSE });
});

describe("saving files into a chosen account", () => {
  it("uploads the blob and creates the node in the destination account", async () => {
    const { uploads, calls } = record();

    const res = await useFiles.getState().uploadTo(GROUP, [file()]);

    expect(uploads).toEqual([GROUP]);
    expect(calls).toEqual([GROUP]);
    expect(res).toEqual({ saved: 1, failed: [] });
  });

  it("does not move where Files is browsing", async () => {
    useFiles.setState({ accountId: BROWSE, ownAccountId: BROWSE });
    record();

    await useFiles.getState().uploadTo(GROUP, [file()]);

    expect(useFiles.getState().accountId).toBe(BROWSE);
  });

  it("names the files it could not save, and keeps the ones it did", async () => {
    const { uploads } = record();
    vi.mocked(client.upload).mockImplementationOnce((async () => {
      throw new Error("too large");
    }) as never);

    const res = await useFiles.getState().uploadTo(GROUP, [file(), file()]);

    expect(res).toEqual({ saved: 1, failed: ["report.txt"] });
    expect(uploads).toEqual([GROUP]);
  });
});
