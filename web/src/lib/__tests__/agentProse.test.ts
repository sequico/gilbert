import {
  parseRuleDocumentDetailed,
  RULE_SURFACES,
  RULE_VERSION,
} from "@gilbert/agent/rule";
import { APP_FOLDER_NAME } from "@gilbert/shared/appFolder";
import { INSTRUCTION_VERSION } from "@gilbert/shared/instruction";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { readGroupProse, saveRule } from "../agentProse";

/**
 * A group's prose, read and written through the client's own FileNode calls.
 *
 * The surface's promise is that what it files is what the agent reads next pass,
 * and that a document it cannot read is reported rather than dropped: a rule
 * the group wrote and the agent silently ignored is the failure this pins. The
 * server side of the same contract is `server/src/agent/rules.test.ts` and
 * `instruction.test.ts`.
 */

const ACCOUNT = "a1";
const APP = "app";
const RULES = "rules";
const TYPE = "application/json";

interface FakeNode {
  id: string;
  parentId: string | null;
  name: string;
  nodeType: "file" | "directory";
  blobId: string | null;
  type: string | null;
  size: number | null;
  created?: string;
}

const node = (
  id: string,
  parentId: string | null,
  name: string,
  extra: Partial<FakeNode> = {},
): FakeNode => ({
  id,
  parentId,
  name,
  nodeType: "file",
  blobId: null,
  type: null,
  size: 0,
  ...extra,
});

function fakeServer(nodes: FakeNode[], blobs: Record<string, string>) {
  const written: Array<Record<string, unknown>> = [];
  const texts = new Map(Object.entries(blobs));
  let seq = 0;
  const state = () => "s1";

  vi.spyOn(client, "chain").mockImplementation(async (calls) => {
    const out = new Map<string, Record<string, unknown>[]>();
    let lastIds: string[] = [];
    for (const [method, args, id] of calls) {
      if (method === "FileNode/query") {
        const filter = (args.filter ?? {}) as { parentId?: string };
        lastIds = nodes
          .filter((n) => (filter.parentId ? n.parentId === filter.parentId : !n.parentId))
          .map((n) => n.id);
        out.set(id, [
          {
            accountId: ACCOUNT,
            queryState: "1",
            canCalculateChanges: false,
            position: 0,
            ids: lastIds,
            total: lastIds.length,
          },
        ]);
      } else if (method === "FileNode/get") {
        const ids =
          (args["#ids"] ? lastIds : ((args.ids as string[] | null) ?? [])) ?? [];
        out.set(id, [
          {
            accountId: ACCOUNT,
            state: state(),
            list: nodes
              .filter((n) => ids.includes(n.id))
              .map((n) => ({
                id: n.id,
                name: n.name,
                parentId: n.parentId,
                nodeType: n.nodeType,
                blobId: n.blobId,
                type: n.type,
                size: n.size,
              })),
            notFound: [],
          },
        ]);
      }
    }
    return out;
  });

  vi.spyOn(client, "fetchBlobText").mockImplementation(async (_account, blobId) => {
    const text = texts.get(blobId as string);
    if (text === undefined) throw new Error(`no blob ${blobId}`);
    return text;
  });

  vi.spyOn(client, "upload").mockImplementation(async (_account, data) => {
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(data as Blob);
    });
    const blobId = `blob-${++seq}`;
    texts.set(blobId, text);
    return { accountId: ACCOUNT, blobId, type: TYPE, size: text.length } as never;
  });

  vi.spyOn(client, "call").mockImplementation((async (
    method: string,
    args: Record<string, unknown>,
  ) => {
    if (method !== "FileNode/set") {
      const ids = (args.ids as string[] | undefined) ?? [];
      return {
        accountId: ACCOUNT,
        state: state(),
        list: nodes
          .filter((n) => ids.includes(n.id))
          .map((n) => ({ id: n.id, blobId: n.blobId })),
        notFound: [],
      };
    }
    written.push(args);
    const created: Record<string, unknown> = {};
    const update = args.update as
      | Record<string, { blobId?: string; type?: string }>
      | undefined;
    if (update)
      for (const [id, patch] of Object.entries(update)) {
        const target = nodes.find((n) => n.id === id);
        if (!target) continue;
        if (patch.blobId !== undefined) target.blobId = patch.blobId;
        if (patch.type !== undefined) target.type = patch.type;
      }
    const create = args.create as
      | Record<
          string,
          {
            parentId: string;
            name: string;
            nodeType?: string;
            blobId?: string;
            type?: string;
          }
        >
      | undefined;
    if (create)
      for (const [key, value] of Object.entries(create)) {
        const id = `made-${++seq}`;
        nodes.push(
          node(id, value.parentId, value.name, {
            nodeType: value.nodeType === "directory" ? "directory" : "file",
            blobId: value.blobId ?? null,
            type: value.type ?? null,
          }),
        );
        created[key] = { id };
      }
    return {
      accountId: ACCOUNT,
      state: state(),
      created,
      updated: {},
      notUpdated: {},
      destroyed: [],
    };
  }) as never);

  return { written, texts, nodes };
}

