import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTrashDocument } from "@gilbert/shared/trash";
import { client } from "@/jmap/client";
import { useFiles } from "@/store/files";
import { useSession } from "@/store/session";

/**
 * Deleting in Files is a move into the account's Trash, and emptying or ending
 * what is in it is the reader's own action or an administrator's (ADR 0013).
 *
 * The server here is a fake one that holds a flat list of nodes and applies a
 * `FileNode/set` the way Stalwart does — including refusing a destroy that does
 * not cascade on a folder still holding something. What the assertions read is
 * the record: what was updated, what was created, what was destroyed, and the
 * `trash.json` the app folder ended up holding.
 *
 * Each case fails if the mechanism it names is removed: a delete that destroyed
 * would show up as a destroy call, a restore that forgot the origin would put
 * the node at the top level, and a guard taken off `emptyTrash` would let a
 * member's empty reach the server.
 */

const OWN = "acc-own";
const GROUP = "acc-group";

type Obj = Record<string, unknown> & { id: string };

const dir = (id: string, name: string, parentId: string | null): Obj => ({
  id,
  name,
  nodeType: "directory",
  parentId,
  myRights: {},
});

const file = (id: string, name: string, parentId: string | null): Obj => ({
  id,
  name,
  nodeType: "file",
  parentId,
  blobId: `b-${id}`,
  myRights: {},
});

/** A fake account: a flat list of nodes, the sets it took and the blobs it holds. */
function server(seed: Obj[]) {
  const nodes = seed.map((n) => ({ ...n }));
  const sets: Array<Record<string, unknown>> = [];
  const blobs = new Map<string, string>();
  let next = 0;

  vi.spyOn(client, "chain").mockImplementation((async (batch: unknown[]) => {
    const [, query] = batch[0] as [string, { filter?: Record<string, unknown> }];
    const filter = query.filter ?? {};
    const list = nodes.filter((n) =>
      "parentId" in filter ? n.parentId === filter.parentId : n.parentId == null,
    );
    return new Map([
      ["q", [{ ids: list.map((n) => n.id), total: list.length }]],
      ["g", [{ list, state: "1" }]],
    ]);
  }) as never);

  vi.spyOn(client, "call").mockImplementation((async (method: string, raw: unknown) => {
    const args = raw as {
      ids?: string[];
      create?: Record<string, Obj>;
      update?: Record<string, Record<string, unknown>>;
      destroy?: string[];
      onDestroyRemoveChildren?: boolean;
    };
    if (method === "FileNode/get")
      return { list: nodes.filter((n) => (args.ids ?? []).includes(n.id)) };
    if (method !== "FileNode/set") return {};
    sets.push(args as Record<string, unknown>);
    const created: Record<string, Obj> = {};
    for (const [key, props] of Object.entries(args.create ?? {})) {
      const node = { id: `new-${next++}`, myRights: {}, ...props } as Obj;
      nodes.push(node);
      created[key] = node;
    }
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
        notDestroyed[id] = { type: "nodeHasChildren" };
        continue;
      }
      for (const kid of kids) nodes.splice(nodes.indexOf(kid), 1);
      nodes.splice(nodes.indexOf(held), 1);
    }
    return {
      created,
      updated: {},
      destroyed: (args.destroy ?? []).filter((id) => !(id in notDestroyed)),
      ...(Object.keys(notDestroyed).length ? { notDestroyed } : {}),
    };
  }) as never);

  vi.spyOn(client, "upload").mockImplementation((async (_account: string, blob: Blob) => {
    const blobId = `blob-${blobs.size + 1}`;
    blobs.set(blobId, await blob.text());
    return { accountId: OWN, blobId, type: "application/json", size: 1 };
  }) as never);

  vi.spyOn(client, "fetchBlobText").mockImplementation(
    (async (_account: string, blobId: string) => blobs.get(blobId) ?? "") as never,
  );

  /** A document of the app folder, parsed, by the name it was written under. */
  const document = (name: string): unknown => {
    const node = nodes.find((n) => n.name === name && typeof n.blobId === "string");
    if (!node) return null;
    try {
      return JSON.parse(blobs.get(String(node.blobId)) ?? "null");
    } catch {
      return null;
    }
  };

  return { nodes, sets, document };
}

