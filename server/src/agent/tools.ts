/**
 * The agent's tools, read from the group's own account (ADR 0031).
 *
 * A tool is a **task over one object Stalwart offers**, not a step of the
 * protocol: one that finds messages by the mail client's own search grammar,
 * one that reads a message, a KB page, a workorder, a node or a run, and one
 * that lists a mailbox's folders or a folder of Files. Two tools that do one
 * thing are a defect — they make the choice a lottery — and a tool that answers
 * with more context than the caller needs is one too.
 *
 * **What defines a tool** is six things beside its executor: its **name**, its
 * **description** (the product's interface to the model, written as prose a
 * person's agent should reach for), its **arguments** (validated before the
 * executor runs, never inside it), the **authority class it exercises** (ADR
 * 0032), the **act** that class is about when the class asks a person, and what
 * it **spends** of the run's budget (ADR 0031) — which the loop applies with
 * `spendRun`, and which for a read is nothing.
 *
 * **The reading half cannot change anything.** Reading before acting is what
 * makes these the tools a run opens with, and every one of them declares
 * `writes: false`: the catalogue's write-free half is what a reading caller gets
 * (`readingTools`), so a tool that writes is unreachable through it. A tool
 * whose act leaves the run waiting answers with the wait it left, and the loop
 * applies it with `waitUntil` — the run document is the loop's to write, exactly
 * as the tally is.
 *
 * Every tool acts in the account its run lives in — the group's own (ADR 0035)
 * — and reads it through the same doors the surfaces use, so the agent sees the
 * same documents a person does.
 */

import {
  type Ctx,
  documentType,
  type FileNodeLike,
  fileChildren,
  findFolderPath,
  findVisibleFolder,
  nodeStamp,
  readAppJsonAt,
  readVisibleFileAt,
} from "../appFolder.js";
import { findChatMessages, readChatMessage } from "../chat.js";
import { readArticle } from "../knowledgeAdmin.js";
import { FILE_PROPS } from "../shared/appFolder.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { queryThenGet } from "../shared/jmapQuery.js";
import { isRecord } from "../shared/json.js";
import { KNOWLEDGE_FOLDER, knowledgeFolderName } from "../shared/knowledge.js";
import type { RunAuthority, RunAuthorityAct, RunDoc, RunSpent } from "../shared/run.js";
import {
  buildFilter,
  parseQuery,
  SEARCH_GRAMMAR,
  type SearchMailbox,
} from "../shared/search.js";
import {
  isWorkorderDoc,
  WORKORDER_FOLDER,
  workorderClosedPath,
  workorderFileName,
} from "../shared/workorder.js";
import { clientOf } from "../util.js";
import { readRun } from "./runs.js";

/* ------------------------------------------------------------------ */
/* What a tool is                                                      */
/* ------------------------------------------------------------------ */

/**
 * The authority class a tool exercises (ADR 0032).
 *
 * The five classes, named by what each one needs before the agent may act:
 * `reversible` is the agent's own decision; `destructive` (a message, a folder
 * or a page destroyed, a document overwritten), `outward` (anything that
 * reaches a person outside the mandate) and `beyond-policy` (an act the written
 * policy forbids) each need an authority the run carries — a person's word, a
 * rule that declares it sends, or an installation administrator's override —
 * and `intent` is never the agent's, whatever the run carries.
 */
export type ToolAuthority =
  | "reversible"
  | "destructive"
  | "outward"
  | "beyond-policy"
  | "intent";

/**
 * A tool call this build cannot use.
 *
 * The code is what a surface composes its own sentence from, as `RunError` is
 * for runs; a tool refused for its arguments says so in the model's own words.
 */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * One tool, with its arguments erased so a catalogue can hold them side by side.
 *
 * `parse` is the only reader of the raw arguments the model gave, and `run` is
 * only ever handed what `parse` returned — which is what makes "validated
 * before the executor runs" a property of the shape rather than a rule the
 * executors keep. `defineTool` builds one from a tool that names its own
 * argument type.
 */
