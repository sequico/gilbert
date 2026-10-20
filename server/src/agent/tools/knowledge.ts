/**
 * The tools over the account's knowledge base.
 *
 * Reading a page as a reader sees it now, and proposing words as its draft —
 * nothing of which is in force until a person approves it.
 */

import { findFolderPath } from "../../appFolder.js";
import {
  KnowledgeAdminError,
  listArticles,
  proposeArticle,
  readArticle,
} from "../../knowledgeAdmin.js";
import { AGENT_SIGNATURE } from "../../shared/agent.js";
import {
  blocksFromText,
  KNOWLEDGE_FOLDER,
  knowledgeFolderName,
} from "../../shared/knowledge.js";
import { argsRecord, countArg, notFound, TOOL_LIST_MAX, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";
import { READ_IN_PROMPT_MAX } from "../prompt.js";

/**
 * The most of a page one read answers with.
 *
 * A page is a controlled document and can be long; the answer is carried into a
 * prompt that is paid for by the token, and a JSON answer cut by the prompt is a
 * cut the model cannot read. The tool bounds its own text and says so, and
 * `offset` asks for the rest — one page in as many reads as it takes.
 */
export const KNOWLEDGE_TEXT_MAX = READ_IN_PROMPT_MAX;
export const listKnowledge = defineTool({
  name: "knowledge.list",
  description:
    "List the pages and folders of this account's knowledge base, with their " +
    "titles. List before reading: a title is taken from this answer, never " +
    `guessed. \`limit\` is how many entries to answer with (at most ${TOOL_LIST_MAX}); ` +
    "`total` and `truncated` say whether the base holds more.",
  authority: "reversible",
  writes: false,
  keys: ["limit"],
  parse: (raw: unknown) => ({
    limit: countArg(argsRecord(raw), "limit", TOOL_LIST_MAX) ?? TOOL_LIST_MAX,
  }),
  run: async ({ ctx, accountId }, { limit }) => {
    const tier = await findFolderPath(ctx, accountId, KNOWLEDGE_FOLDER);
    if (tier === null) return { pages: [], total: 0, truncated: false };
    const items = await listArticles(ctx, accountId, tier);
    const pages = items.map(({ kind, title, folder }) => ({ kind, title, folder }));
    return {
      pages: pages.slice(0, limit),
      total: pages.length,
      truncated: pages.length > limit,
    };
  },
});

export const readKnowledgePage = defineTool({
  name: "knowledge.read",
  description:
    "Read one page of this account's knowledge base by its title, as a reader " +
    "sees it now: the title, the tags, the text, and which revision is in force. " +
    `The text is at most ${KNOWLEDGE_TEXT_MAX} characters; \`textLength\` and ` +
    "`truncated` say whether the page holds more, and `offset` reads on from where " +
    "the last answer ended.",
  authority: "reversible",
  writes: false,
  keys: ["offset", "title"],
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const offset = args.offset ?? 0;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
      throw new ToolError(
        "bad_arguments",
        '"offset" must be a whole number of at least 0.',
      );
    return { title: textArg(args, "title"), offset };
  },
  run: async ({ ctx, accountId }, { title, offset }) => {
    const tier = await findFolderPath(ctx, accountId, KNOWLEDGE_FOLDER);
    if (tier === null) throw notFound("knowledge base in this account");
    const view = await readArticle(ctx, accountId, tier, knowledgeFolderName(title));
    if (!view) throw notFound(`knowledge page titled "${title}"`);
    // What a reader sees now, and only it: the draft is behind the revision in
    // force once one is, and the history is not what the page says.
    const page = view.effective ?? view.draft;
    const full = page?.text ?? "";
    const text = full.slice(offset, offset + KNOWLEDGE_TEXT_MAX);
    return {
      title: page?.title ?? view.summary.title,
      tags: page?.tags ?? view.summary.tags,
      text,
      textLength: full.length,
      offset,
      truncated: offset + text.length < full.length,
      revision: view.effective?.rev ?? null,
      folder: view.summary.folder,
      updatedAt: page?.updated.at ?? null,
    };
  },
});

export const proposePage = defineTool({
  name: "knowledge.propose",
  description:
    "Propose a change to a page of this account's knowledge base, by its title. " +
    "The words you give become the page's draft: a person reads them and approves " +
    "the change, and nothing is in force until they do. The page's title, tags " +
    "and checklist stay as they are.",
  authority: "reversible",
  writes: true,
  surface: "knowledge",
  spend: { steps: 1 },
  keys: ["text", "title"],
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
