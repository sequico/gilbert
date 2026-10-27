import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { fakeJmapServer } from "@/test/jmapServer";

/**
 * Stalwart 1.0 names a node's kind `@type` (`File`/`Directory`/`SymLink`) and
 * its MIME `mediaType`, and refuses a create carrying `nodeType`. The client
 * keeps the tree's own words and translates at the transport
 * (`server/src/shared/filenode.ts`); this pins both halves of that on the
 * browser's side, which no other test reads because a fake server answering the
 * tree's words would pass either way.
 */

function session(): JmapSession {
  return {
    capabilities: { [CAP.core]: {}, [CAP.mail]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
}

beforeEach(() => {
  client.session = session();
});

afterEach(() => {
  vi.unstubAllGlobals();
  client.session = null;
});

describe("the FileNode wire", () => {
  it("asks with @type and mediaType, and answers in the tree's own words", async () => {
    const srv = fakeJmapServer().on("FileNode/get", () => ({
      accountId: "a1",
      state: "s1",
      list: [
        { id: "d1", "@type": "Directory", name: "Documents", mediaType: null },
        { id: "f1", "@type": "File", name: "notes.txt", mediaType: "text/plain" },
      ],
      notFound: [],
    }));

    const answer = await client.call<{
      list: Array<Record<string, unknown>>;
    }>("FileNode/get", {
      accountId: "a1",
      ids: null,
      properties: ["id", "name", "nodeType", "type"],
    });

    expect(srv.callsTo("FileNode/get")[0]!.args.properties).toEqual([
      "id",
      "name",
      "@type",
      "mediaType",
    ]);
    expect(answer.list).toEqual([
      { id: "d1", nodeType: "directory", name: "Documents", type: null },
      { id: "f1", nodeType: "file", name: "notes.txt", type: "text/plain" },
    ]);
  });

  it("writes a create with @type, and asks for directories with Directory", async () => {
    const srv = fakeJmapServer()
      .on("FileNode/query", () => ({
        accountId: "a1",
        state: "s1",
        ids: [],
        canCalculateChanges: false,
        position: 0,
        total: 0,
      }))
      .on("FileNode/set", () => ({
        accountId: "a1",
        state: "s1",
        created: { d: { id: "d1" } },
      }));

    await client.call("FileNode/query", {
      accountId: "a1",
      filter: { nodeType: "directory" },
    });
    await client.call("FileNode/set", {
      accountId: "a1",
      create: { d: { parentId: null, name: "gilbert", nodeType: "directory" } },
    });

    expect(srv.callsTo("FileNode/query")[0]!.args.filter).toEqual({
      nodeType: "Directory",
    });
    expect(srv.callsTo("FileNode/set")[0]!.args.create).toEqual({
      d: { parentId: null, name: "gilbert", "@type": "Directory" },
    });
  });
});
