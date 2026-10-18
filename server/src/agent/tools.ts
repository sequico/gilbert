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
 * same documents a person does. The one that does not is `memory.remember`,
 * which records a fact into the **installation's** own store in the Master's
 * account rather than into any group's (ADR 0037): the memory is one for the
 * whole installation, which is what makes what one group learned worth knowing
 * in the next. The fact still records the **group it is about** — the run's own
 * account — because that is what its `standing` mark is filtered by.
 */

import { readGroupLabels, writeGroupLabels } from "../account.js";
import {
  appFolderState,
  type Ctx,
  documentType,
  ensureRootFolderPath,
  type FileNodeLike,
  fileChildren,
  filesAccountId,
  findFolderPath,
  findVisibleFolder,
  nodeStamp,
  pathSegments,
  readAppJsonAt,
  readVisibleFileBytes,
  updateAppNode,
} from "../appFolder.js";
import { documentKind, readDocument } from "../documentText.js";
import { groupMembers } from "../groupAccess.js";
import { findChatMessages, postChatMessage, readChatMessage } from "../groupChat.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { KnowledgeAdminError, proposeArticle, readArticle } from "../knowledgeAdmin.js";
import { sameAddress } from "../shared/address.js";
import { AGENT_SIGNATURE } from "../shared/agent.js";
import { FILE_PROPS } from "../shared/appFolder.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { CHAT_MAX_TEXT } from "../shared/chat.js";
import { moveMailboxPatch, refusalOf, type SetResponse } from "../shared/jmap.js";
import { queryThenGet } from "../shared/jmapQuery.js";
import { isRecord } from "../shared/json.js";
import {
  blocksFromText,
  KNOWLEDGE_FOLDER,
  knowledgeFolderName,
} from "../shared/knowledge.js";
import {
  AGENT_LABELS,
  DRAFT_KEYWORD,
  G_LABEL_PREFIX,
  isAgentLabel,
  type LabelCatalogEntry,
} from "../shared/labels.js";
import { MEMORY_FACT_MAX, subjectProblem } from "../shared/memory.js";
import type {
  RunAuthority,
  RunAuthorityAct,
  RunDoc,
  RunSpent,
  RunWait,
} from "../shared/run.js";
import {
  buildFilter,
  parseQuery,
  resolveMailbox,
  SEARCH_GRAMMAR,
  type SearchMailbox,
} from "../shared/search.js";
import { replySubject } from "../shared/text.js";
import {
  isWorkorderDoc,
  isWorkorderStepState,
  stepOf,
  WORKORDER_FOLDER,
  workorderClosedPath,
  workorderFileName,
} from "../shared/workorder.js";
import { clientOf } from "../util.js";
import { settleStepAsAgent, WorkorderAdminError } from "../workorderAdmin.js";
import { type MemoryStore, rememberFact } from "./memory.js";
import { readRun } from "./runs.js";
import { personWord } from "./trust.js";

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

/** What the installation's model answers when a tool asks it to read an image. */
export type ImageReader = (image: {
  type: string;
  data: Uint8Array;
}) => Promise<{ text: string } | { problem: string }>;

/**
 * The text of one file, as every reading tool answers it (ADR 0031).
 *
 * One file is one answer however it arrived — a document in Files, an attachment
 * of a message: the format readers say what a document says, the model's eyes
 * say what a picture says, and the two failures are told apart (a format nothing
 * reads, and a document that would not open) rather than answered with bytes.
 */
async function readFileText(
  file: { type: string; name: string; bytes: Uint8Array },
  readImage?: ImageReader,
): Promise<{
  text: string | null;
  readable: boolean;
  kind?: string;
  problem?: string;
}> {
  if (documentKind(file.type, file.name) === "image") {
    if (!readImage)
      return {
        text: null,
        readable: false,
        problem: "This installation's agent cannot look at an image.",
      };
    const read = await readImage({ type: file.type, data: file.bytes });
    return "problem" in read
      ? { text: null, readable: false, problem: read.problem }
      : { text: read.text, readable: true, kind: "image" };
  }
  const document = await readDocument(file.bytes, file.type, file.name, { readImage });
  if (document === null) return { text: null, readable: false };
  if ("problem" in document)
    return { text: null, readable: false, problem: document.problem };
  return { text: document.text, readable: true, kind: document.kind };
}

