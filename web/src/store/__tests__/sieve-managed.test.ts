// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { MANAGED_INCLUDE, newRule, rulesToSieve } from "@/lib/sieve";
import { useSieve } from "@/store/sieve";

/**
 * The script Stalwart 1.2 keeps for a person.
 *
 * 1.2 compiles server-side rules and the away reply into a read-only script
 * named `managed`, which runs only while it is active or the active script
 * includes it. Gilbert's own filter script therefore has to carry
 * `include :personal "managed";` on such a server — and must not on an older
 * one, where naming a script that does not exist fails to compile. The same
 * build serves both.
 */

type Row = { id: string; name: string; blobId: string; isActive: boolean };

let scripts: Row[];
let blobs: Record<string, string>;
let created: number;
let uploaded: number;
const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

const rule = () =>
  newRule({
    id: "r1",
    name: "Newsletters",
    tests: [{ type: "header", header: "list-id", op: "exists", value: "" }],
    actions: [{ type: "fileinto", mailbox: "Newsletters" }],
  });

function server(rows: Row[], contents: Record<string, string>) {
  scripts = rows;
  blobs = { ...contents };
  created = 0;
  uploaded = 0;
  calls.length = 0;
  vi.spyOn(client, "call").mockImplementation(async (method, args) => {
    calls.push({ method, args: args as Record<string, unknown> });
    if (method === "SieveScript/get")
      return {
        accountId: "a1",
        state: "s1",
        list: scripts.map((s) => ({ ...s })),
        notFound: [],
      } as never;
    const a = args as {
      update?: Record<string, { name?: string; blobId?: string }>;
      create?: Record<string, { name: string; blobId: string }>;
      destroy?: string[];
      onSuccessActivateScript?: string;
      onSuccessDeactivateScript?: boolean;
    };
    const response: Record<string, unknown> = {};
    if (a.update) {
      const updated: Record<string, null> = {};
      for (const [id, patch] of Object.entries(a.update)) {
        const row = scripts.find((s) => s.id === id)!;
        if (patch.name) row.name = patch.name;
        if (patch.blobId) row.blobId = patch.blobId;
        updated[id] = null;
      }
      response.updated = updated;
    }
    if (a.create) {
      const made: Record<string, { id: string }> = {};
      for (const [cid, obj] of Object.entries(a.create)) {
        const id = `n${++created}`;
        scripts.push({ id, name: obj.name, blobId: obj.blobId, isActive: false });
        made[cid] = { id };
      }
      response.created = made;
    }
    if (a.destroy) {
      response.destroyed = a.destroy;
      scripts = scripts.filter((s) => !a.destroy!.includes(s.id));
    }
    if (a.onSuccessActivateScript) {
      const target =
        a.onSuccessActivateScript === "#s" ? `n${created}` : a.onSuccessActivateScript;
      for (const s of scripts) s.isActive = s.id === target;
    }
    if (a.onSuccessDeactivateScript) for (const s of scripts) s.isActive = false;
    return response as never;
  });
  vi.spyOn(client, "upload").mockImplementation(async (_account, blob) => {
    const id = `b${++uploaded}`;
    blobs[id] = await (blob as Blob).text();
    return { accountId: "a1", blobId: id, type: "application/sieve", size: 0 } as never;
  });
  vi.spyOn(client, "fetchBlobText").mockImplementation(
    async (_account, blobId) => blobs[blobId] ?? "",
  );
}

const ours = () => scripts.find((s) => s.name === "gilbert")!;
const contentOf = (s: Row) => blobs[s.blobId] ?? "";

beforeEach(() => {
  useSieve.setState({
    accountId: "a1",
    available: true,
    scripts: [],
    contents: {},
    loading: false,
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useSieve.setState({ accountId: null, available: false, scripts: [], contents: {} });
});

describe("a server that keeps its own script", () => {
  it("never reads the server's script as the baseline of a person's rules", async () => {
    server(
      [{ id: "0", name: "managed", blobId: "bm", isActive: true }],
      { bm: rulesToSieve([rule()]) },
    );
    await useSieve.getState().load();
    // No script of ours: the rules are empty, not the server's own content.
    expect(useSieve.getState().rules()).toMatchObject({ script: null, rules: [] });
  });

  it("writes the include into the filter script it saves", async () => {
    server([{ id: "0", name: "managed", blobId: "bm", isActive: false }], { bm: "keep;" });
    await useSieve.getState().load();
    await useSieve.getState().saveRules([rule()]);
    expect(contentOf(ours())).toContain(MANAGED_INCLUDE);
  });

  it("adds the include to a filter script written before the server had one", async () => {
    server(
      [
        { id: "g", name: "gilbert", blobId: "bg", isActive: true },
        { id: "0", name: "managed", blobId: "bm", isActive: false },
      ],
      { bg: rulesToSieve([rule()]), bm: "keep;" },
    );

    await useSieve.getState().load();

    // The upgrade path: the script was written when no such script existed.
    expect(contentOf(ours())).toContain(MANAGED_INCLUDE);
    expect(ours().isActive).toBe(true);
    // And it is not rewritten again on the read that follows.
    const writes = calls.filter(
      (c) => c.method === "SieveScript/set" && "update" in c.args,
    ).length;
    expect(writes).toBe(1);
  });

  it("leaves the server's script alone", async () => {
    server([{ id: "0", name: "managed", blobId: "bm", isActive: false }], { bm: "keep;" });
    await useSieve.getState().load();

    await expect(
      useSieve.getState().saveScript("0", "managed", "discard;", false),
    ).rejects.toThrow("cannot be edited");
    // Nor can a second script carry the name the server resolves to its own.
    await expect(
      useSieve.getState().saveScript(null, "managed", "discard;", false),
    ).rejects.toThrow("cannot be edited");
    await expect(useSieve.getState().destroy("0")).rejects.toThrow("cannot be deleted");
  });

  it("does not download the server's script, which it never shows", async () => {
    server([{ id: "0", name: "managed", blobId: "bm", isActive: true }], { bm: "keep;" });
    await useSieve.getState().load();
    expect(client.fetchBlobText).not.toHaveBeenCalledWith(
      "a1",
      "bm",
      "application/sieve",
    );
  });
});

describe("a server that keeps no such script", () => {
  it("writes no include, which would name a script that is not there", async () => {
    server([], {});
    await useSieve.getState().load();
    await useSieve.getState().saveRules([rule()]);
    expect(contentOf(ours())).not.toContain("managed");
  });
});

describe("deleting the running script", () => {
  it("deactivates it first, which is the step a refusal names", async () => {
    server([{ id: "g", name: "gilbert", blobId: "bg", isActive: true }], {
      bg: rulesToSieve([rule()]),
    });
    await useSieve.getState().load();

    await useSieve.getState().destroy("g");

    const writes = calls.filter((c) => c.method === "SieveScript/set");
    expect(writes[0]?.args).toMatchObject({ onSuccessDeactivateScript: true });
    expect(writes.at(-1)?.args).toMatchObject({ destroy: ["g"] });
    expect(scripts).toEqual([]);
  });
});
