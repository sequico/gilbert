import { appDocumentJson } from "@gilbert/shared/appDocument";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { client, JmapMethodError } from "@/jmap/client";
import {
  findInFolder,
  findInFolderWithState,
  isStateMismatch,
  putFile,
  writeAppJson,
} from "../appFolder";

/**
 * The writer for a named file in a folder, at the level the writes actually
 * happen.
 *
 * `putFile` is the one place this client decides between creating a node and
 * updating one, and the one place a conditional write is made. What is tested
 * here is that decision and that condition, against a FileNode store small
 * enough to read: the mock server is where this code meets a real protocol, and
 * a test through `writeAppJson` or a store would leave the writer's own refusals
 * — a `notUpdated` object and a lost compare-and-set — unexercised.
 */

const ACCOUNT = "a1";
const FOLDER = "af";
const TYPE = "application/json";

interface FakeNode {
  id: string;
  parentId: string | null;
  name: string;
  nodeType: "file" | "directory";
  blobId: string | null;
  type: string | null;
  size: number | null;
}

/** The app folder itself: a top-level directory by the name `ensureFolder` looks for. */
const APP_FOLDER_NODE: FakeNode = {
  id: FOLDER,
  parentId: null,
  name: "gilbert",
  nodeType: "directory",
  blobId: null,
  type: null,
  size: null,
};

function file(id: string, name: string, blobId: string): FakeNode {
  return {
    id,
    parentId: FOLDER,
    name,
    nodeType: "file",
    blobId,
    type: TYPE,
    size: 12,
  };
}

/** A node as a bag of properties, for the `/get` projection this store answers. */
const asRecord = (node: object): Record<string, unknown> =>
  node as unknown as Record<string, unknown>;

/**
 * A FileNode store with the three behaviours the writer depends on.
 *
 * `ifInState` is compared against the account's state and a stale token refuses
 * the whole call with `stateMismatch` — what Stalwart 0.16 does rather than
 * masking it as `invalidArguments` (live, `scripts/probe-conditional-writes.mjs`)
 * and what the server mock reproduces — a create answers without a `blobId`
 * (0.16 does not return one, so the writer has to ask), and a write that lands
 * moves the state, so the token taken before it is refused after it.
 */
