import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useFiles } from "@/store/files";

/**
 * A failed upload keeps its row, and the reader has to be able to put it away.
 *
 * The row is not noise: `upload` removes a row that went through, and one that
 * did not stays because its message *is* the error -- "Name contains a
 * forbidden character. (name)" names what to change about the file, and a
 * toast that fades cannot be read twice. What it must not be is permanent. No
 * other part of the tray offers a way out, so without a dismissal the row sits
 * there for the rest of the session, in every folder, with nothing to press --
 * which is the state this pins.
 */

const BROWSE = "acc-own";

const file = (name: string) => new File(["hello"], name, { type: "text/plain" });

/** The folder listing an upload reloads when it is over; answer with none. */
function stubListing() {
  vi.spyOn(client, "chain").mockResolvedValue(new Map([["g", [{ list: [] }]]]) as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  useFiles.setState({ accountId: BROWSE, ownAccountId: BROWSE, uploads: [] });
});

describe("an upload that failed", () => {
  it("keeps the server's reason where it can be read", async () => {
    stubListing();
    vi.spyOn(client, "upload").mockRejectedValue(
      new Error("Name contains a forbidden character. (name)"),
    );

    await useFiles.getState().upload(null, [file("bad<name>.txt")]);

    const rows = useFiles.getState().uploads;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toMatch(/forbidden character/);
  });

  it("goes away when it is dismissed, and a successful one never stays", async () => {
    stubListing();
    const up = vi.spyOn(client, "upload");
    up.mockRejectedValue(new Error("Name contains a forbidden character. (name)"));

    await useFiles.getState().upload(null, [file("bad<name>.txt")]);
    useFiles.getState().dismissUpload(useFiles.getState().uploads[0]!.id);
    expect(useFiles.getState().uploads).toEqual([]);

    /* And a row that goes through still removes itself: there is nothing left
       to dismiss, which is what makes the button a remedy rather than a habit. */
    vi.spyOn(client, "call").mockResolvedValue({
      created: { f: { id: "node-1" } },
    } as never);
    up.mockResolvedValue({
      accountId: BROWSE,
      blobId: "blob-1",
      type: "text/plain",
      size: 5,
    } as never);

    await useFiles.getState().upload(null, [file("fine.txt")]);
    expect(useFiles.getState().uploads).toEqual([]);
  });
});
