import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { LEVEL_LIMIT, useFiles } from "@/store/files";

/**
 * A folder dropped onto a folder that is already there.
 *
 * What the reader means by it is "make this tree here": the folders that exist
 * are used as they are, the folders that do not are created, and a file whose
 * name is taken is refused rather than duplicated or replaced. Getting it wrong
 * is not subtle -- a create of a folder that exists is refused by the server,
 * and a caller that treats every refusal as "then upload to the parent" leaves
 * the subfolder at the top level with its files loose beside it, which is a copy
 * that is not the tree that was dropped.
 *
 * The mock refuses a duplicate name the way Stalwart does (`alreadyExists`),
 * so the case is exercised against the refusal rather than against a fixture
 * that agrees with the code.
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
 * A server holding one folder tree, answering the two calls a drop makes:
 * the listing of a level, and the create of a directory or a file.
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
 * `levelPage` does the same to a single-level read, which is the other ceiling
 * in play: `ids` is how many the query answers (so the page looks full) while
 * `nodes` is how many the `get` resolved, which is how a folder larger than one
 * page of `maxObjectsInGet` reaches a reader.
 *
 * The two counts are the drop's **own** reads, not every request the store
 * makes: a drop ends by reloading the folder it landed in and the sidebar tree,
 * and counting those would make the numbers say nothing about the drop. A names
 * read is told apart by the properties it asks for -- the drop wants `parentId`
 * and three others, where a view listing wants `fileNodeProps()`, and the
 * `properties` of the `get` is what the server sees either way. The two tests
 * that assert these counts do so in opposite directions, so a discriminator that
 * stopped recognising reads would fail one of them rather than pass both
 * vacuously.
 */
function server(
  seed: Array<Record<string, unknown>>,
  opts: {
    race?: boolean;
    truncateScan?: boolean;
    levelPage?: { ids: number; nodes: number };
  } = {},
) {
  const nodes = [...seed];
  const created: Array<{ name: string; nodeType: string }> = [];
  const uploads: string[] = [];
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
    /*
     * A level read whose query answers a full page while its `get` resolves
     * only some of it: the ids are the page, the nodes are what came back. Both
     * are real answers, and they disagree -- which is the state the completeness
     * rule has to be able to see.
     */
    let ids = list.map((n) => n.id);
    if (filter && opts.levelPage) {
      ids = Array.from({ length: opts.levelPage.ids }, (_, i) => `id-${i}`);
      total = opts.levelPage.ids;
      list = list.slice(0, opts.levelPage.nodes);
    }
    return new Map([
      ["q", [{ ids, total }]],
      ["g", [{ list, state: "1" }]],
    ]);
  }) as never);

  vi.spyOn(client, "call").mockImplementation((async (
    _method: string,
    args: { create?: Record<string, Record<string, unknown>> },
  ) => {
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
    if (list_(parentId).some((n) => n.name === name))
      return { notCreated: { [key]: { type: "alreadyExists" } } };
    const id = `new-${next++}`;
    nodes.push({ id, name, parentId, nodeType: body!.nodeType });
    created.push({ name, nodeType: String(body!.nodeType) });
    return { created: { [key]: { id } } };
  }) as never);

  vi.spyOn(client, "upload").mockImplementation((async (accountId: string) => {
    uploads.push(accountId);
    return { accountId, blobId: `blob-${uploads.length}`, type: "text/plain", size: 5 };
  }) as never);

  return { created, uploads, nodes, scans, levelReads };
}

afterEach(() => {
  vi.restoreAllMocks();
  useFiles.setState({ accountId: BROWSE, ownAccountId: BROWSE, uploads: [] });
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
   * The refusal the reader is shown. The file is not uploaded at all -- Stalwart
   * charges for every blob and never gives one back, so a name that is already
   * taken is a write worth not making -- and the row that says so stays in the
   * tray, where a failure can be read twice rather than fading.
   */
  it("refuses a file whose name the folder already holds, before uploading it", async () => {
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

    // One blob for the two files: the duplicate cost nothing.
    expect(s.uploads).toEqual([BROWSE]);
    const rows = useFiles.getState().uploads;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("known.txt");
    expect(rows[0]!.error).toMatch(/already here/);
    // And the file that was not a duplicate went up.
    expect(s.nodes.some((n) => n.name === "fresh.txt")).toBe(true);
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

    expect(s.uploads).toEqual([]);
    expect(s.nodes.some((n) => n.name === "inside.txt")).toBe(false);
    // Nothing was dropped at the top level in its place either.
    expect(s.nodes.filter((n) => n.name === "inside.txt")).toEqual([]);
    const rows = useFiles.getState().uploads;
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
    expect(useFiles.getState().uploads).toEqual([]);
  });
});