/** Browse an account with the nodes a test seeded. */
function browse(accountId: string, ownAccountId: string, nodes: Obj[]): void {
  useFiles.setState({
    accountId,
    ownAccountId,
    available: true,
    initialized: true,
    /*
     * Copies, not the fake's own objects: the store has to answer from what it
     * last read, the way a real one does. A fake that handed its own nodes over
     * would mutate them under the store the moment a write landed, and the
     * move's own origin would be read after the node had already arrived.
     */
    nodes: Object.fromEntries(nodes.map((n) => [n.id, { ...n }])) as never,
    children: {},
    dirIds: [],
    treeLoaded: false,
    runs: [],
    error: null,
  });
}

function signedInAs(isAdmin: boolean): void {
  useSession.setState({ session: { gilbert: { isAdmin } } as never });
}

afterEach(() => {
  vi.restoreAllMocks();
  useFiles.setState({
    accountId: null,
    ownAccountId: null,
    nodes: {},
    children: {},
    dirIds: [],
    treeLoaded: false,
    runs: [],
    error: null,
  });
  useSession.setState({ session: null });
});

describe("deleting in Files", () => {
  it("moves the node into the account's Trash, with its subtree, and remembers the folder it came from", async () => {
    const fake = server([
      dir("work", "Work", null),
      dir("docs", "Docs", "work"),
      file("a", "a.txt", "docs"),
    ]);
    browse(OWN, OWN, fake.nodes);

    await useFiles.getState().trash(["docs"]);

    const trash = fake.nodes.find((n) => n.name === "Trash");
    expect(trash?.parentId).toBeNull();
    expect(fake.nodes.find((n) => n.id === "docs")?.parentId).toBe(trash?.id);
    // The subtree never moved: a folder is one node and its children stay in it.
    expect(fake.nodes.find((n) => n.id === "a")?.parentId).toBe("docs");
    // Nothing was destroyed — the difference this change is about.
    expect(
      fake.sets.flatMap((s) => (s.destroy as string[] | undefined) ?? []).length,
    ).toBe(0);
    expect(parseTrashDocument(fake.document("trash.json")).origins).toEqual({
      docs: { parentId: "work", name: "Docs", as: "Docs" },
    });
    // The listing on screen now holds it, so the Trash is where the reader sees it.
    expect(useFiles.getState().children[String(trash?.id)]).toContain("docs");
  });

  it("numbers a name the Trash already holds rather than refusing the delete", async () => {
    const fake = server([
      dir("trash", "Trash", null),
      file("one", "report.pdf", "trash"),
      file("two", "report.pdf", null),
    ]);
    browse(OWN, OWN, fake.nodes);

    await useFiles.getState().trash(["two"]);

    expect(fake.nodes.find((n) => n.id === "two")?.name).toBe("report (2).pdf");
    expect(fake.nodes.find((n) => n.id === "one")?.name).toBe("report.pdf");
  });

  it("never moves the Trash folder itself", async () => {
    const fake = server([dir("trash", "Trash", null)]);
    browse(OWN, OWN, fake.nodes);

    await useFiles.getState().trash(["trash"]);

    expect(fake.sets).toHaveLength(0);
  });
});