/** What a tool call is given: the session it acts as, and the run it works. */
export interface ToolCall {
  ctx: Ctx;
  /** The account the run belongs to — the group's own (ADR 0035). */
  accountId: string;
  /** The run the call is a step of, which is what its authority is read from. */
  run: RunDoc;
  /**
   * The installation's model's eyes, for the one read a function cannot make
   * (ADR 0031): an image is transcribed by the model, and a caller without this
   * gets the answer that says so rather than a guess at the picture.
   *
   * A function rather than the model's own access, because a catalogue that
   * imported the model would close a cycle — the model imports the catalogue to
   * offer its tools. The loop, which holds both, is where the two meet.
   */
  readImage?: ImageReader;
  /**
   * The installation's memory as the caller's pass read it (ADR 0037).
   *
   * The store is read **once per pass** (`agent/loop.ts`) and the one reading is
   * handed to every step of it, so the write `memory.remember` makes is against
   * the same reading the pass's selections were made from rather than listing
   * the memory again for every fact. A caller with no reading of its own — the
   * decision turn's write-free lookups — passes none, and a tool that needs one
   * says so.
   */
  memory?: MemoryStore;
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

const readAttachment = defineTool({
  name: "mail.readAttachment",
  description:
    "Read one attachment of a message of this account, by the message's id and the " +
    "attachment's name — both as mail.read answered them. A document is read " +
    "inside (a PDF, a Word file, a spreadsheet, an OpenDocument, text) and a " +
    "picture is transcribed by the installation's model.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), name: textArg(args, "name") };
  },
  run: async ({ ctx, accountId, readImage }, { id, name }) => {
    const answer = await clientOf(ctx).call<{
      list?: Array<{ attachments?: unknown }>;
    }>("Email/get", { accountId, ids: [id], properties: ["attachments"] }, [
      CAPABILITIES.mail,
    ]);
    const message = answer.list?.[0];
    if (!message) throw notFound(`message "${id}" in this account`);
    const held = (Array.isArray(message.attachments) ? message.attachments : []).filter(
      isRecord,
    );
    const one = held.find(
      (part) =>
        typeof part.name === "string" &&
        part.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (!one) throw notFound(`attachment "${name}" on message "${id}"`);
    const blobId = typeof one.blobId === "string" ? one.blobId : "";
    if (!blobId)
      throw new ToolError("bad_arguments", `The attachment "${name}" has no file.`, 422);
    const type =
      typeof one.type === "string" && one.type ? one.type : "application/octet-stream";
    const bytes = await clientOf(ctx).downloadBlob(accountId, blobId, name, type);
    return {
      name,
      type,
      size: typeof one.size === "number" ? one.size : bytes.length,
      ...(await readFileText({ type, name, bytes }, readImage)),
    };
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
    "with: its text. A PDF, a Word file, a spreadsheet or an OpenDocument is " +
    "read inside, so what you get is what the document says; a format this " +
    "build cannot read says so rather than answering bytes.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ path: textArg(argsRecord(raw), "path") }),
  run: async ({ ctx, accountId, readImage }, { path }) => {
    const found = await readVisibleFileBytes(ctx, accountId, path);
    if (!found) throw notFound(`file "${path}" in this account's Files`);
    const type = documentType(found.file);
    /*
     * A picture is read by the installation's model and a document by the
     * format readers; both answer the same three things — the text, a reason it
     * could not be read, or "this is not a format I read".
     *
     * shortcut: the vision call is not on the run's tally (a tool's spend is a
     * constant), so a run that reads many images under-reports its calls; give
     * `spend` a function when the tally must be exact to the call.
     */
    const document = await readFileText(
      { type, name: found.name, bytes: found.bytes },
      readImage,
    );
    return {
      name: found.name,
      type,
      size: typeof found.file.size === "number" ? found.file.size : null,
      ...document,
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

/* ------------------------------------------------------------------ */
/* The tools that change the group's own account                       */
/* ------------------------------------------------------------------ */

/**
 * The text of a chat message, bounded where the document is.
 *
 * `CHAT_MAX_TEXT` is the chat's own ceiling (ADR 0005): a message longer than it
 * is a message the reader would not render, so it is refused here rather than
 * written and silently cut.
 */
function chatText(args: Record<string, unknown>): string {
  const text = textArg(args, "text");
  if (text.length > CHAT_MAX_TEXT)
    throw new ToolError(
      "bad_arguments",
      `"text" must be at most ${CHAT_MAX_TEXT} characters.`,
    );
  return text;
}

/**
 * One conditional write of a node in the account's Files, retried once.
 *
 * `updateAppNode` writes against the account's FileNode state, and any writer in
 * the account invalidates it — a member's upload, another document, a prune
 * (`gilbert-stalwart`). One retry re-reads the state and writes again; a race
 * lost twice is refused rather than retried for ever, and the refusal the server
 * names for the node (`alreadyExists` on a rename, a right) is handed back in
 * its own words.
 */
async function writeNode(
  ctx: Ctx,
  accountId: string,
  id: string,
  change: { name?: string; parentId?: string | null },
): Promise<void> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = await appFolderState(ctx, accountId);
    try {
      const res = await updateAppNode(ctx, accountId, id, change, token);
      const refused = res.notUpdated?.[id];
      if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
      return;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw new ToolError(
    "write_raced",
    "Another write kept winning the race for that node; it was left as it is.",
    409,
  );
}

const fileMessage = defineTool({
  name: "mail.file",
  description:
    "File a message of this account into one of its folders, by the folder's " +
    "name or its role (inbox, archive, junk, trash). The message is taken out " +
    "of the folders it was in: it is moved, not copied.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), folder: textArg(args, "folder") };
  },
  run: async ({ ctx, accountId }, { id, folder }) => {
    const boxes = await mailboxesOf(ctx, accountId);
    const target = resolveMailbox(folder, boxes);
    if (!target) throw notFound(`folder "${folder}" in this account`);
    const answer = await clientOf(ctx).call<{ list?: Array<{ mailboxIds?: unknown }> }>(
      "Email/get",
      { accountId, ids: [id], properties: ["mailboxIds"] },
      [CAPABILITIES.mail],
    );
    const message = answer.list?.[0];
    if (!message) throw notFound(`message "${id}" in this account`);
    /*
     * The per-folder patch, never a replacement of the whole map: a message can
     * sit in several folders at once, and the folders this move does not come
     * from are not its to take away. A move with no source folder named is a
     * move out of every folder the message is known to sit in, which is what
     * `mail.file` means: the client's optimistic move and this write are one
     * function (`moveMailboxPatch`).
     */
    const patch = moveMailboxPatch(
      isRecord(message.mailboxIds) ? (message.mailboxIds as Record<string, boolean>) : {},
      target.id,
      null,
    );
    const res = await clientOf(ctx).call<SetResponse>(
      "Email/set",
      { accountId, update: { [id]: patch } },
      [CAPABILITIES.mail],
    );
    const refused = res.notUpdated?.[id];
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    return { id, folder: target.name };
  },
});

const setKeyword = defineTool({
  name: "mail.keyword",
  description:
    "Put a keyword on a message of this account, or take it off. A keyword is a " +
    "mark on a message: $seen when it has been read, $flagged for a star, the " +
    "keyword of one of the group's own labels, or one of the reserved processing " +
    `labels the product names (${AGENT_LABELS.map((one) => one.keyword).join(", ")}), ` +
    "which is how you mark a message you have processed.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const keyword = textArg(args, "keyword");
    /*
     * The `G-` namespace is the product's own: what may be applied is exactly
     * the vocabulary in `AGENT_LABELS`, so a `G-` string outside it is an
     * invented member of a namespace that is not the caller's and is refused
     * like any other argument the tool cannot use.
     */
    if (isAgentLabel(keyword) && !AGENT_LABELS.some((one) => one.keyword === keyword))
      throw new ToolError(
        "bad_arguments",
        `"${keyword}" is in the reserved "${G_LABEL_PREFIX}" namespace and is not one of its labels; that namespace is the product's own.`,
      );
    const on = args.on ?? true;
    if (typeof on !== "boolean")
      throw new ToolError("bad_arguments", `"on" must be true or false.`);
    return { id: textArg(args, "id"), keyword, on };
  },
  run: async ({ ctx, accountId }, { id, keyword, on }) => {
    const res = await clientOf(ctx).call<SetResponse>(
      "Email/set",
      { accountId, update: { [id]: { [`keywords/${keyword}`]: on ? true : null } } },
      [CAPABILITIES.mail],
    );
    const refused = res.notUpdated?.[id];
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    return { id, keyword, on };
  },
});

/** An address as a message carries it, from a JMAP address list. */
interface MailAddress {
  email: string;
  name?: string;
}

/** One sending identity of the account: its address, its name and its Bcc. */
interface SendingIdentity extends MailAddress {
  /** The account's own id for it, which a submission names. */
  id: string;
  bcc: MailAddress[];
}

/** The addresses a JMAP property carries, in order, skipping what is not one. */
function addressesIn(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) return [];
  const out: MailAddress[] = [];
  for (const one of value) {
    if (!isRecord(one) || typeof one.email !== "string" || !one.email) continue;
    out.push({
      email: one.email,
      ...(typeof one.name === "string" && one.name ? { name: one.name } : {}),
    });
  }
  return out;
}

/** The list with one entry per address, the first spelling of it kept. */
function onePerAddress(list: MailAddress[]): MailAddress[] {
  const seen = new Set<string>();
  return list.filter((one) => {
    const key = one.email.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The addresses this account sends as: the identities configured on the group.
 *
 * The group's identities are the account's own list — the same one the composer
 * offers — so a group with none has nobody to draft as, and says so rather than
 * writing a draft no mail server would send.
 */
async function sendingIdentities(
  ctx: Ctx,
  accountId: string,
): Promise<SendingIdentity[]> {
  const answer = await clientOf(ctx).call<{ list?: Array<Record<string, unknown>> }>(
    "Identity/get",
    { accountId, ids: null },
    [CAPABILITIES.mail, CAPABILITIES.submission],
  );
  const identities: SendingIdentity[] = [];
  for (const one of answer.list ?? []) {
    const [address] = addressesIn([one]);
    if (!address) continue;
    identities.push({
      ...address,
      id: typeof one.id === "string" ? one.id : "",
      bcc: addressesIn(one.bcc),
    });
  }
  if (!identities.length)
    throw new ToolError(
      "no_identity",
      "This account has no sending identity, so a draft could not say who it is from.",
      409,
    );
  return identities;
}

/** One message as a run's answer path reads it (ADR 0033). */
export async function readMessageForAnswer(
  ctx: Ctx,
  accountId: string,
  id: string,
  /** Who may speak, and who the agent is: the one trust question (ADR 0033). */
  asker: { own: string; known: ReadonlyArray<string> },
): Promise<{
  from: string | null;
  thread: string[];
  text: string;
  at: string | null;
  /** Whether the message is the sender's own word — refused, it answers nothing. */
  word: boolean;
} | null> {
  const answer = await clientOf(ctx).call<{ list?: Array<Record<string, unknown>> }>(
    "Email/get",
    {
      accountId,
      ids: [id],
      properties: [
        ...MESSAGE_PROPS,
        "inReplyTo",
        "references",
        "messageId",
        "header:Received:asText:all",
        "header:X-Gilbert-Run:asText",
      ],
      fetchTextBodyValues: true,
      maxBodyValueBytes: MESSAGE_BODY_MAX,
    },
    [CAPABILITIES.mail],
  );
  const message = answer.list?.[0];
  if (!message) return null;
  const thread: string[] = [];
  for (const key of ["inReplyTo", "references"] as const) {
    const held = message[key];
    if (!Array.isArray(held)) continue;
    for (const one of held)
      if (typeof one === "string" && !thread.includes(one)) thread.push(one);
  }
  const from = addressesIn(message.from)[0]?.email ?? null;
  const arrival = {
    from: message.from as ReadonlyArray<{ email?: string | null }> | null,
    "header:Received:asText:all": message[
      "header:Received:asText:all"
    ] as ReadonlyArray<string> | null,
    "header:X-Gilbert-Run:asText": message["header:X-Gilbert-Run:asText"] as
      | string
      | null,
  };
  return {
    from,
    thread,
    text: messageTextOf(message),
    at:
      typeof message.receivedAt === "string"
        ? message.receivedAt
        : typeof message.sentAt === "string"
          ? message.sentAt
          : null,
    word: personWord(arrival, asker).word,
  };
}

/** The text a message carries: its first non-empty text part, else its preview. */
function messageTextOf(message: Record<string, unknown>): string {
  const values = isRecord(message.bodyValues) ? message.bodyValues : {};
  const parts = Array.isArray(message.textBody) ? message.textBody : [];
  for (const part of parts) {
    if (!isRecord(part) || typeof part.partId !== "string") continue;
    const held = values[part.partId];
    const value = isRecord(held) ? held.value : null;
    if (typeof value === "string" && value.trim()) return value;
  }
  return typeof message.preview === "string" ? message.preview : "";
}

/** Whether an address is one this group itself sends as. */
export async function isGroupAddress(
  ctx: Ctx,
  accountId: string,
  address: string,
): Promise<boolean> {
  const identities = await sendingIdentities(ctx, accountId);
  return identities.some((identity) => sameAddress(identity.email, address));
}

const draftReply = defineTool({
  name: "mail.draft",
  description:
    "Draft a reply to a message of this account, in the group's own Drafts " +
    "folder, without sending it: a person reads it, changes what they want and " +
    "sends it. It is a reply to everyone: the sender — or the address the " +
    "message says to reply to — in To, and everybody else the message reached " +
    "in Cc, the account's own addresses left out. It carries the thread so it " +
    `lands in the conversation, and "${DRAFT_KEYWORD}" until somebody sends it.`,
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), text: textArg(args, "text") };
  },
  run: async ({ ctx, accountId }, { id, text }) => {
    const answer = await clientOf(ctx).call<{
      list?: Array<Record<string, unknown>>;
    }>(
      "Email/get",
      {
        accountId,
        ids: [id],
        properties: ["from", "replyTo", "to", "cc", "subject", "messageId", "references"],
      },
      [CAPABILITIES.mail],
    );
    const original = answer.list?.[0];
    if (!original) throw notFound(`message "${id}" in this account`);
    const identities = await sendingIdentities(ctx, accountId);
    const isOwn = (one: MailAddress) =>
      identities.some((identity) => sameAddress(identity.email, one.email));
    /*
     * Reply to all. A person's own addresses are taken out of both lists: a
     * reply the group addresses to itself is a reply nobody reads, and the
     * address a message reached is not one it is answered to.
     */
    const replyTo = addressesIn(original.replyTo);
    const senders = onePerAddress(
      replyTo.length ? replyTo : addressesIn(original.from),
    ).filter((one) => !isOwn(one));
    const others = onePerAddress([
      ...addressesIn(original.to),
      ...addressesIn(original.cc),
    ]).filter((one) => !isOwn(one));
    // A message of the group's own has no sender to answer: the reply goes on
    // with the people it was written to.
    const to = senders.length ? senders : others;
    const cc = senders.length
      ? others.filter((one) => !to.some((held) => sameAddress(held.email, one.email)))
      : [];
    if (!to.length)
      throw new ToolError(
        "no_recipient",
        `The message "${id}" reached nobody a reply could answer.`,
        422,
      );
    // The identity the message was addressed to is the one that answers it; a
    // group with several addresses does not reply as whichever came first.
    const reached = [...addressesIn(original.to), ...addressesIn(original.cc)].map(
      (one) => one.email,
    );
    const from =
      identities.find((identity) =>
        reached.some((email) => sameAddress(identity.email, email)),
      ) ?? identities[0];
    if (!from) throw notFound("sending identity in this account");
    const drafts = resolveMailbox("drafts", await mailboxesOf(ctx, accountId));
    if (!drafts) throw notFound("drafts folder in this account");
    const repliedTo = Array.isArray(original.messageId)
      ? (original.messageId.find((one): one is string => typeof one === "string") ?? null)
      : null;
    const references = Array.isArray(original.references)
      ? original.references.filter((one): one is string => typeof one === "string")
      : [];
    if (repliedTo && !references.includes(repliedTo)) references.push(repliedTo);
    const subject = replySubject(
      typeof original.subject === "string" ? original.subject : "",
      "Re",
    );
    const bcc = onePerAddress(from.bcc).filter(
      (one) =>
        !isOwn(one) &&
        !to.some((held) => sameAddress(held.email, one.email)) &&
        !cc.some((held) => sameAddress(held.email, one.email)),
    );
    const res = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
      "Email/set",
      {
        accountId,
        create: {
          draft: {
            from: [{ email: from.email, ...(from.name ? { name: from.name } : {}) }],
            to,
            ...(cc.length ? { cc } : {}),
            ...(bcc.length ? { bcc } : {}),
            subject,
            sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            mailboxIds: { [drafts.id]: true },
            keywords: { [DRAFT_KEYWORD]: true, $seen: true },
            bodyStructure: { partId: "text", type: "text/plain" },
            bodyValues: { text: { value: text } },
            ...(repliedTo ? { inReplyTo: [repliedTo] } : {}),
            ...(references.length ? { references } : {}),
          },
        },
      },
      [CAPABILITIES.mail],
    );
    const refused = res.notCreated?.draft;
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    const draft = res.created?.draft?.id;
    if (!draft)
      throw new ToolError(
        "write_refused",
        "The draft was not created, and the server said nothing about why.",
        409,
      );
    return {
      id: draft,
      to: to.map((one) => one.email),
      cc: cc.map((one) => one.email),
      subject,
      folder: drafts.name,
    };
  },
});

/**
 * Send one message from this group's own identity: written into Sent, then
 * submitted (ADR 0033).
 *
 * One door for both acts that send — the question to a person with access and the
 * message that reaches somebody outside — so the two cannot disagree about the
 * identity they send as, the folder the message is filed in, or the shape a
 * submission takes.
 */
async function sendMail(
  ctx: Ctx,
  accountId: string,
  message: { to: string; subject: string; text: string },
): Promise<{ id: string; from: string }> {
  const identities = await sendingIdentities(ctx, accountId);
  const from = identities[0];
  if (!from) throw notFound("sending identity in this account");
  const boxes = await mailboxesOf(ctx, accountId);
  const sent = resolveMailbox("sent", boxes) ?? resolveMailbox("inbox", boxes);
  if (!sent) throw notFound("sent folder in this account");
  const created = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
    "Email/set",
    {
      accountId,
      create: {
        m: {
          from: [{ email: from.email, ...(from.name ? { name: from.name } : {}) }],
          to: [{ email: message.to }],
          subject: message.subject,
          sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          mailboxIds: { [sent.id]: true },
          keywords: { $seen: true },
          bodyStructure: { partId: "text", type: "text/plain" },
          bodyValues: { text: { value: message.text } },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const refusedCreate = created.notCreated?.m;
  if (refusedCreate) throw new ToolError("write_refused", refusalOf(refusedCreate), 409);
  const emailId = created.created?.m?.id;
  if (!emailId)
    throw new ToolError(
      "write_refused",
      "The message was not written, and the server said nothing about why.",
      409,
    );
  const submitted = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
    "EmailSubmission/set",
    {
      accountId,
      create: {
        s: {
          identityId: from.id,
          emailId,
          envelope: {
            mailFrom: { email: from.email },
            rcptTo: [{ email: message.to }],
          },
        },
      },
    },
    [CAPABILITIES.mail, CAPABILITIES.submission],
  );
  const refusedSubmit = submitted.notCreated?.s;
  if (refusedSubmit) throw new ToolError("send_refused", refusalOf(refusedSubmit), 409);
  return { id: emailId, from: from.email };
}

const sendOutward = defineTool({
  name: "mail.send",
  description:
    "Send a message from this group to anybody. This is the act that reaches " +
    "somebody, so it is refused until a person's own words license exactly this " +
    "message — the address it goes to and the words it carries — and a license for " +
    "one message reaches no other.",
  authority: "outward",
  writes: true,
  spend: { steps: 1 },
  act: (raw) => {
    const one = isRecord(raw) ? raw : {};
    return {
      target: typeof one.to === "string" ? one.to.trim().toLowerCase() : "",
      // Trimmed like the licence it is compared with: the person's words and the
      // call differ by the newline a model puts around them, and nothing else.
      content: typeof one.text === "string" ? one.text.trim() : null,
    };
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      to: textArg(args, "to"),
      subject: textArg(args, "subject"),
      text: textArg(args, "text"),
    };
  },
  run: async ({ ctx, accountId }, { to, subject, text }) => {
    const sent = await sendMail(ctx, accountId, { to, subject, text });
    return { id: sent.id, to, subject };
  },
});

const askByMail = defineTool({
  name: "mail.ask",
  description:
    "Ask one person a question by mail and leave the run waiting on their answer. " +
    "The question goes from the group's own identity to a principal who has access " +
    "to this group, and the answer is the message that replies to it. Use it when " +
    "the person works by mail; chat.ask asks in the group's conversation.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      to: textArg(args, "to"),
      subject: textArg(args, "subject"),
      text: textArg(args, "text"),
    };
  },
  run: async ({ ctx, accountId }, { to, subject, text }) => {
    const members = await groupMembers(ctx, accountId);
    if (!members)
      throw new ToolError(
        "no_roster",
        "The mail server would not say who has access to this group, so nobody can be asked by mail.",
        409,
      );
    const address = to.trim().toLowerCase();
    if (!members.includes(address))
      throw new ToolError(
        "not_a_member",
        `"${to}" is not a principal with access to this group, and a question by mail reaches nobody else.`,
        403,
      );
    const sent = await sendMail(ctx, accountId, { to: address, subject, text });
    const wait: RunWait = {
      what: text,
      asked: { channel: "mail", id: sent.id },
      until: null,
    };
    return { id: sent.id, to: address, subject, wait };
  },
});

const settleStep = defineTool({
  name: "workorder.settle",
  description:
    "Settle a step of one of this account's workorders: mark it done, skipped or " +
    "not-applicable, or open it again, with an optional note saying why. The step " +
    "is signed as the agent, so a reader sees that the agent settled it and not a " +
    "person. The step is named by its path, as workorder.read answers it.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const state = args.state ?? "done";
    if (!isWorkorderStepState(state))
      throw new ToolError(
        "bad_arguments",
        '"state" must be open, done, skipped or not-applicable.',
      );
    return {
      uid: textArg(args, "uid"),
      path: textArg(args, "path"),
      state,
      note: args.note === undefined ? "" : textArg(args, "note"),
    };
  },
  run: async ({ ctx, accountId }, { uid, path, state, note }) => {
    try {
      const doc = await settleStepAsAgent({
        ctx,
        accountId,
        uid,
        path,
        state,
        note,
        by: AGENT_SIGNATURE,
      });
      const step = stepOf(doc.checklist, path);
      return { uid, path, state: step?.state ?? state, by: step?.by ?? AGENT_SIGNATURE };
    } catch (err) {
      // The workorder door's refusals are the surface's own codes and sentences;
      // what the model reads is the same code and the same words.
      if (err instanceof WorkorderAdminError)
        throw new ToolError(err.code, err.message, err.status);
      throw err;
    }
  },
});