export interface AnyTool {
  readonly name: string;
  readonly description: string;
  readonly authority: ToolAuthority;
  /** Whether the tool can change anything. The reading half's are all false. */
  readonly writes: boolean;
  /** What a call to it spends of the run's budget (ADR 0031). */
  readonly spend: Partial<RunSpent>;
  /**
   * The act this call is, read from the arguments the model gave (ADR 0032).
   *
   * A class is not an act: an authority a person gave names one act and no
   * other, so a tool whose class needs one answers here what its act reaches and
   * what it carries, and the guard compares that against the run's
   * authorisations. A class that asks nobody answers null, which is every
   * reading tool and every reversible one.
   */
  readonly act: (args: unknown) => RunAuthorityAct | null;
  /** Validate the arguments; throw `ToolError` on anything the tool cannot use. */
  readonly parse: (raw: unknown) => unknown;
  /** The task itself, with arguments already validated. */
  readonly run: (call: ToolCall, args: unknown) => Promise<unknown>;
}

/** One tool's own shape, typed by the arguments it takes. */
interface ToolSpec<Args> {
  name: string;
  description: string;
  authority: ToolAuthority;
  writes: boolean;
  spend?: Partial<RunSpent>;
  act?: (args: Args) => RunAuthorityAct | null;
  parse: (raw: unknown) => Args;
  run: (call: ToolCall, args: Args) => Promise<unknown>;
}

/** The one place a tool is defined, so every field above has one spelling. */
export function defineTool<Args>(spec: ToolSpec<Args>): AnyTool {
  return {
    name: spec.name,
    description: spec.description,
    authority: spec.authority,
    writes: spec.writes,
    spend: spec.spend ?? {},
    act: spec.act ? (args) => spec.act!(args as Args) : () => null,
    parse: spec.parse,
    run: (call, args) => spec.run(call, args as Args),
  };
}

/** What a tool call is given: the session it acts as, and the run it works. */
export interface ToolCall {
  ctx: Ctx;
  /** The account the run belongs to — the group's own (ADR 0035). */
  accountId: string;
  /** The run the call is a step of, which is what its authority is read from. */
  run: RunDoc;
}

/** The authority of the run that makes a tool's class the agent's to take. */
const AUTHORITY_NEEDED: Record<ToolAuthority, RunAuthority | "alone" | "never"> = {
  reversible: "alone",
  destructive: "destructive",
  outward: "outward",
  "beyond-policy": "override",
  intent: "never",
};

/** What a tool's class needs before a run may take it (ADR 0032). */
export function authorityNeeded(
  authority: ToolAuthority,
): RunAuthority | "alone" | "never" {
  return AUTHORITY_NEEDED[authority];
}

/**
 * Whether a run may take a tool's action, read from the class the tool declares
 * and the act it is about.
 *
 * The guard is here and nowhere else: `reversible` is the agent's own decision
 * and asks nobody; the three that need one are answered by the run's recorded
 * authorisations, each naming the authority a person gave **and the act it is
 * for** — an authorisation answers for that act and no other (ADR 0032), so a
 * send a person authorised does not authorise the next one; and `intent` is
 * never answered at all, because which policy is right is not a thing a run can
 * be authorised to decide.
 */
export function mayRun(tool: AnyTool, run: RunDoc, args: unknown): boolean {
  const needed = authorityNeeded(tool.authority);
  if (needed === "alone") return true;
  if (needed === "never") return false;
  const act = tool.act(args);
  if (!act) return false;
  return run.authorisations.some(
    (one) =>
      one.authority === needed &&
      one.act.target === act.target &&
      one.act.content === act.content,
  );
}

/* ------------------------------------------------------------------ */
/* Reading a tool's arguments                                          */
/* ------------------------------------------------------------------ */

/** The arguments as one record, or a refusal: every tool takes named fields. */
function argsRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw))
    throw new ToolError("bad_arguments", "A tool's arguments are an object.");
  return raw;
}

