import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { LEVEL_LIMIT, useFiles } from "@/store/files";

/**
 * A folder dropped onto a folder that is already there.
 *
 * What the reader means by it is "make this tree here": the folders that exist
 * are used as they are, the folders that do not are created, and every file
 * lands under its own name -- written over whatever the folder already held of
 * that name, so dropping the same tree twice leaves one tree and the latest
 * bytes rather than a tray of refusals. Getting it wrong is not subtle -- a
 * create of a folder that exists is refused by the server, and a caller that
 * treats every refusal as "then upload to the parent" leaves the subfolder at
 * the top level with its files loose beside it, which is a copy that is not the
 * tree that was dropped.
 *
 * The mock refuses a duplicate name the way Stalwart does (`alreadyExists`),
 * naming the node that holds it -- so the overwrite is exercised against the
 * refusal rather than against a fixture that agrees with the code.
 */

const BROWSE = "acc-own";

const file = (name: string) => new File(["hello"], name, { type: "text/plain" });

/** A node, as `FileNode/get` would answer. */
const node = (
  id: string,
  name: string,
  nodeType: "file" | "directory",
  parentId: string | null = null,
) => ({ id, name, nodeType, parentId }) as never;

/** The properties a names read asks for, which is how the fake tells it apart
    from a view listing: see the note on `server`. */
const NAMES_PROPS = ["id", "name", "nodeType", "parentId"];

/**
 * A server holding one folder tree, answering the three calls a drop makes:
 * the account-wide read a drop starts with, the create of a directory or a
 * file, and the read of a node a refused create named.
 *
 * `race` makes the first directory create lose: the name is already taken by a
 * folder that appeared between the listing and the create, which is the answer
 * a second worker gets. It is off by default so the ordinary path is the
 * ordinary path.
 *
 * `truncateScan` makes the whole-account read come back as a *page*: the query
 * answers `LEVEL_LIMIT` ids while reporting more matches than that, which is
 * what an account past the read's ceiling looks like from the walk. The ids and
 * nodes past the page are simply not there to be seen, exactly as on a server,
 * and the levels are still readable one at a time -- which is the whole point
 * of the case.
 *
 * The request count is the drop's **own** reads, not every request the store
 * makes: a drop ends by reloading the folder it landed in and the sidebar tree,
 * and counting those would make the numbers say nothing about the drop. A names
 * read is told apart by the properties it asks for -- the folder walk wants
 * `parentId` and three others, where a view listing wants `fileNodeProps()`,
 * and the `properties` of the `get` is what the server sees either way. No file
 * depends on those counts: what a file is written over is the refusal of its
 * own create, and the level reads counted here are the folder walk's.
 *
 * A refusal carries the id of the node holding the name, which the create read
 * in the same request could not (it may only be one file per request here, so
 * there is no such case). `updates` is the replacement path: the node that kept
 * the name, patched with the bytes just uploaded.
 */