const proposePage = defineTool({
  name: "knowledge.propose",
  description:
    "Propose a change to a page of this account's knowledge base, by its title. " +
    "The words you give become the page's draft: a person reads them and approves " +
    "the change, and nothing is in force until they do. The page's title, tags " +
    "and checklist stay as they are.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { title: textArg(args, "title"), text: textArg(args, "text") };
  },
  run: async ({ ctx, accountId }, { title, text }) => {
    const tier = await findFolderPath(ctx, accountId, KNOWLEDGE_FOLDER);
    if (tier === null) throw notFound("knowledge base in this account");
    const folder = knowledgeFolderName(title);
    const view = await readArticle(ctx, accountId, tier, folder);
    if (!view) throw notFound(`knowledge page titled "${title}"`);
    /*
     * What the proposal keeps: the draft's own title, tags and checklist, and
     * the effective revision's when the page has no draft yet. Only the words
     * are the proposal's — taking the others from a default would quietly clear
     * a page's tags.
     */
    const held = view.draft ?? view.effective;
    try {
      const summary = await proposeArticle(
        ctx,
        accountId,
        folder,
        {
          title: held?.title ?? view.summary.title,
          tags: held?.tags ?? [],
          blocks: blocksFromText(text),
          text,
          checklist: held?.checklist ?? null,
        },
        AGENT_SIGNATURE,
      );
      return {
        title: summary.title,
        folder: summary.folder,
        revision: view.effective?.rev ?? null,
      };
    } catch (err) {
      // A retired page and a write that lost the race are refusals the model
      // reads as a failed step, with the knowledge door's own code and sentence.
      if (err instanceof KnowledgeAdminError)
        throw new ToolError(err.code, err.message, err.status);
      throw err;
    }
  },
});