/** One required text field. */
function textArg(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim())
    throw new ToolError("bad_arguments", `"${key}" must be text.`);
  return value.trim();
}

/** One optional text field. */
function optionalTextArg(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new ToolError("bad_arguments", `"${key}" must be text.`);
  return value.trim() || undefined;
}

/** One optional count, bounded so a model cannot ask the server for a flood. */
function countArg(
  raw: Record<string, unknown>,
  key: string,
  max: number,
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new ToolError(
      "bad_arguments",
      `"${key}" must be a whole number of at least 1.`,
    );
  return Math.min(value, max);
}

/** A missing object, in the model's own words: not a failure to report as one. */
function notFound(what: string): ToolError {
  return new ToolError("not_found", `There is no ${what}.`, 404);
}

/* ------------------------------------------------------------------ */
/* The tools that write nothing                                        */
/* ------------------------------------------------------------------ */

/** The properties a search hit carries: enough to choose what to read next. */
const HIT_PROPS = ["id", "subject", "from", "receivedAt", "keywords"];

/** The properties a message is read with — its text, and no more of it than this. */
const MESSAGE_PROPS = [
  "id",
  "subject",
  "from",
  "to",
  "cc",
  "replyTo",
  "receivedAt",
  "sentAt",
  "keywords",
  "hasAttachment",
  "textBody",
  "bodyValues",
];

/** How much of a message's text one read carries, per part. */
const MESSAGE_BODY_MAX = 64 * 1024;

/** How many hits one search answers with, whatever the model asks for. */
const FIND_MAX = 50;

/** A mailbox as this tier reads it: what the search grammar resolves against. */
interface MailboxLike {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  parentId?: unknown;
}

/** Every mailbox of the account, by id — what `resolveMailbox` reads. */
async function mailboxesOf(
  ctx: Ctx,
  accountId: string,
): Promise<Record<string, SearchMailbox & { parentId: string | null }>> {
  const answer = await clientOf(ctx).call<{ list?: MailboxLike[] }>(
    "Mailbox/get",
    { accountId, ids: null, properties: ["id", "name", "role", "parentId"] },
    [CAPABILITIES.mail],
  );
  const boxes: Record<string, SearchMailbox & { parentId: string | null }> = {};
  for (const box of answer.list ?? []) {
    if (typeof box.id !== "string" || typeof box.name !== "string") continue;
    boxes[box.id] = {
      id: box.id,
      name: box.name,
      role: typeof box.role === "string" ? box.role : null,
      parentId: typeof box.parentId === "string" ? box.parentId : null,
    };
  }
  return boxes;
}

const findMessages = defineTool({
  name: "mail.find",
  description:
    `Find messages in a mailbox of this account by ${SEARCH_GRAMMAR}. ` +
    "The answer names the messages it found; read the ones you need with mail.read.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      query: textArg(args, "query"),
      limit: countArg(args, "limit", FIND_MAX) ?? FIND_MAX,
    };
  },
  run: async ({ ctx, accountId }, { query, limit }) => {
    const mailboxes = await mailboxesOf(ctx, accountId);
    const filter = buildFilter(parseQuery(query), mailboxes);
    const client = clientOf(ctx);
    const answer = await client.chain(
      queryThenGet({
        query: "Email/query",
        get: "Email/get",
        accountId,
        maxObjectsInGet: client.maxObjectsInGet,
        filter,
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
        properties: HIT_PROPS,
      }),
      [CAPABILITIES.mail],
    );
    return { messages: answer.list<Record<string, unknown>>("g") };
  },
});

/** How many chat messages one search answers with, whatever the model asks for. */
const CHAT_FIND_MAX = 50;

const readChat = defineTool({
  name: "chat.read",
  description:
    "Read one message of this group's own conversation, by the id a search or " +
    "an event answered with: who posted it, when, its text, and the message it " +
    "answers.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    const message = await readChatMessage(ctx, accountId, id);
    if (!message) throw notFound(`chat message "${id}" in this account`);
    return { message };
  },
});