function server(
  seed: Array<Record<string, unknown>>,
  opts: { race?: boolean; truncateScan?: boolean } = {},
) {
  const nodes = [...seed];
  const created: Array<{ name: string; nodeType: string }> = [];
  const blobs: string[] = [];
  const updates: string[] = [];
  let next = 1;
  let raced = false;
  /** The whole-account reads, and the per-level ones, so a test can count them. */
  const scans: number[] = [];
  const levelReads: number[] = [];

  const list_ = (parentId: string | null) =>
    nodes.filter((n) => (n.parentId ?? null) === parentId);

  /*
   * The listing of one level, and the whole-account read a drop makes first.
   *
   * `accountLevels` asks for every node in the account in one query -- no
   * filter at all -- which is how a drop resolves a whole tree without a
   * request per folder. A fake that answered only the filtered form would let
   * the walk look correct while it silently read nothing.
   */
  vi.spyOn(client, "chain").mockImplementation((async (calls: unknown[]) => {
    const [, query] = calls[0] as [
      string,
      { filter?: Record<string, unknown>; limit?: number },
    ];
    const [, get] = (calls[1] ?? []) as [string, { properties?: string[] }];
    const filter = query.filter;
    const askedNames =
      Array.isArray(get?.properties) &&
      get.properties.length === NAMES_PROPS.length &&
      get.properties.every((p, i) => p === NAMES_PROPS[i]);
    if (!filter) scans.push(1);
    else if (askedNames) levelReads.push(1);
    let list = filter ? list_((filter.parentId as string | null) ?? null) : [...nodes];
    let total = list.length;
    if (!filter && opts.truncateScan && list.length > LEVEL_LIMIT) {
      total = list.length;
      list = list.slice(0, LEVEL_LIMIT);
    }
    const ids = list.map((n) => n.id);
    return new Map([
      ["q", [{ ids, total }]],
      ["g", [{ list, state: "1" }]],
    ]);
  }) as never);

  vi.spyOn(client, "call").mockImplementation((async (
    method: string,
    args: {
      ids?: string[];
      create?: Record<string, Record<string, unknown>>;
      update?: Record<string, Record<string, unknown>>;
    },
  ) => {
    if (method === "FileNode/get")
      return { list: nodes.filter((n) => (args.ids ?? []).includes(String(n.id))) };
    const update = Object.entries(args.update ?? {});
    if (update.length) {
      for (const [id, patch] of update) {
        const held = nodes.find((n) => n.id === id);
        if (held) Object.assign(held, patch);
        updates.push(id);
      }
      return { updated: Object.fromEntries(update.map(([id]) => [id, null])) };
    }
    const [key, body] = Object.entries(args.create ?? {})[0] ?? [];
    if (!key) return { created: {} };
    const parentId = (body!.parentId as string | null) ?? null;
    const name = String(body!.name);
    if (opts.race && !raced && body!.nodeType === "directory") {
      // Somebody else made it, and the server names what is there.
      raced = true;
      nodes.push({ id: "theirs", name, parentId, nodeType: "directory" });
      return { notCreated: { [key]: { type: "alreadyExists", existingId: "theirs" } } };
    }
    const clash = list_(parentId).find((n) => n.name === name);
    if (clash)
      return {
        notCreated: { [key]: { type: "alreadyExists", existingId: clash.id } },
      };
    const id = `new-${next++}`;
    nodes.push({ id, name, parentId, nodeType: body!.nodeType });
    created.push({ name, nodeType: String(body!.nodeType) });
    return { created: { [key]: { id } } };
  }) as never);

  vi.spyOn(client, "upload").mockImplementation((async (accountId: string) => {
    blobs.push(accountId);
    return { accountId, blobId: `blob-${blobs.length}`, type: "text/plain", size: 5 };
  }) as never);

  return { created, blobs, updates, nodes, scans, levelReads };
}

afterEach(() => {
  vi.restoreAllMocks();
  useFiles.setState({ accountId: BROWSE, ownAccountId: BROWSE, runs: [] });
});