const defineLabel = defineTool({
  name: "mail.label",
  description:
    "Add a label to this group's own label catalog, or change the name or the " +
    "colour of one it already holds. A label is a keyword with a name and a " +
    "colour; mail.keyword puts one on a message.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const keyword = textArg(args, "keyword");
    if (isAgentLabel(keyword))
      throw new ToolError(
        "bad_arguments",
        `"${keyword}" is in the reserved "${G_LABEL_PREFIX}" namespace, which is the product's own; this catalog holds the group's human labels.`,
      );
    return {
      keyword,
      name: textArg(args, "name"),
      color: textArg(args, "color"),
    };
  },
  run: async ({ ctx, accountId }, { keyword, name, color }) => {
    const read = await readGroupLabels(ctx, accountId);
    if (read.state === "unreadable")
      throw new ToolError(
        "catalog_unreadable",
        "The group's label catalog is there and cannot be read; it has been left exactly as it is.",
        409,
      );
    const labels: LabelCatalogEntry[] = read.state === "catalog" ? [...read.labels] : [];
    const at = labels.findIndex((one) => one.keyword === keyword);
    if (at < 0) labels.push({ keyword, name, color });
    else labels[at] = { keyword, name, color };
    await writeGroupLabels(ctx, accountId, labels);
    return { keyword, name, color, added: at < 0 };
  },
});

