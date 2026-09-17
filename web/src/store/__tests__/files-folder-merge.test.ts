import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useFiles } from "@/store/files";

/**
 * Merging two folders into one.
 *
 * The reader ticks two folders of a listing, asks for them to become one, and
 * answers which of the two names stays. Everything the other one holds moves
 * into the kept one, a name they both hold as a file has the other's bytes
 * written into the node that already has it, and the folder given up is
 * destroyed once it is empty.
 *
 * Three things are asserted here that the plan alone cannot say. The first is
 * that **a collision costs nothing**: the scan and the plan are in front of the
 * first write, so a name that is a folder on one side and a file on the other
 * leaves the account exactly as it was -- no move, no copy, no destroy, and no
 * `FileNode/set` at all. The second is that the folder being merged in survives
 * a run that stopped, because the plan puts its destruction last. The third is
 * that the folder is **empty when it is destroyed**, which the fake server
 * refuses the way a real one does: a destroy that does not cascade -- and a
 * merge does not ask it to -- is refused for a folder that still holds
 * something, so a merge that left a replaced file behind would leave the
 * reader's folder standing with a copy of a file in it.
 *
 * The server here is a fake one: it holds the two trees, answers `FileNode/query`
 * and `FileNode/get` for a level, applies a set and refuses it the way Stalwart
 * does. That record is what the assertions read -- what was moved, what was
 * written, what was destroyed, and in what order.
 */

const BROWSE = "acc-own";

/** A node, as a level read hands it back. */
const node = (
  id: string,
  name: string,
  nodeType: "file" | "directory",
  parentId: string | null,
  extra: Record<string, unknown> = {},
) => ({ id, name, nodeType, parentId, myRights: {}, ...extra });

type Obj = Record<string, unknown> & { id: string };

/**
 * A fake account holding a flat list of nodes.
 *
 * `calls` is every `FileNode/set` in order, and `uploaded` every copy's upload --
 * the two records the merge's behaviour is read from.
 *
 * Its destroy is the part worth pinning: a folder that still holds something is
 * refused when the call does not cascade, which is what Stalwart does and what
 * the merge depends on -- it never asks a folder to go with its contents, so a
 * merge that left a file in the folder it gave up fails here loudly rather than
 * passing against a server that would have accepted anything.
 */
function server(seed: Obj[]) {
  const nodes: Obj[] = seed.map((n) => ({ ...n }));
  const calls: Array<Record<string, unknown>> = [];
  const uploaded: string[] = [];
  const destroyed: string[] = [];

  vi.spyOn(client, "chain").mockImplementation((async (callsIn: unknown[]) => {
    const [, query] = callsIn[0] as [string, { filter?: Record<string, unknown> }];
    const filter = query.filter ?? {};
    const list = nodes.filter((n) =>
      "parentId" in filter ? n.parentId === filter.parentId : n.parentId == null,
    );
    return new Map([
      ["q", [{ ids: list.map((n) => n.id), total: list.length }]],
      ["g", [{ list, state: "1" }]],
    ]);
  }) as never);

  vi.spyOn(client, "call").mockImplementation((async (
    method: string,
    args: {
      ids?: string[];
      update?: Record<string, Obj>;
      destroy?: string[];
      onDestroyRemoveChildren?: boolean;
    },
  ) => {
    if (method === "FileNode/get")
      return { list: nodes.filter((n) => (args.ids ?? []).includes(n.id)) };
    if (method !== "FileNode/set") return {};
    calls.push(args as Record<string, unknown>);
    for (const [id, patch] of Object.entries(args.update ?? {})) {
      const held = nodes.find((n) => n.id === id);
      if (held) Object.assign(held, patch);
    }
    const notDestroyed: Record<string, unknown> = {};
    for (const id of args.destroy ?? []) {
      const held = nodes.find((n) => n.id === id);
      if (!held) continue;
      const kids = nodes.filter((n) => n.parentId === id);
      if (kids.length && !args.onDestroyRemoveChildren) {
        notDestroyed[id] = { type: "forbidden", description: "The folder is not empty." };
        continue;
      }
      if (args.onDestroyRemoveChildren)
        for (const k of kids) nodes.splice(nodes.indexOf(k), 1);
      nodes.splice(nodes.indexOf(held), 1);
      destroyed.push(id);
    }
    return {
      updated: {},
      destroyed: (args.destroy ?? []).filter((id) => !(id in notDestroyed)),
      ...(Object.keys(notDestroyed).length ? { notDestroyed } : {}),
    };
  }) as never);

  vi.spyOn(client, "fetchBlob").mockImplementation(
    (async (_account: string, blobId: string) =>
      new Blob([`bytes of ${blobId}`], { type: "application/pdf" })) as never,
  );
  vi.spyOn(client, "upload").mockImplementation((async (
    _account: string,
    _blob: Blob,
    opts: { type?: string },
  ) => {
    uploaded.push(opts?.type ?? "application/octet-stream");
    return {
      accountId: BROWSE,
      blobId: `up-${uploaded.length}`,
      type: opts?.type,
      size: 12,
    };
  }) as never);

  return { nodes, calls, uploaded, destroyed };
}