describe("restoring from the Trash", () => {
  it("puts a folder back where it came from, whole, and forgets the origin", async () => {
    const fake = server([
      dir("work", "Work", null),
      dir("docs", "Docs", "work"),
      file("a", "a.txt", "docs"),
    ]);
    browse(OWN, OWN, fake.nodes);

    await useFiles.getState().trash(["docs"]);
    await useFiles.getState().restore(["docs"]);

    expect(fake.nodes.find((n) => n.id === "docs")?.parentId).toBe("work");
    expect(fake.nodes.find((n) => n.id === "a")?.parentId).toBe("docs");
    expect(parseTrashDocument(fake.document("trash.json")).origins).toEqual({});
  });

  it("brings each node's own name back when the move is what numbered it", async () => {
    const fake = server([
      dir("work", "Work", null),
      dir("home", "Home", null),
      file("one", "report.pdf", "work"),
      file("two", "report.pdf", "home"),
    ]);
    browse(OWN, OWN, fake.nodes);

    await useFiles.getState().trash(["one", "two"]);
    expect(fake.nodes.find((n) => n.id === "two")?.name).toBe("report (2).pdf");

    await useFiles.getState().restore(["one", "two"]);

    expect(fake.nodes.find((n) => n.id === "one")?.parentId).toBe("work");
    expect(fake.nodes.find((n) => n.id === "one")?.name).toBe("report.pdf");
    expect(fake.nodes.find((n) => n.id === "two")?.parentId).toBe("home");
    expect(fake.nodes.find((n) => n.id === "two")?.name).toBe("report.pdf");
  });

  it("keeps a name given inside the Trash when the node comes back", async () => {
    const fake = server([dir("work", "Work", null), file("one", "report.pdf", "work")]);
    browse(OWN, OWN, fake.nodes);

    await useFiles.getState().trash(["one"]);
    // The reader renames it while it sits in the Trash.
    const held = fake.nodes.find((n) => n.id === "one")!;
    held.name = "final.pdf";

    await useFiles.getState().restore(["one"]);

    expect(fake.nodes.find((n) => n.id === "one")?.name).toBe("final.pdf");
    expect(fake.nodes.find((n) => n.id === "one")?.parentId).toBe("work");
  });
});

describe("the Trash as a node of its own", () => {
  it("is never trashed, moved, renamed or merged", async () => {
    const fake = server([
      dir("trash", "Trash", null),
      dir("work", "Work", null),
      file("f", "a.txt", "work"),
    ]);
    browse(OWN, OWN, fake.nodes);
    signedInAs(false);

    await useFiles.getState().trash(["trash"]);
    await expect(useFiles.getState().moveMany(["trash"], null)).rejects.toThrow(
      /cannot be moved/,
    );
    await expect(useFiles.getState().rename("trash", "Elsewhere")).rejects.toThrow(
      /cannot be renamed/,
    );
    await expect(useFiles.getState().mergeFolders("trash", "work")).rejects.toThrow(
      /trash/i,
    );
    await expect(useFiles.getState().mergeFolders("work", "trash")).rejects.toThrow(
      /trash/i,
    );
    expect(fake.sets).toHaveLength(0);
  });
});

describe("ending what is in the Trash", () => {
  it("refuses a group's trash to a member before any call reaches the server", async () => {
    const fake = server([dir("trash", "Trash", null), file("f", "a.txt", "trash")]);
    browse(GROUP, OWN, fake.nodes);
    signedInAs(false);

    await expect(useFiles.getState().emptyTrash()).rejects.toThrow(/administrator/i);
    await expect(useFiles.getState().destroyForever(["f"])).rejects.toThrow(
      /administrator/i,
    );
    expect(fake.sets.filter((s) => "destroy" in s)).toHaveLength(0);
  });

  it("lets an administrator empty a group's trash", async () => {
    const fake = server([dir("trash", "Trash", null), file("f", "a.txt", "trash")]);
    browse(GROUP, OWN, fake.nodes);
    signedInAs(true);

    await useFiles.getState().emptyTrash();

    expect(fake.nodes.find((n) => n.id === "f")).toBeUndefined();
    expect(fake.nodes.find((n) => n.id === "trash")).toBeDefined();
    /* An emptied Trash remembers nothing at all. */
    expect(parseTrashDocument(fake.document("trash.json")).origins).toEqual({});
  });

  it("lets the reader end one item of their own trash for good", async () => {
    const fake = server([dir("trash", "Trash", null), file("f", "a.txt", "trash")]);
    browse(OWN, OWN, fake.nodes);
    signedInAs(false);

    await useFiles.getState().destroyForever(["f"]);

    expect(fake.nodes.find((n) => n.id === "f")).toBeUndefined();
  });

  it("ends a node deeper inside the trash, not only what sits at its top level", async () => {
    const fake = server([
      dir("trash", "Trash", null),
      dir("photos", "Photos", "trash"),
      file("f", "a.txt", "photos"),
    ]);
    browse(OWN, OWN, fake.nodes);
    signedInAs(false);

    await useFiles.getState().destroyForever(["f"]);

    expect(fake.nodes.find((n) => n.id === "f")).toBeUndefined();
    expect(fake.nodes.find((n) => n.id === "photos")).toBeDefined();
  });
});