const createMailFolder = defineTool({
  name: "mail.folder",
  description:
    "Create a folder in this account's mailbox, by its name, inside the folder " +
    "`parent` names or at the top level. A folder already there by that name is " +
    "the answer rather than an error.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { name: textArg(args, "name"), parent: optionalTextArg(args, "parent") };
  },
  run: async ({ ctx, accountId }, { name, parent }) => {
    const boxes = await mailboxesOf(ctx, accountId);
    let parentId: string | null = null;
    if (parent) {
      const found = resolveMailbox(parent, boxes);
      if (!found) throw notFound(`folder "${parent}" in this account`);
      parentId = found.id;
    }
    // A folder already carrying the name is the one the caller asked for, so the
    // call is safe to repeat and rests on no server refusal this build has not
    // read.
    const held = Object.values(boxes).find(
      (box) => box.parentId === parentId && box.name.toLowerCase() === name.toLowerCase(),
    );
    if (held) return { id: held.id, name: held.name, parent: parentId };
    const res = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
      "Mailbox/set",
      { accountId, create: { n: { name, parentId, isSubscribed: true } } },
      [CAPABILITIES.mail],
    );
    const refused = res.notCreated?.n;
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    const id = res.created?.n?.id;
    if (!id)
      throw new ToolError(
        "write_refused",
        "The mail server created the folder but returned no id.",
        502,
      );
    return { id, name, parent: parentId };
  },
});