const findChat = defineTool({
  name: "chat.find",
  description:
    "Find messages of this group's recent conversation whose text contains the " +
    "given words — who was asked something, what was answered. The answer names " +
    "the messages it found, newest first; read one with chat.read.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      query: textArg(args, "query"),
      limit: countArg(args, "limit", CHAT_FIND_MAX) ?? CHAT_FIND_MAX,
    };
  },
  run: async ({ ctx, accountId }, { query, limit }) => ({
    messages: await findChatMessages(ctx, accountId, query, limit),
  }),
});

const readMessage = defineTool({
  name: "mail.read",
  description:
    "Read one message in full: who wrote it, when it arrived, and its text. " +
    "The id is one a search answered with.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    const answer = await clientOf(ctx).call<{ list?: Array<Record<string, unknown>> }>(
      "Email/get",
      {
        accountId,
        ids: [id],
        properties: MESSAGE_PROPS,
        fetchTextBodyValues: true,
        maxBodyValueBytes: MESSAGE_BODY_MAX,
      },
      [CAPABILITIES.mail],
    );
    const message = answer.list?.[0];
    if (!message) throw notFound(`message "${id}" in this account`);
    return { message };
  },
});

const listMailboxes = defineTool({
  name: "mail.folders",
  description:
    "List the mailboxes of this account: each folder's name, what it is for " +
    "(its role — inbox, sent, drafts, junk, trash) and the folder it sits in.",
  authority: "reversible",
  writes: false,
  parse: () => ({}),
  run: async ({ ctx, accountId }) => {
    const boxes = await mailboxesOf(ctx, accountId);
    return { folders: Object.values(boxes) };
  },
});

const listFiles = defineTool({
  name: "files.list",
  description:
    "List a folder of this account's Files. Name no folder for the top level; " +
    "a folder's path lists the level inside it.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ folder: optionalTextArg(argsRecord(raw), "folder") ?? "" }),
  run: async ({ ctx, accountId }, { folder }) => {
    const folderId = await findVisibleFolder(ctx, accountId, folder);
    if (folderId === undefined)
      throw notFound(`folder "${folder}" in this account's Files`);
    // The stamps are what a reader sorts a level by, and they are not in the set
    // a tree walk asks for; asking for them widens that set (`readProps`).
    const children = await fileChildren(ctx, accountId, folderId, [
      ...FILE_PROPS,
      "created",
      "modified",
    ]);
    return {
      nodes: children.flatMap((node: FileNodeLike) => {
        if (typeof node.name !== "string" || !node.name) return [];
        return [
          {
            path: folder ? `${folder}/${node.name}` : node.name,
            nodeType: node.nodeType === "directory" ? "directory" : "file",
            size: typeof node.size === "number" ? node.size : null,
            modified: nodeStamp(node),
          },
        ];
      }),
    };
  },
});

const readNode = defineTool({
  name: "files.read",
  description:
    "Read one document of this account's Files, by the path a listing answered " +
    "with, as text.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ path: textArg(argsRecord(raw), "path") }),
  run: async ({ ctx, accountId }, { path }) => {
    const found = await readVisibleFileAt(ctx, accountId, path);
    if (!found) throw notFound(`file "${path}" in this account's Files`);
    return {
      name: String(found.file.name ?? ""),
      type: documentType(found.file),
      size: typeof found.file.size === "number" ? found.file.size : null,
      text: found.text,
    };
  },
});

