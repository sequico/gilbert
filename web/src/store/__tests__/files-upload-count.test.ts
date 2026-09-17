import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useFiles } from "@/store/files";

/**
 * The count beside the percentage: how many files of the gesture are through,
 * out of how many it named.
 *
 * A row per file reports its own file, so the tray would otherwise say "42%"
 * with no way to tell whether that is the second file of three or the second of
 * two hundred -- which is what a folder dropped from the desktop is. The count
 * is the **run's**, and it moves as each file lands.
 *
 * Rows of files that went up remove themselves, so a run is only ever seen in
 * flight: the second file's bytes are held on a promise this test owns, which
 * is what makes the tray observable at all. The other half is the row that
 * stays -- a failure -- which reads the count the run has reached rather than
 * the one it had when that row was made.
 */

const BROWSE = "acc-own";

const file = (name: string) => new File(["hello"], name, { type: "text/plain" });

/** The folder listing every upload reloads when it is over; answer with none. */
const stubListing = () =>
  vi.spyOn(client, "chain").mockResolvedValue(new Map([["g", [{ list: [] }]]]) as never);

/**
 * The creates a fake server answers, in the order it is asked. The last answer
 * repeats: a run of files that all go up the same way says so once.
 */
const stubSet = (answers: unknown[]) => {
  let n = 0;
  vi.spyOn(client, "call").mockImplementation(
    (async () => answers[Math.min(n++, answers.length - 1)]) as never,
  );
};

afterEach(() => {
  vi.restoreAllMocks();
  useFiles.setState({ accountId: BROWSE, ownAccountId: BROWSE, uploads: [] });
});

describe("the count of an upload run", () => {
  it("says which file of how many is in flight, and moves as they land", async () => {
    stubListing();
    stubSet([{ created: { f: { id: "n1" } } }]);
    /*
     * The second file's bytes wait on a promise this test holds: the first is
     * through, the second is in flight, and the third has not started -- which
     * is the moment a reader watching a folder go up actually sees.
     */
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let asked = 0;
    vi.spyOn(client, "upload").mockImplementation((async () => {
      asked += 1;
      if (asked === 2) await held;
      return { accountId: BROWSE, blobId: `blob-${asked}`, type: "text/plain", size: 5 };
    }) as never);

    const run = useFiles
      .getState()
      .upload(null, [file("a.txt"), file("b.txt"), file("c.txt")]);
    await vi.waitFor(() => expect(asked).toBe(2));

    const rows = useFiles.getState().uploads;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("b.txt");
    expect(rows[0]!.done).toBe(1);
    expect(rows[0]!.total).toBe(3);

    release();
    await run;
    expect(useFiles.getState().uploads).toEqual([]);
  });

  it("moves the count on the row that stays, not only on the one in flight", async () => {
    stubListing();
    /*
     * The first file is refused: a **folder** of its name is where it would go,
     * which is the one thing a replacement may not write into. That row stays
     * in the tray, and the second file's landing is what moves the count beside
     * it -- the run is one job, and the row of a failure is a row of that job.
     */
    stubSet([
      { notCreated: { f: { type: "alreadyExists", existingId: "dir-1" } } },
      { list: [{ id: "dir-1", nodeType: "directory" }] },
      { created: { f: { id: "n2" } } },
    ]);
    vi.spyOn(client, "upload").mockImplementation((async () => ({
      accountId: BROWSE,
      blobId: "blob-1",
      type: "text/plain",
      size: 5,
    })) as never);

    await useFiles.getState().upload(null, [file("taken.txt"), file("fine.txt")]);

    const rows = useFiles.getState().uploads;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("taken.txt");
    expect(rows[0]!.error).toMatch(/already here/);
    expect(rows[0]!.total).toBe(2);
    expect(rows[0]!.done).toBe(1);
  });
});