const createFileFolder = defineTool({
  name: "files.folder",
  description:
    "Create a folder in this account's own Files, by its path — " +
    "`Containers/2026`, or a single name at the top level. Every folder of the " +
    "path that is missing is made and one that is there is left as it is. The " +
    "`gilbert` app folder is not a destination.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => ({ path: textArg(argsRecord(raw), "path") }),
  run: async ({ ctx, accountId }, { path }) => {
    const id = await ensureRootFolderPath(ctx, accountId, path);
    return { folder: pathSegments(path).join("/"), id };
  },
});

const moveFile = defineTool({
  name: "files.move",
  description:
    "Move a node of this account's own Files into a folder, by the folder's " +
    "path; name no folder to move it to the top level. The node keeps its name " +
    "and its id, and a move into its own subtree is refused.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), folder: optionalTextArg(args, "folder") ?? "" };
  },
  run: async ({ ctx, accountId }, { id, folder }) => {
    const dest = await findVisibleFolder(ctx, accountId, folder);
    if (dest === undefined) throw notFound(`folder "${folder}" in this account's Files`);
    // `null` is the top level of Files, and it is a destination: a patch that
    // dropped it would leave the node where it was.
    await writeNode(ctx, accountId, id, { parentId: dest });
    return { id, folder: folder || null };
  },
});