const readWorkorder = defineTool({
  name: "workorder.read",
  description:
    "Read one workorder this account holds, by its uid: its name, its state, " +
    "the checklist steps with who signed each of them, and the objects it " +
    "references.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ uid: textArg(argsRecord(raw), "uid") }),
  run: async ({ ctx, accountId }, { uid }) => {
    const name = workorderFileName(uid);
    const raw =
      (await readAppJsonAt(ctx, accountId, `${WORKORDER_FOLDER}/${name}`)) ??
      (await readAppJsonAt(ctx, accountId, `${workorderClosedPath()}/${name}`));
    if (!isWorkorderDoc(raw)) throw notFound(`workorder "${uid}" in this account`);
    return {
      uid: raw.uid,
      name: raw.name ?? null,
      state: raw.state ?? null,
      steps: raw.checklist.steps,
      refs: raw.refs,
      updated: raw.updated,
    };
  },
});

const readKnowledgePage = defineTool({
  name: "knowledge.read",
  description:
    "Read one page of this account's knowledge base by its title, as a reader " +
    "sees it now: the title, the tags, the text, and which revision is in force.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ title: textArg(argsRecord(raw), "title") }),
  run: async ({ ctx, accountId }, { title }) => {
    const tier = await findFolderPath(ctx, accountId, KNOWLEDGE_FOLDER);
    if (tier === null) throw notFound("knowledge base in this account");
    const view = await readArticle(ctx, accountId, tier, knowledgeFolderName(title));
    if (!view) throw notFound(`knowledge page titled "${title}"`);
    // What a reader sees now, and only it: the draft is behind the revision in
    // force once one is, and the history is not what the page says.
    const page = view.effective ?? view.draft;
    return {
      title: page?.title ?? view.summary.title,
      tags: page?.tags ?? view.summary.tags,
      text: page?.text ?? "",
      revision: view.effective?.rev ?? null,
      folder: view.summary.folder,
      updatedAt: page?.updated.at ?? null,
    };
  },
});

const readRunTool = defineTool({
  name: "run.read",
  description:
    "Read one run of this account by its id: what started it, the plan and how " +
    "each step ended, what it is waiting for, every authorisation it holds, and " +
    "what it has spent.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    const record = await readRun(ctx, accountId, id);
    if (!record) throw notFound(`run "${id}" in this account`);
    return { run: record.run };
  },
});

/**
 * Every tool this build has: the reading half, and nothing beside it yet.
 *
 * The writing tools land with the loop (ADR 0034), and they are what the
 * `writes` flag and `readingTools` exist for.
 */
export const TOOLS: readonly AnyTool[] = [
  findMessages,
  readMessage,
  listMailboxes,
  readChat,
  findChat,
  listFiles,
  readNode,
  readWorkorder,
  readKnowledgePage,
  readRunTool,
];

/**
 * The half of a catalogue that cannot change anything: the tools that write
 * nothing.
 *
 * This is the whole of what makes a writing tool unreachable while reading: the
 * caller is handed the write-free half, so a tool that writes is not in it to
 * find. A caller with the whole catalogue asks for the half it may use.
 */
export function readingTools(catalogue: readonly AnyTool[]): readonly AnyTool[] {
  return catalogue.filter((tool) => !tool.writes);
}

/** The reading half of this build's catalogue. */
export const READING_TOOLS = readingTools(TOOLS);

/**
 * Call one tool: find it, validate its arguments, ask the guard, and run it.
 *
 * The catalogue is the caller's — the reading half for a reading call — and
 * nothing here looks beyond it, so what a caller cannot see it cannot reach.
 * The arguments are validated **before** the executor runs, and a tool whose
 * class the run carries no authority for is refused rather than run.
 */
export async function runTool(
  catalogue: readonly AnyTool[],
  call: ToolCall,
  name: string,
  raw: unknown,
): Promise<unknown> {
  const tool = catalogue.find((one) => one.name === name);
  if (!tool) throw new ToolError("unknown_tool", `There is no tool named "${name}".`);
  const args = tool.parse(raw);
  if (!mayRun(tool, call.run, args))
    throw new ToolError(
      "needs_authority",
      `"${tool.name}" is not the agent's to decide, and this run carries no authority for it.`,
      403,
    );
  return await tool.run(call, args);
}