describe("a drop onto a folder that already exists", () => {
  it("reuses the folder and creates only the one that is missing", async () => {
    const s = server([
      node("d1", "folder", "directory"),
      node("d2", "sub", "directory", "d1"),
    ]);

    await useFiles.getState().uploadPlan(null, {
      files: [
        { file: file("known.txt"), path: ["folder"] },
        { file: file("new.txt"), path: ["folder", "sub"] },
      ],
      dirs: [["folder"], ["folder", "sub"]],
    });

    // Neither existing folder is created a second time, and nothing is made
    // beside them at the top level.
    expect(s.created.filter((c) => c.nodeType === "directory")).toEqual([]);
    // Both files land inside the tree that was already there.
    const placed = s.nodes.filter((n) => n.nodeType === "file");
    expect(placed.map((n) => [n.name, n.parentId])).toEqual([
      ["known.txt", "d1"],
      ["new.txt", "d2"],
    ]);
  });

  it("makes the folders of the tree that are not there yet, parents first", async () => {
    const s = server([]);

    await useFiles.getState().uploadPlan(null, {
      files: [{ file: file("x.txt"), path: ["fresh", "inner"] }],
      dirs: [["fresh"], ["fresh", "inner"]],
    });

    expect(
      s.created.filter((c) => c.nodeType === "directory").map((c) => c.name),
    ).toEqual(["fresh", "inner"]);
    const inner = s.nodes.find((n) => n.name === "inner")!;
    const fresh = s.nodes.find((n) => n.name === "fresh")!;
    expect(inner.parentId).toBe(fresh.id);
    expect(s.nodes.find((n) => n.name === "x.txt")!.parentId).toBe(inner.id);
  });

  it("creates a folder the drop carried that holds nothing", async () => {
    const s = server([]);

    await useFiles.getState().uploadPlan(null, {
      files: [],
      dirs: [["empty"], ["empty", "deeper"]],
    });

    expect(s.created.map((c) => c.name)).toEqual(["empty", "deeper"]);
  });

  /*
   * The overwrite. A file whose name the folder already holds is written into,
   * and the node that held the name is the node that holds the bytes now: its
   * id, its sharing and its place in the tree stay, and only the content
   * changes. Duplicating it would leave two rows of one name side by side, and
   * refusing it would turn dropping the same tree twice into a page of errors.
   */
  it("writes over a file whose name the folder already holds", async () => {
    const s = server([
      node("d1", "folder", "directory"),
      node("f1", "known.txt", "file", "d1"),
    ]);

    await useFiles.getState().uploadPlan(null, {
      files: [
        { file: file("known.txt"), path: ["folder"] },
        { file: file("fresh.txt"), path: ["folder"] },
      ],
      dirs: [["folder"]],
    });

    // The bytes were written, and written into the node that had the name.
    expect(s.updates).toEqual(["f1"]);
    expect(s.blobs).toEqual([BROWSE, BROWSE]);
    // One node of that name in that folder, holding the new content.
    const held = s.nodes.filter((n) => n.name === "known.txt" && n.parentId === "d1");
    expect(held).toHaveLength(1);
    expect(held[0]!.blobId).toMatch(/^blob-/);
    expect(held[0]!.size).toBe(5);
    // And the file that was not a duplicate went up as its own node.
    expect(s.nodes.some((n) => n.name === "fresh.txt")).toBe(true);
    // A run of replacements reports nothing: the tray is empty when it is over.
    expect(useFiles.getState().runs).toEqual([]);
  });

  /*
   * The one node a replacement may not write into is a folder. A file dropped
   * where a folder of that name stands is refused -- it is not renamed, not put
   * beside the folder under a made-up name, and the folder is not destroyed to
   * make room: only one of the two may carry the name, and the reader made no
   * choice between them by dropping.
   */
  it("refuses a file whose name a folder holds, rather than writing into it", async () => {
    const s = server([
      node("d1", "folder", "directory"),
      node("sub", "sub", "directory", "d1"),
    ]);

    await useFiles.getState().uploadPlan(null, {
      files: [{ file: file("sub"), path: ["folder"] }],
      dirs: [["folder"]],
    });

    expect(s.updates).toEqual([]);
    expect(s.nodes.filter((n) => n.name === "sub")).toHaveLength(1);
    const rows = useFiles.getState().runs;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("sub");
    expect(rows[0]!.error).toMatch(/already here/);
  });

  /*
   * A folder the drop names is standing where a file already is. Neither may be
   * moved out of the way without being asked, so the subtree stops there -- and
   * its files are reported rather than filed into whatever folder does exist.
   */
  it("refuses a subtree whose folder cannot be made, rather than filing it elsewhere", async () => {
    const s = server([node("f1", "folder", "file"), node("f2", "outside.txt", "file")]);

    await useFiles.getState().uploadPlan(null, {
      files: [{ file: file("inside.txt"), path: ["folder"] }],
      dirs: [["folder"]],
    });

    expect(s.blobs).toEqual([]);
    expect(s.nodes.some((n) => n.name === "inside.txt")).toBe(false);
    // Nothing was dropped at the top level in its place either.
    expect(s.nodes.filter((n) => n.name === "inside.txt")).toEqual([]);
    const rows = useFiles.getState().runs;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("inside.txt");
    expect(rows[0]!.error).toBeTruthy();
  });

  /*
   * The same folder made by somebody else between the listing and our create.
   *
   * This is the race the folder walk is exposed to by construction -- creating a
   * folder is a read-then-write that cannot be made conditional -- and the
   * server answers it with `alreadyExists` and the id of the folder that is
   * there. Taking that id is the whole answer: the folder the drop asked for
   * exists. Reading the refusal as a failure instead fails a drop for no reason
   * a reader could act on, and reading it as "upload to the parent" is how the
   * subfolder ends up at the top level with its files loose beside it.
   */
  it("adopts the folder another writer made between the listing and the create", async () => {
    const s = server([], { race: true });

    await useFiles.getState().uploadPlan(null, {
      files: [{ file: file("x.txt"), path: ["folder"] }],
      dirs: [["folder"]],
    });

    // The file landed in the folder that was there, not beside it, and the
    // drop reported nothing wrong.
    expect(s.nodes.find((n) => n.name === "x.txt")!.parentId).toBe("theirs");
    expect(useFiles.getState().runs).toEqual([]);
  });
});

/*
 * An account larger than one read of it.
 *
 * The account-wide read is a *page*, not a promise: past its ceiling the walk
 * sees a thousand nodes and not the ones after them. What that costs is a
 * folder the walk cannot see -- so it tries a create the server refuses with
 * the id of the folder that is there, and takes it: one request per level that
 * was past the page, and nothing else.
 *
 * A **file** is not exposed to the read at all. What a name meets is the
 * create's own answer, which names the node holding it from wherever in the
 * account it is, so a file the truncated read could not see is written over
 * just the same, and neither of these cases depends on the read.
 */