const renameFile = defineTool({
  name: "files.rename",
  description:
    "Rename a node of this account's own Files. A name another node of the same " +
    "folder already carries is refused rather than taken.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), name: textArg(args, "name") };
  },
  run: async ({ ctx, accountId }, { id, name }) => {
    await writeNode(ctx, accountId, id, { name });
    return { id, name };
  },
});

const sayInChat = defineTool({
  name: "chat.say",
  description:
    "Say something in this group's own conversation, as yourself: how the group " +
    "is told what the work did. Asking a person something the work needs " +
    "answered is chat.ask.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { text: chatText(args), replyTo: optionalTextArg(args, "replyTo") };
  },
  run: async ({ ctx, accountId }, { text, replyTo }) => {
    // The agent writes as itself and acts in the group's account (ADR 0033):
    // the sender is the address the session signed in as.
    const id = await postChatMessage(ctx, accountId, ctx.username, text, { replyTo });
    return { id };
  },
});

const askInChat = defineTool({
  name: "chat.ask",
  description:
    "Ask a person a question in this group's own conversation and leave the run " +
    "waiting on their answer: the run stops until somebody replies, and the " +
    "answer is read from the conversation. Use it for what only a person can " +
    "decide; a report nobody has to answer is chat.say.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => ({ text: chatText(argsRecord(raw)) }),
  run: async ({ ctx, accountId }, { text }) => {
    const id = await postChatMessage(ctx, accountId, ctx.username, text);
    /*
     * What the run waits for is a person's answer, and that wait carries **no
     * date**: the run is picked up when the answer arrives in the conversation,
     * never by a clock (ADR 0033, 0034). The answer goes into the run's own
     * document by the loop (`waitUntil`) — the run is the loop's to write, as
     * its tally is — and `asked` is the message the answer will reply to.
     */
    const wait: RunWait = {
      what: text,
      asked: { channel: "chat", id },
      until: null,
    };
    return { id, wait };
  },
});

/* ------------------------------------------------------------------ */
/* The tool that changes the installation's memory                     */
/* ------------------------------------------------------------------ */

/**
 * One fact the agent records while it works (ADR 0037).
 *
 * The write lands in the **Master's** own account and not the group's: one
 * memory serves the installation, so what is learned while working one group's
 * change is known by the next call in any of them. Its class is the agent's own
 * (`reversible`, ADR 0032): a fact it wrote can be read back and removed, so
 * nothing here asks a person — and the one thing that is *not* the agent's to
 * undo, a **person's** fact, is refused by the store itself and never reached
 * through the class.
 */