/*
 * An account larger than one read of it.
 *
 * The account-wide read is a *page*, not a promise: past its ceiling the walk
 * sees a thousand nodes and not the ones after them. What that costs depends on
 * the question being asked, and the two questions a drop asks are not equally
 * forgiving.
 *
 * A folder resolved from a partial read costs a create the server refuses, and
 * the refusal sends the walk back to read the level for real -- so the short
 * read is recoverable. A **file** checked against a partial read is not: the
 * name it cannot see is a blob already uploaded and about to be refused. That
 * asymmetry is what these four cases pin, and the first of them fails without
 * the fix: the file is paid for, uploaded, and refused afterwards.
 */
describe("an account past the read's ceiling", () => {
  /** More nodes than one read returns, so the account read comes back a page. */
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

  it("refuses a file the truncated read could not see, without uploading it", async () => {
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

    // The blob was never bought: this is the assertion the fix is for, and it
    // is the one that fails when the level is not read for itself.
    expect(s.uploads).toEqual([]);
    const rows = useFiles.getState().uploads;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("known.txt");
    expect(rows[0]!.error).toMatch(/already here/);
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

  it("reads the level it writes into once, and asks the account once", async () => {
    // Inside the page, so the count is about one thing only: the walk finds the
    // folder in the scan, and the single level read below is the one the files
    // need. (Past the page it would be two -- the refusal, which makes the walk
    // look again at the level the folder is in, and then this one.)
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

    // One account read, and one read of the folder the files go into -- however
    // many files go into it. The narrowing is per level written into, not per
    // file and not per folder named.
    expect(s.scans).toHaveLength(1);
    expect(s.levelReads).toHaveLength(1);
    expect(s.uploads).toHaveLength(2);
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

    // The whole point of the scan: a tree of any depth costs one request, the
    // level the files go into included -- an account the read finished is
    // authoritative for every level, so a folder with no bucket in it is empty
    // and costs nothing to ask about.
    expect(s.scans).toHaveLength(1);
    expect(s.levelReads).toEqual([]);
    // No folder made: both were there, and the scan knew it.
    expect(s.created.filter((c) => c.nodeType === "directory")).toEqual([]);
    expect(s.nodes.find((n) => n.name === "a.txt")!.parentId).toBe("d1");
    expect(s.nodes.find((n) => n.name === "b.txt")!.parentId).toBe("d2");
  });
});

/*
 * What a *page* of a level is worth to the duplicate check.
 *
 * A level larger than one read of it answers with a page and no more. The
 * tempting reading of that is "the list is incomplete, so it cannot be trusted
 * and the check must be skipped" -- which is wrong, and wrong in a way that
 * costs money: every entry in the page is a FileNode the server really returned
 * for that level, so a name found there really is taken and refusing it early
 * is correct. The only thing an incomplete page cannot do is *reach* a
 * duplicate, and skipping the check would not reach it either -- it would just
 * give up the refusals the page could have made for free.
 *
 * So what is asserted here is the observable that tells the two apart: with the
 * duplicate inside the page, the blob is never uploaded. The opposite design
 * uploads it, gets refused afterwards, and pays.
 */
describe("a level larger than one read of it", () => {
  it("refuses a duplicate its page did reach, without uploading it", async () => {
    const s = server(
      [node("d1", "folder", "directory"), node("f1", "known.txt", "file", "d1")],
      { levelPage: { ids: LEVEL_LIMIT, nodes: 1 } },
    );

    await useFiles.getState().upload("d1", [file("known.txt")]);

    // Not one blob: the page held the name, and a page is enough to refuse on.
    expect(s.uploads).toEqual([]);
    const rows = useFiles.getState().uploads;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("known.txt");
    expect(rows[0]!.error).toMatch(/already here/);
  });
});