afterEach(() => {
  vi.restoreAllMocks();
  useFiles.setState({ accountId: BROWSE, ownAccountId: BROWSE, runs: [], nodes: {} });
});

/** Park the two folders in the store, the way the listing would have. */
const open = (keep: Obj, merge: Obj) =>
  useFiles.setState({
    nodes: {
      [keep.id]: keep as never,
      [merge.id]: merge as never,
    },
  });

describe("merging two folders", () => {
  /*
   * The ordinary case: a folder holding one file and one folder of its own
   * joins a folder that holds neither. Its contents move in, the container
   * follows, and the emptied folder is destroyed last.
   */
  it("moves everything in and destroys the folder that was merged", async () => {
    const keep = node("keep", "Work", "directory", null);
    const merge = node("merge", "Archive", "directory", null);
    const s = server([
      keep,
      merge,
      node("f1", "notes.txt", "file", "merge"),
      node("d1", "2024", "directory", "merge"),
    ]);
    open(keep, merge);

    await useFiles.getState().mergeFolders("keep", "merge");

    // Both children are now inside the kept folder.
    expect(s.nodes.find((n) => n.id === "f1")!.parentId).toBe("keep");
    expect(s.nodes.find((n) => n.id === "d1")!.parentId).toBe("keep");
    // The folder given up is gone, and it was the last thing destroyed.
    expect(s.nodes.some((n) => n.id === "merge")).toBe(false);
    expect(s.destroyed).toEqual(["merge"]);
    // The kept folder was not moved, renamed or destroyed.
    expect(
      s.calls.some((c) => "destroy" in c && (c.destroy as string[]).includes("keep")),
    ).toBe(false);
    expect(s.nodes.find((n) => n.id === "keep")!.parentId).toBe(null);
    // The run reported itself away: nothing is left to dismiss.
    expect(useFiles.getState().runs).toEqual([]);
  });

  /*
   * A name both folders hold as a file. The bytes cross, and they cross into the
   * node the kept folder already has: same id, same place, only the content
   * changes (ADR 0014). The other node is then destroyed with its folder, so one
   * file of that name is left, holding the copy.
   */
  it("writes the other file's bytes into the node that already holds the name", async () => {
    const keep = node("keep", "Work", "directory", null);
    const merge = node("merge", "Archive", "directory", null);
    const s = server([
      keep,
      merge,
      node("k1", "report.pdf", "file", "keep", {
        blobId: "blob-old",
        type: "application/pdf",
      }),
      node("m1", "report.pdf", "file", "merge", {
        blobId: "blob-new",
        type: "application/pdf",
      }),
    ]);
    open(keep, merge);

    await useFiles.getState().mergeFolders("keep", "merge");

    // One node of that name, in the kept folder, under the same id as before.
    const held = s.nodes.filter((n) => n.name === "report.pdf");
    expect(held).toHaveLength(1);
    expect(held[0]!.id).toBe("k1");
    expect(held[0]!.parentId).toBe("keep");
    // And it carries the bytes that were read out of the other one.
    expect(held[0]!.blobId).toBe("up-1");
    expect(s.uploaded).toEqual(["application/pdf"]);
    expect(s.nodes.some((n) => n.id === "m1")).toBe(false);
  });

  /*
   * Two folders of one name merge into one another rather than one landing on
   * top of the other: the walk descends, the deeper names merge by the same
   * rules, and the inner folder is destroyed before the outer one.
   */
  it("merges two folders of the same name, inside out", async () => {
    const keep = node("keep", "Work", "directory", null);
    const merge = node("merge", "Archive", "directory", null);
    const s = server([
      keep,
      merge,
      node("kc", "Clients", "directory", "keep"),
      node("mc", "Clients", "directory", "merge"),
      node("kf", "eu.pdf", "file", "kc", { blobId: "b1" }),
      node("mf", "us.pdf", "file", "mc", { blobId: "b2" }),
    ]);
    open(keep, merge);

    await useFiles.getState().mergeFolders("keep", "merge");

    // The two files are in the one folder that survives, under the kept name.
    expect(s.nodes.find((n) => n.id === "mf")!.parentId).toBe("kc");
    expect(s.nodes.find((n) => n.id === "kf")!.parentId).toBe("kc");
    expect(s.nodes.some((n) => n.id === "mc")).toBe(false);
    // The inner folder went before the outer one.
    expect(s.destroyed).toEqual(["mc", "merge"]);
    // The kept folder's own node never moved or changed name.
    expect(s.calls.some((c) => "update" in c && "keep" in (c.update as object))).toBe(
      false,
    );
  });

  /*
   * The collision, which is the whole reason the scan comes first: a name that
   * is a folder on one side and a file on the other stops the merge **before
   * anything is written**. Not one set reaches the server, and the account is
   * exactly as it was.
   */
  it("writes nothing at all when the two trees collide", async () => {
    const keep = node("keep", "Work", "directory", null);
    const merge = node("merge", "Archive", "directory", null);
    const s = server([
      keep,
      merge,
      node("k1", "report", "file", "keep", { blobId: "b1" }),
      node("m1", "report", "directory", "merge"),
      node("m2", "loose.txt", "file", "merge"),
    ]);
    open(keep, merge);

    await useFiles.getState().mergeFolders("keep", "merge");

    // No move, no copy, no destroy.
    expect(s.calls).toEqual([]);
    expect(s.uploaded).toEqual([]);
    expect(s.destroyed).toEqual([]);
    expect(s.nodes.find((n) => n.id === "m2")!.parentId).toBe("merge");
    // And the reader is told which name stopped it, on the tray row that stays.
    const rows = useFiles.getState().runs;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toMatch(/Work\/report/);
    expect(rows[0]!.error).toMatch(/folder in one of the two and a file in the other/);
  });

  /*
   * A merge the reader stopped. What it had done when they pressed Cancel stays
   * done -- that is what Cancel means here -- and the folder being merged in is
   * **not** destroyed, because its destruction is the last step of the plan and
   * the plan did not get there. Both folders are therefore still there, and the
   * merge can be asked for again.
   */
  it("stops when asked, leaves what it did, and destroys nothing", async () => {
    const keep = node("keep", "Work", "directory", null);
    const merge = node("merge", "Archive", "directory", null);
    const s = server([
      keep,
      merge,
      node("m1", "a.txt", "file", "merge", { blobId: "b1" }),
      node("m2", "b.txt", "file", "merge", { blobId: "b2" }),
    ]);
    open(keep, merge);

    /*
     * The first copy is held on a promise this test owns, and the abort lands
     * while it is in flight: the run is stopped mid-step, which is the moment a
     * reader can actually press Cancel.
     */
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let copies = 0;
    vi.spyOn(client, "fetchBlob").mockImplementation((async () => {
      copies += 1;
      if (copies === 1) await held;
      return new Blob(["x"], { type: "text/plain" });
    }) as never);
    /*
     * Both files land under names the kept folder already holds, so both are
     * copies rather than moves -- a copy is where a run can be stopped between
     * two steps, and the abort below is aimed at the second of them.
     */
    s.nodes.push(
      node("k1", "a.txt", "file", "keep", { blobId: "old-1" }),
      node("k2", "b.txt", "file", "keep", { blobId: "old-2" }),
    );

    const run = useFiles.getState().mergeFolders("keep", "merge");
    await vi.waitFor(() => expect(copies).toBe(1));
    const rows = useFiles.getState().runs;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unit).toBe("item");
    expect(rows[0]!.total).toBe(3);
    useFiles.getState().cancelRun(rows[0]!.id);
    release();
    await run;

    /*
     * What was done stays done: the file whose bytes crossed was copied and then
     * removed, which is one node of that name left rather than two. What must
     * **not** have happened is the folder going: its destruction is the plan's
     * last step, and a stopped run never reaches it -- so `merge` is still there
     * holding whatever had not moved yet, and the merge can be asked for again.
     */
    expect(s.destroyed).toEqual(["m1"]);
    expect(s.nodes.some((n) => n.id === "merge")).toBe(true);
    expect(s.nodes.find((n) => n.id === "m2")!.parentId).toBe("merge");
    // The count went with it: a merge that was stopped steps nothing, so its
    // row leaves the tray the way a cancelled upload's does.
    expect(useFiles.getState().runs).toEqual([]);
  });

  /*
   * Cancel while a copy is actually in flight.
   *
   * The client hands the run's signal to the blob read and to the upload, so a
   * call in flight rejects the moment the run is aborted -- which is what this
   * mock does, rather than resolving into a run nobody is waiting for any more.
   * That is the other half of the abort: the loop's own check ends the run
   * between two steps, and this is the step it ends inside.
   *
   * What the reader is owed afterwards is a tray that holds nothing about it:
   * a row left behind would say "0 of 1 item" beside a Cancel that can no
   * longer stop anything -- the run is out of the registry by then -- and no
   * Dismiss, which the tray draws on a row that failed.
   */
  it("takes the row away when the step in flight is aborted", async () => {
    const keep = node("keep", "Work", "directory", null);
    const merge = node("merge", "Archive", "directory", null);
    const s = server([
      keep,
      merge,
      node("m1", "a.txt", "file", "merge", { blobId: "b1" }),
    ]);
    open(keep, merge);
    // A name both folders hold, so the step is a copy -- the one step that
    // waits on the network for longer than a request.
    s.nodes.push(node("k1", "a.txt", "file", "keep", { blobId: "old-1" }));

    let reads = 0;
    vi.spyOn(client, "fetchBlob").mockImplementation((async (
      _account: string,
      _blobId: string,
      _type: string,
      signal?: AbortSignal,
    ) => {
      reads += 1;
      return new Promise<Blob>((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    }) as never);

    vi.spyOn(client, "upload").mockRejectedValue(
      new Error("The upload should never be reached: the run stops at the read."),
    );

    const run = useFiles.getState().mergeFolders("keep", "merge");
    await vi.waitFor(() => expect(reads).toBe(1));
    const rows = useFiles.getState().runs;
    expect(rows).toHaveLength(1);
    useFiles.getState().cancelRun(rows[0]!.id);
    await run;

    // The abort stopped the step where it was: no bytes written, and the file
    // the bytes were coming from still under the name it had.
    expect(s.uploaded).toEqual([]);
    expect(s.nodes.find((n) => n.id === "m1")!.parentId).toBe("merge");
    // Neither folder was destroyed: the plan's last step is nowhere near, and
    // the folder given up is never destroyed before it is empty.
    expect(s.destroyed).toEqual([]);
    // And the tray holds nothing: the row went with the run.
    expect(useFiles.getState().runs).toEqual([]);
  });

  /*
   * The guard the menu keeps, reached again where the ids are actually used.
   * Nothing is a merge but two folders, and a call that is not one is refused
   * with a sentence rather than a plan.
   */
  it("refuses anything that is not two folders", async () => {
    const keep = node("keep", "Work", "directory", null);
    const aFile = node("f1", "notes.txt", "file", null);
    server([keep, aFile]);
    open(keep, aFile);

    await expect(useFiles.getState().mergeFolders("keep", "f1")).rejects.toThrow(
      /two folders/,
    );
    expect(useFiles.getState().runs).toEqual([]);
  });
});