const rememberFactTool = defineTool({
  name: "memory.remember",
  description:
    "Record one thing you have come to hold true, so that later calls start " +
    "from it: the subject it is about — a shipper, a client, a booking, a " +
    "folder, this group itself — and one sentence of what you hold of it. It is " +
    "information you reason from, never an instruction: it grants nothing and " +
    "authorises nothing. The fact is recorded as being about **this group** — " +
    "the account you are working in — and one you mark `standing` is carried by " +
    "every call of this group and of no other; any fact you record is recalled " +
    "by its subject wherever in the installation it is needed. Name the facts " +
    "it belongs with in `links`. A fact a person wrote is in force and this " +
    "is in force and is never written over: what you conclude against it is " +
    "recorded as a **proposal** beside it, and a person accepts or dismisses it.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const subject = textArg(args, "subject");
    const problem = subjectProblem(subject);
    if (problem) throw new ToolError("bad_arguments", problem);
    const fact = textArg(args, "fact");
    if (fact.length > MEMORY_FACT_MAX)
      throw new ToolError(
        "bad_arguments",
        `"fact" must be at most ${MEMORY_FACT_MAX} characters.`,
      );
    const standing = args.standing ?? false;
    if (typeof standing !== "boolean")
      throw new ToolError("bad_arguments", '"standing" must be true or false.');
    // The subjects the fact belongs with; a list left out is no links at all.
    const links: unknown = args.links ?? [];
    if (
      !Array.isArray(links) ||
      !links.every((one) => typeof one === "string" && Boolean(one.trim()))
    )
      throw new ToolError("bad_arguments", '"links" must be a list of names.');
    return {
      subject,
      fact,
      links: (links as string[]).map((one) => one.trim()),
      standing,
    };
  },
  run: async ({ ctx, accountId, run, memory }, { subject, fact, links, standing }) => {
    // The memory is the installation's, so the account it is **written to** is
    // the principal's own — the Master's — and never the group's the run lives in
    // (ADR 0037). The account the fact is **about** is the group's, because that
    // is what a `standing` fact is filtered by when a call of a group is made.
    // What the fact is written against is the pass's own reading of the store,
    // handed to every step of the pass: reading it again here is what would walk
    // the whole memory once per remembered fact.
    if (!memory)
      throw new ToolError(
        "memory_unread",
        "The installation's memory has not been read for this call, and a fact is never written against a reading that is not there.",
        409,
      );
    const written = await rememberFact(
      ctx,
      filesAccountId(ctx),
      {
        subject,
        fact,
        run: run.id,
        at: new Date().toISOString(),
        group: accountId,
        links,
        standing,
      },
      memory,
    );
    // A write against a person's fact is a proposal, and the model is told what
    // it is and what the person's sentence still is (ADR 0037).
    const proposal = written.proposal;
    return proposal?.run === run.id
      ? {
          id: written.id,
          subject: written.subject,
          proposed: proposal.fact,
          inForce: written.fact,
        }
      : { id: written.id, subject: written.subject };
  },
});

/**
 * Every tool this build has: the half that reads, and the half that changes the
 * group's own account.
 *
 * The half that writes is the reversible class of ADR 0032 and nothing beside
 * it: filing a message, a keyword, a label, a folder, a folder of Files, a move,
 * a rename, saying something in the conversation, asking a person, and
 * remembering a fact — the one that is written into the installation's own
 * memory rather than the group's account. The acts a
 * **person** must answer for — a send, a destroy, a policy override, an intent —
 * are the tools of the unit after this one, and they are what the guard's
 * act-binding exists for.
 */
export const TOOLS: readonly AnyTool[] = [
  findMessages,
  readMessage,
  readAttachment,
  listMailboxes,
  readChat,
  findChat,
  listFiles,
  readNode,
  readWorkorder,
  readKnowledgePage,
  readRunTool,
  fileMessage,
  setKeyword,
  draftReply,
  sendOutward,
  askByMail,
  settleStep,
  proposePage,
  defineLabel,
  createMailFolder,
  createFileFolder,
  moveFile,
  renameFile,
  sayInChat,
  askInChat,
  rememberFactTool,
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
 * Find a tool in a catalogue and validate the arguments it is given.
 *
 * One definition of the two, so the door a call is run through (`runTool`) and a
 * caller that only asks whether a call is well formed before running anything
 * (`chooseStep`, `model.ts`) cannot disagree on which tool a name finds or what
 * its arguments are. A name the catalogue does not hold, or arguments its tool
 * refuses, is thrown as a `ToolError`.
 */
export function validatedTool(
  catalogue: readonly AnyTool[],
  name: string,
  raw: unknown,
): { tool: AnyTool; args: unknown } {
  const tool = catalogue.find((one) => one.name === name);
  if (!tool) throw new ToolError("unknown_tool", `There is no tool named "${name}".`);
  return { tool, args: tool.parse(raw) };
}

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
  const { tool, args } = validatedTool(catalogue, name, raw);
  if (!mayRun(tool, call.run, args))
    throw new ToolError(
      "needs_authority",
      `"${tool.name}" is not the agent's to decide, and this run carries no authority for it.`,
      403,
    );
  return await tool.run(call, args);
}