describe("an account past the read's ceiling", () => {
  /**
   * More nodes than one read returns, so the account read comes back a page.
   *
   * `where` decides whether the nodes that matter are inside that page or past
   * it, and the difference is the whole point of these cases: a node the page
   * reached is one the walk can see, and a node past it is one it cannot -- so
   * only the second exercises the refusal-and-look-again path a real account at
   * this size puts the walk through.
   */
  const oversize = (
    extra: Array<Record<string, unknown>>,
    where: "within" | "past" = "past",
  ) => {
    const pad = Array.from({ length: LEVEL_LIMIT + 5 }, (_, i) =>
      node(`pad-${i}`, `pad-${i}.txt`, "file"),
    );
    return where === "past" ? [...pad, ...extra] : [...extra, ...pad];
  };

  it("writes over a file the truncated read could not see", async () => {
    const s = server(
      oversize([
        node("d1", "folder", "directory"),
        node("f1", "known.txt", "file", "d1"),
      ]),
      { truncateScan: true },
    );

    await useFiles.getState().uploadPlan(null, {
      files: [{ file: file("known.txt"), path: ["folder"] }],
      dirs: [["folder"]],
    });

    /*
     * Two nodes of this case are past the page -- the folder and the file in it
     * -- and the read answers for neither. The folder is recovered by the
     * refusal of its create, which is the one level read of this run; the file
     * needs nothing at all, because the refusal of *its* create names the node
     * holding the name. So the bytes go into the file that was there, and the
     * drop reports nothing.
     */
    expect(s.levelReads).toHaveLength(1);
    expect(s.updates).toEqual(["f1"]);
    expect(s.blobs).toEqual([BROWSE]);
    expect(useFiles.getState().runs).toEqual([]);
  });

  it("reuses a folder the truncated read could not see, without creating a second", async () => {
    const s = server(
      oversize([node("d1", "folder", "directory"), node("d2", "sub", "directory", "d1")]),
      { truncateScan: true },
    );

    await useFiles.getState().uploadPlan(null, {
      files: [{ file: file("new.txt"), path: ["folder", "sub"] }],
      dirs: [["folder"], ["folder", "sub"]],
    });

    // Not one folder was created: the refusals taught the walk what was there.
    expect(s.created.filter((c) => c.nodeType === "directory")).toEqual([]);
    expect(s.nodes.find((n) => n.name === "new.txt")!.parentId).toBe("d2");
  });

  it("asks the account once, and lists no folder the files go into", async () => {
    // Inside the page, so the walk finds the folder in the scan and the account
    // read is the only one there is.
    const s = server(oversize([node("d1", "folder", "directory")], "within"), {
      truncateScan: true,
    });

    await useFiles.getState().uploadPlan(null, {
      files: [
        { file: file("a.txt"), path: ["folder"] },
        { file: file("b.txt"), path: ["folder"] },
      ],
      dirs: [["folder"]],
    });

    // One account read, and nothing listed for the files however many of them
    // go into one folder: what each of them meets is the answer to its own
    // create, which is the only thing that knows the names in that level.
    expect(s.scans).toHaveLength(1);
    expect(s.levelReads).toEqual([]);
    expect(s.blobs).toHaveLength(2);
  });

  it("asks the account once and no level read at all when the read was whole", async () => {
    const s = server([
      node("d1", "folder", "directory"),
      node("d2", "sub", "directory", "d1"),
    ]);

    await useFiles.getState().uploadPlan(null, {
      files: [
        { file: file("a.txt"), path: ["folder"] },
        { file: file("b.txt"), path: ["folder", "sub"] },
      ],
      dirs: [["folder"], ["folder", "sub"]],
    });

    // The whole point of the scan: a tree of any depth costs one request -- a
    // folder the read reached is one the walk knows, and the files it holds are
    // none of the read's business.
    expect(s.scans).toHaveLength(1);
    expect(s.levelReads).toEqual([]);
    // No folder made: both were there, and the scan knew it.
    expect(s.created.filter((c) => c.nodeType === "directory")).toEqual([]);
    expect(s.nodes.find((n) => n.name === "a.txt")!.parentId).toBe("d1");
    expect(s.nodes.find((n) => n.name === "b.txt")!.parentId).toBe("d2");
  });
});

/*
 * The picker asks the same question and gets the same answer.
 *
 * A selection from the file picker is not a tree, but it is the same gesture as
 * far as a name is concerned: the files land in the folder that is open, and one
 * of them landing on a name the folder already holds is written over rather than
 * refused. The one writer both paths use is what makes that true, so this pins
 * the picker's side of it rather than leaving the two to drift apart.
 */
describe("a name the open folder already holds, from the picker", () => {
  it("writes over it, as a drop does", async () => {
    const s = server([
      node("d1", "folder", "directory"),
      node("f1", "known.txt", "file", "d1"),
    ]);

    await useFiles.getState().upload("d1", [file("known.txt")]);

    expect(s.updates).toEqual(["f1"]);
    expect(s.blobs).toEqual([BROWSE]);
    expect(useFiles.getState().runs).toEqual([]);
  });
});