function fakeServer(files: FakeNode[] = []) {
  const nodes: FakeNode[] = [APP_FOLDER_NODE, ...files];
  const uploads: Array<{ type?: string; text: string }> = [];
  const setCalls: Array<Record<string, unknown>> = [];
  const asked: Array<string[] | undefined> = [];
  let seq = 0;
  let state = 1;
  let refuseUpdates = false;
  /** Another tab's save, run just before the next set: a race, in order. */
  let otherTabWrite: string | null = null;

  const stateOf = () => `s${state}`;

  vi.spyOn(client, "chain").mockImplementation(async (calls) => {
    const out = new Map<string, Record<string, unknown>[]>();
    let lastIds: string[] = [];
    for (const [method, args, id] of calls) {
      if (method === "FileNode/query") {
        const filter = (args.filter ?? {}) as { parentId?: string };
        const matched = nodes.filter((n) =>
          filter.parentId ? n.parentId === filter.parentId : n.parentId === null,
        );
        lastIds = matched.map((n) => n.id);
        out.set(id, [
          {
            accountId: ACCOUNT,
            queryState: "1",
            canCalculateChanges: false,
            position: 0,
            ids: lastIds,
            total: matched.length,
          },
        ]);
      } else if (method === "FileNode/get") {
        const properties = args.properties as string[] | undefined;
        asked.push(properties);
        const ids = args["#ids"]
          ? lastIds
          : ((args.ids as string[] | null) ?? nodes.map((n) => n.id));
        const matched = nodes.filter((n) => ids.includes(n.id));
        out.set(id, [
          {
            accountId: ACCOUNT,
            state: stateOf(),
            // Only the properties the node carries, the way a real `/get`
            // answers: `state` is the response's, not the node's.
            list: matched.map((n) => {
              const picked: Record<string, unknown> = { id: n.id };
              for (const key of properties ?? Object.keys(n))
                if (key in n) picked[key] = asRecord(n)[key];
              return picked;
            }),
            notFound: [],
          },
        ]);
      }
    }
    return out;
  });

  vi.spyOn(client, "call").mockImplementation((async (
    method: string,
    args: Record<string, unknown>,
  ) => {
    if (method === "FileNode/get") {
      const ids = (args.ids as string[] | undefined) ?? [];
      return {
        accountId: ACCOUNT,
        state: stateOf(),
        list: nodes
          .filter((n) => ids.includes(n.id))
          .map((n) => ({ id: n.id, blobId: n.blobId })),
        notFound: [],
      };
    }
    if (method !== "FileNode/set") return { accountId: ACCOUNT };
    setCalls.push(args);
    // The other tab's save lands here, between this writer's read and its write.
    if (otherTabWrite !== null) {
      const node = nodes.find((n) => n.id === "n1");
      if (node) {
        node.blobId = otherTabWrite;
      } else {
        nodes.push({
          id: "other-1",
          parentId: FOLDER,
          name: "settings.json",
          nodeType: "file",
          blobId: otherTabWrite,
          type: TYPE,
          size: 12,
        });
      }
      otherTabWrite = null;
      state += 1;
    }
    const token = args.ifInState as string | undefined;
    if (token !== undefined && token !== stateOf()) {
      throw new JmapMethodError("FileNode/set", {
        type: "stateMismatch",
        description: "An ifInState argument was supplied, but it does not match",
      });
    }
    const created: Record<string, unknown> = {};
    const update = args.update as
      | Record<string, { blobId?: string; type?: string }>
      | undefined;
    const notUpdated: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    if (update)
      for (const [id, patch] of Object.entries(update)) {
        const node = nodes.find((n) => n.id === id);
        if (refuseUpdates || !node) {
          notUpdated[id] = refuseUpdates
            ? { type: "forbidden", description: "This node is read-only" }
            : { type: "notFound" };
          continue;
        }
        if (patch.blobId !== undefined) node.blobId = patch.blobId;
        if (patch.type !== undefined) node.type = patch.type;
        updated[id] = null;
      }
    const create = args.create as
      | Record<string, { parentId: string; name: string; blobId: string; type: string }>
      | undefined;
    if (create)
      for (const [key, node] of Object.entries(create)) {
        const id = `made-${++seq}`;
        nodes.push({
          id,
          parentId: node.parentId,
          name: node.name,
          nodeType: "file",
          blobId: node.blobId,
          type: node.type,
          size: 0,
        });
        // No `blobId` on a create: 0.16 does not return one.
        created[key] = { id };
      }
    if (Object.keys(created).length || Object.keys(updated).length) state += 1;
    return {
      accountId: ACCOUNT,
      oldState: stateOf(),
      newState: stateOf(),
      created,
      updated,
      notUpdated,
      destroyed: [],
    };
  }) as never);

  vi.spyOn(client, "upload").mockImplementation(async (_accountId, data, opts) => {
    // jsdom's Blob has no `text()`, so a reader reads it.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(data as Blob);
    });
    uploads.push({ type: opts?.type, text });
    return {
      accountId: ACCOUNT,
      blobId: `blob-${++seq}`,
      type: TYPE,
      size: text.length,
    } as never;
  });

  return {
    nodes,
    uploads,
    setCalls,
    asked,
    state: stateOf,
    node: (id: string) => nodes.find((n) => n.id === id),
    names: () => nodes.filter((n) => n.parentId === FOLDER).map((n) => n.name),
    /** The server refuses every update, the way a read-only node is refused. */
    refuseUpdates: () => {
      refuseUpdates = true;
    },
    /** Another tab saves this blob before the next set: the CAS has a loser. */
    otherTabSaves: (blobId: string) => {
      otherTabWrite = blobId;
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("finding a file in the app folder", () => {
  it("answers with the node and the FileNode state the read saw", async () => {
    const server = fakeServer([file("n1", "settings.json", "b1")]);
    const node = await findInFolder(ACCOUNT, FOLDER, "settings.json");
    expect(node?.blobId).toBe("b1");
    // The token a conditional write compares: without it a caller can find the
    // document it means to replace and still have nothing to write against.
    expect(node?.state).toBe(server.state());
    // Asked for by name as well, so a server carrying it on the node answers
    // the same question in the same read.
    expect(server.asked[0]).toContain("state");
  });

  it("answers undefined for a name the folder does not hold", async () => {
    fakeServer();
    expect(await findInFolder(ACCOUNT, FOLDER, "settings.json")).toBeUndefined();
  });

  it("answers a state even when no file carries that name", async () => {
    const server = fakeServer();
    const found = await findInFolderWithState(ACCOUNT, FOLDER, "settings.json");
    expect(found.file).toBeUndefined();
    // The token a first save compares against, so the create it makes is
    // conditional as well.
    expect(found.state).toBe(server.state());
  });
});

describe("writing a file into the app folder", () => {
  it("creates the file when the name is new", async () => {
    const server = fakeServer();
    const written = await putFile(ACCOUNT, FOLDER, "settings.json", "b7", TYPE);
    expect(server.names()).toEqual(["settings.json"]);
    expect(server.node(written.id)?.blobId).toBe("b7");
    // The node the create made has no blobId of its own, so the writer asks for
    // the persistent one rather than reporting the upload's.
    expect(written.blobId).toBe("b7");
  });

  it("updates the file that is already there instead of making a second one", async () => {
    const server = fakeServer([file("n1", "settings.json", "b1")]);
    const written = await putFile(ACCOUNT, FOLDER, "settings.json", "b2", TYPE);
    expect(written.id).toBe("n1");
    expect(server.names()).toEqual(["settings.json"]);
    expect(server.node("n1")?.blobId).toBe("b2");
    expect(server.setCalls[0]?.update).toEqual({ n1: { blobId: "b2", type: TYPE } });
  });

  it("raises the server's own words when it refuses the update", async () => {
    const server = fakeServer([file("n1", "settings.json", "b1")]);
    server.refuseUpdates();
    await expect(putFile(ACCOUNT, FOLDER, "settings.json", "b2", TYPE)).rejects.toThrow(
      /read-only/,
    );
    // A refused update leaves the node exactly as it was.
    expect(server.node("n1")?.blobId).toBe("b1");
  });

  it("refuses a write whose state has moved, and leaves the winner's node alone", async () => {
    const server = fakeServer([file("n1", "settings.json", "b1")]);
    const node = await findInFolder(ACCOUNT, FOLDER, "settings.json");
    // The second tab saves after this read and before this write, which is the
    // whole reason a token is passed at all.
    server.otherTabSaves("b-other");
    const err = await putFile(ACCOUNT, FOLDER, "settings.json", "b9", TYPE, {
      ifInState: node?.state,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isStateMismatch(err)).toBe(true);
    // The token went out with the write, and the write did not land: the other
    // tab's save is still what the account holds.
    expect(server.setCalls[0]?.ifInState).toBe(node?.state);
    expect(server.node("n1")?.blobId).toBe("b-other");
  });

  it("lands on top of the other writer when nothing was asked to be compared", async () => {
    const server = fakeServer([file("n1", "settings.json", "b1")]);
    server.otherTabSaves("b-other");
    await putFile(ACCOUNT, FOLDER, "settings.json", "b9", TYPE);
    // The unconditional write replaces whatever is there — which is what a
    // caller that passes no token is choosing, and why the settings writer
    // passes one.
    expect(server.node("n1")?.blobId).toBe("b9");
    expect(server.setCalls[0]?.ifInState).toBeUndefined();
  });

  it("refuses a create whose state has moved, rather than making a second file", async () => {
    const server = fakeServer();
    const { state } = await findInFolderWithState(ACCOUNT, FOLDER, "settings.json");
    // Another writer made the file between the read that found nothing and the
    // create that meant to make it.
    server.otherTabSaves("b-other");
    const err = await putFile(ACCOUNT, FOLDER, "settings.json", "b9", TYPE, {
      ifInState: state,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isStateMismatch(err)).toBe(true);
    // The account holds the other writer's file and only that one: this create
    // made no second `settings.json`, which is the node nothing would read.
    expect(server.names()).toEqual(["settings.json"]);
    expect(server.node("other-1")?.blobId).toBe("b-other");
  });

  it("uploads a document as the bytes both tiers write", async () => {
    const server = fakeServer();
    const doc = { v: 1, theme: "dark", defaultIdentityByAccount: { a1: "i7" } };
    await writeAppJson(ACCOUNT, "settings.json", doc);
    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0]?.type).toBe(TYPE);
    /*
     * The server's writer (`uploadJsonBlob`, `server/src/appFolder.ts`) uploads
     * the same document through the same function, so one document is one
     * sequence of bytes whichever tier wrote it. This comparison is only worth
     * making because the canonical form is not the platform's default one: a
     * writer that stopped importing it and spelled its own `JSON.stringify`
     * would produce different bytes here.
     */
    expect(server.uploads[0]?.text).toBe(appDocumentJson(doc));
    expect(server.uploads[0]?.text).not.toBe(JSON.stringify(doc));
  });
});
