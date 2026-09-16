import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useFiles } from "@/store/files";

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

/**
 * A server holding one folder tree, answering the two calls a drop makes:
 * the listing of a level, and the create of a directory or a file.
 *
 * `race` makes the first directory create lose: the name is already taken by a
 * folder that appeared between the listing and the create, which is the answer
 * a second worker gets. It is off by default so the ordinary path is the
 * ordinary path.
 */
function server(seed: Array<Record<string, unknown>>, opts: { race?: boolean } = {}) {
  const nodes = [...seed];
  const created: Array<{ name: string; nodeType: string }> = [];
  const uploads: string[] = [];
  let next = 1;
  let raced = false;

  const list_ = (parentId: string | null) =>
    nodes.filter((n) => (n.parentId ?? null) === parentId);

  vi.spyOn(client, "chain").mockImplementation((async (calls: unknown[]) => {
    const [, args] = calls[0] as [string, { filter: Record<string, unknown> }];
    const parentId = (args.filter.parentId as string | null) ?? null;
    const list = list_(parentId);
    return new Map([
      ["q", [{ ids: list.map((n) => n.id), total: list.length }]],
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

  return { created, uploads, nodes };
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
