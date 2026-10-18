/**
 * The tree walk and its listings.
 *
 * A listing reads each article's small `state.json` — the folder is the tree
 * and the state is the title — and the company tier is read through the same
 * door as the group tier, resolved by the scope module.
 */

import { type Ctx, fileChildren, readAppSheetJsonAt } from "../appFolder.js";
import type { LiveSession } from "../sessions.js";
import { FOLDER_PROPS } from "../shared/appFolder.js";
import {
  compareKnowledgeSiblings,
  isRetired,
  KNOWLEDGE_FOLDER,
  type KnowledgeArticleView,
  type KnowledgeSummary,
  knowledgeSummary,
  REVISIONS_FOLDER,
  STATE_FILE,
} from "../shared/knowledge.js";
import { asState } from "./documents.js";
import { folderOrder } from "./editors.js";
import { readArticle } from "./reads.js";
import { companyKnowledgeAccount } from "./scope.js";
import { type ArticleFolder, findArticle } from "./tree.js";

/**
 * List the articles under one folder, depth-first.
 *
 * A listing reads each article's small `state.json`, never its draft or its
 * revisions: the folder is the tree and the state is the title, so navigation
 * costs one document per article (`KnowledgeSummary`). A directory with a
 * `state.json` is an article and a **leaf** (its only child is the reserved
 * revision store, skipped), so the walk stops there; a directory without one
 * is a **topic folder** that groups articles and other folders, listed and
 * recursed into.
 *
 * `folder` on every summary is the **tier-relative path** (`"Policies/Returns"`),
 * because that is what a write target carries back to this door: the tree is
 * nested, so a leaf name alone cannot name a sub-article. The path is what the
 * segment walk in `findArticleFolder` resolves.
 */
export async function listArticlesUnder(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  prefix: string,
  parentId: string | null,
  includeRetired: boolean,
): Promise<KnowledgeSummary[]> {
  const children = await fileChildren(ctx, accountId, folderId, FOLDER_PROPS);
  const direct: KnowledgeSummary[] = [];
  const nested: KnowledgeSummary[] = [];
  for (const child of children) {
    if (child.nodeType !== "directory") continue;
    const name = typeof child.name === "string" ? child.name : "";
    const childId = typeof child.id === "string" ? child.id : "";
    if (!name || !childId) continue;
    if (name === REVISIONS_FOLDER) continue;
    const folder = prefix ? `${prefix}/${name}` : name;
    const state = asState(
      await readAppSheetJsonAt(
        ctx,
        accountId,
        `${KNOWLEDGE_FOLDER}/${folder}/${STATE_FILE}`,
      ),
    );
    // A directory with a `state.json` is an article and a leaf: only the
    // revision store lives under it, so the walk stops here. A retired article
    // is withdrawn from the tree but kept for traceability, so it is listed
    // only where a caller asks for it.
    if (state) {
      if (isRetired(state) && !includeRetired) continue;
      direct.push(
        knowledgeSummary({
          state,
          draft: null,
          folder,
          nodeId: childId,
          parentId,
          saved: true,
        }),
      );
      continue;
    }
    // No state: a topic folder, pure grouping with a place of its own.
    direct.push(
      knowledgeSummary({
        state: null,
        draft: null,
        folder,
        nodeId: childId,
        parentId,
        saved: false,
        folderOrder: await folderOrder(ctx, accountId, folder),
      }),
    );
    nested.push(
      ...(await listArticlesUnder(
        ctx,
        accountId,
        childId,
        folder,
        childId,
        includeRetired,
      )),
    );
  }
  // The one sibling order both tiers read: by the free `order` number, then by
  // title, so a drag lands between two neighbours without renumbering the rest.
  direct.sort(compareKnowledgeSiblings);
  return [...direct, ...nested];
}

/** The articles under a KB folder node, siblings ordered by `order`, then title. */
export async function listArticles(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  opts: { includeRetired?: boolean } = {},
): Promise<KnowledgeSummary[]> {
  return listArticlesUnder(
    ctx,
    accountId,
    folderId,
    "",
    null,
    opts.includeRetired === true,
  );
}

/**
 * The article with a given id anywhere in a tier, or null.
 *
 * A durable reference — a workorder's template — carries the article's **id**,
 * never its folder (the folder is the title, which a rename changes). The walk
 * reads each article's small `state.json`, which is where the id lives.
 */
export async function findArticleById(
  ctx: Ctx,
  accountId: string,
  tierFolderId: string,
  id: string,
): Promise<ArticleFolder | null> {
  return findArticle(ctx, accountId, tierFolderId, ({ state }) => state?.id === id);
}

/**
 * The company KB's tree, read through the route as the Master (ADR 0024).
 *
 * A reader is not a member of the Master's account, so the company tier is
 * reached by a server route rather than a JMAP share: `shareWith` cannot name
 * every account. The tier is resolved first — its account and root folder —
 * and the articles are listed from there, the same walk the group tier reads
 * with the reader's own session.
 */
export async function companyTree(
  admin: LiveSession,
  opts: { includeRetired?: boolean } = {},
): Promise<{ accountId: string; articles: KnowledgeSummary[] }> {
  const { ctx, accountId, folderId } = await companyKnowledgeAccount(admin);
  return {
    accountId,
    articles: await listArticles(ctx, accountId, folderId, {
      includeRetired: opts.includeRetired === true,
    }),
  };
}

/**
 * One company article by its tier-relative folder, or null when it is not
 * there.
 *
 * The read goes through the master door for the same reason the tree does: a
 * reader's own session cannot see the Master's account. An absent folder is a
 * state, not a failure — the surface shows nothing rather than an error the
 * reader cannot act on.
 */
export async function companyArticle(
  admin: LiveSession,
  folder: string,
): Promise<KnowledgeArticleView | null> {
  const { ctx, accountId, folderId } = await companyKnowledgeAccount(admin);
  return readArticle(ctx, accountId, folderId, folder);
}