function group(
  rules: Array<{ name: string; blobId: string }>,
  blobs: Record<string, string>,
) {
  return fakeServer(
    [
      node(APP, null, APP_FOLDER_NAME, { nodeType: "directory" }),
      node("i1", APP, "instruction.json", { blobId: "b-instruction", type: TYPE }),
      node(RULES, APP, "rules", { nodeType: "directory" }),
      ...rules.map((r) => node(r.name, RULES, r.name, { blobId: r.blobId, type: TYPE })),
    ],
    {
      "b-instruction": JSON.stringify({
        v: INSTRUCTION_VERSION,
        instruction: "Answer in the group's voice.",
      }),
      ...blobs,
    },
  );
}

const ruleDoc = (id: string, watches: string[] = ["mail"]) =>
  JSON.stringify({
    v: RULE_VERSION,
    id,
    watches,
    instruction: `${id} work`,
    sends: false,
  });

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading a group's prose", () => {
  it("answers the standing instruction and every readable rule", async () => {
    group(
      [
        { name: "invoices.json", blobId: "b-invoices" },
        { name: "triage.json", blobId: "b-triage" },
      ],
      {
        "b-invoices": ruleDoc("invoices"),
        "b-triage": ruleDoc("triage", ["chat", "mail"]),
      },
    );

    const prose = await readGroupProse(ACCOUNT);
    expect(prose.instruction).toBe("Answer in the group's voice.");
    expect(prose.rules.map((r) => r.id)).toEqual(["invoices", "triage"]);
    expect(prose.unreadable).toEqual([]);
  });

  it("reports a document it cannot read, and a rule filed under another name, instead of dropping them", async () => {
    group(
      [
        { name: "broken.json", blobId: "b-broken" },
        { name: "misnamed.json", blobId: "b-misnamed" },
      ],
      {
        "b-broken": "{ not json",
        "b-misnamed": ruleDoc("something-else"),
      },
    );

    const prose = await readGroupProse(ACCOUNT);
    expect(prose.rules).toEqual([]);
    expect(prose.unreadable.map((u) => u.name)).toEqual(["broken.json", "misnamed.json"]);
    expect(prose.unreadable[1]!.problem).toContain("filed as");
  });

  it("answers an empty prose for a group that has never written one", async () => {
    fakeServer([], {});
    expect(await readGroupProse(ACCOUNT)).toEqual({
      instruction: "",
      rules: [],
      unreadable: [],
      state: null,
    });
  });
});

describe("writing a rule", () => {
  it("files the document the agent reads, in the watched order the record keeps", async () => {
    const server = group([], {});

    const saved = await saveRule(
      ACCOUNT,
      {
        v: RULE_VERSION,
        id: "invoices",
        watches: ["files", "mail"],
        instruction: "File the invoice and tell the group.",
        sends: true,
      },
      "s1",
    );

    expect(saved.watches).toEqual(["mail", "files"]);
    const filed = server.nodes.find((n) => n.name === "invoices.json");
    expect(filed?.parentId).toBe(RULES);
    expect(
      parseRuleDocumentDetailed(server.texts.get(filed!.blobId!)!).valueOf(),
    ).toMatchObject({
      rule: {
        id: "invoices",
        instruction: "File the invoice and tell the group.",
        sends: true,
      },
    });
    expect(server.written.length).toBe(1);
    expect(server.written[0]!.ifInState).toBe(
      "s1",
      "the write is conditioned on the read",
    );
  });

  it("refuses a rule the agent would refuse, without writing anything", async () => {
    const server = group([], {});
    await expect(
      saveRule(ACCOUNT, {
        v: RULE_VERSION,
        id: "empty",
        watches: RULE_SURFACES.slice(0, 1),
        instruction: "   ",
        sends: false,
      }),
    ).rejects.toThrow(/"instruction" must say what should happen/);
    expect(server.written).toEqual([]);
  });

  it("refuses an id that is not one plain file name", async () => {
    const server = group([], {});
    await expect(
      saveRule(ACCOUNT, {
        v: RULE_VERSION,
        id: "../escape",
        watches: ["mail"],
        instruction: "Do it.",
        sends: false,
      }),
    ).rejects.toThrow(/not a rule name/);
    expect(server.written).toEqual([]);
  });
});
