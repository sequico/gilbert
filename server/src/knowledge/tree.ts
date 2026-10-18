/**
 * Resolving one article in a tier.
 *
 * A durable reference to an article is resolved by something a rename does
 * not change — its own `state.json` id, or the FileNode id a move keeps — and
 * an editor resolves the tier and the article together before it writes.
 */

import {
  type Ctx,
  fileChildren,
  pathSegments,
  readAppJsonAt,
  readAppSheetJsonAt,
} from "../appFolder.js";
import type { LiveSession } from "../sessions.js";
import { FOLDER_PROPS } from "../shared/appFolder.js";
import {
  KNOWLEDGE_FOLDER,
  type KnowledgeState,
  type KnowledgeTarget,
  REVISIONS_FOLDER,
  STATE_FILE,
} from "../shared/knowledge.js";
import { asState } from "./documents.js";
import { KnowledgeAdminError } from "./errors.js";
import { tierAccount } from "./scope.js";

/* ------------------------------------------------------------------ */
/* Resolving one article                                               */
/* ------------------------------------------------------------------ */

/** An article folder as the tier root sees it. */
export interface ArticleFolder {
  /** The article folder's FileNode id. */
  nodeId: string;
  /** The folder this one sits inside, or null directly under the tier root. */
  parentId: string | null;
  /** The tier-relative folder path, e.g. `"Policies/Returns"`. */
  folder: string;
}

/**
 * Walk `tierFolderId` down the article path, or null when a segment is
 * missing. The walk is by listing, because `FileNode/query` cannot filter by
 * name (`gilbert-stalwart`).
 */
export async function findArticleFolder(
  ctx: Ctx,
  accountId: string,
  tierFolderId: string,
  folder: string,
): Promise<ArticleFolder | null> {
  const segments = pathSegments(folder);
  if (!segments.length) return null;
  let current = tierFolderId;
  let path = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    const children = await fileChildren(ctx, accountId, current, FOLDER_PROPS);
    const found = children.find(
      (node) => node.nodeType === "directory" && node.name === segment,
    );
    if (!found?.id) return null;
    const nextPath = path ? `${path}/${segment}` : segment;
    if (i === segments.length - 1)
      return {
        nodeId: String(found.id),
        // The tier root is not an article, so a top-level article has no
        // parent id; anything deeper names the folder it sits in.
        parentId: current === tierFolderId ? null : current,
        folder: nextPath,
      };
    current = String(found.id);
    path = nextPath;
  }
  return null;
}

/** The same walk, refusing a folder the tier does not hold. */
export async function resolveArticleFolder(
  ctx: Ctx,
  accountId: string,
  tierFolderId: string,
  folder: string,
): Promise<ArticleFolder> {
  const found = await findArticleFolder(ctx, accountId, tierFolderId, folder);
  if (!found)
    throw new KnowledgeAdminError(
      "article_not_found",
      `The knowledge base has no article "${folder.trim() || folder}".`,
      404,
    );
  return found;
}

/**
 * The **topic folder** a new node may land in, or null for the tier root.
 *
 * Only a directory with no `state.json` groups anything: an article is a leaf,
 * so nesting under one would put a leaf inside a leaf, invisible to the tree
 * walk. The check is on the resolved path, so it holds for a create, a folder
 * and a move alike.
 */
export async function resolveParentFolder(
  ctx: Ctx,
  accountId: string,
  tierFolderId: string,
  parentFolder: string | null,
): Promise<ArticleFolder | null> {
  if (!parentFolder) return null;
  const parent = await resolveArticleFolder(ctx, accountId, tierFolderId, parentFolder);
  const state = asState(
    await readAppJsonAt(
      ctx,
      accountId,
      `${KNOWLEDGE_FOLDER}/${parent.folder}/${STATE_FILE}`,
    ),
  );
  if (state)
    throw new KnowledgeAdminError(
      "parent_is_article",
      `"${parentFolder}" is an article, not a topic folder: an article cannot hold another.`,
      400,
    );
  return parent;
}

/** Resolve the tier and one article in it for an editor or lifecycle write. */
export async function articleTarget(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
): Promise<{
  ctx: Ctx;
  accountId: string;
  folderId: string;
  article: ArticleFolder;
}> {
  const clean = (folder ?? "").trim();
  if (!clean)
    throw new KnowledgeAdminError("bad_request", "An article folder is required.");
  const tier = await tierAccount(admin, target);
  const article = await resolveArticleFolder(
    tier.ctx,
    tier.accountId,
    tier.folderId,
    clean,
  );
  return { ctx: tier.ctx, accountId: tier.accountId, folderId: tier.folderId, article };
}

/** The app-folder-relative path of the article's folder. */
export function articlePathOf(article: ArticleFolder): string {
  return `${KNOWLEDGE_FOLDER}/${article.folder}`;
}

/**
 * The first article folder in a tier for which `match` answers true, or null.
 *
 * A durable reference to an article is resolved by something a rename does not
 * change: its own `state.json` id, or the FileNode id a move keeps. One walk
 * answers both, so the two references cannot disagree about the tree.
 */
export async function findArticle(
  ctx: Ctx,
  accountId: string,
  tierFolderId: string,
  match: (found: {
    nodeId: string;
    folder: string;
    state: KnowledgeState | null;
  }) => boolean,
): Promise<ArticleFolder | null> {
  const walk = async (
    folderId: string,
    prefix: string,
    parentId: string | null,
  ): Promise<ArticleFolder | null> => {
    const children = await fileChildren(ctx, accountId, folderId, FOLDER_PROPS);
    for (const child of children) {
      if (child.nodeType !== "directory") continue;
      const name = typeof child.name === "string" ? child.name : "";
      const childId = typeof child.id === "string" ? child.id : "";
      if (!name || !childId || name === REVISIONS_FOLDER) continue;
      const folder = prefix ? `${prefix}/${name}` : name;
      const state = asState(
        await readAppSheetJsonAt(
          ctx,
          accountId,
          `${KNOWLEDGE_FOLDER}/${folder}/${STATE_FILE}`,
        ),
      );
      if (match({ nodeId: childId, folder, state }))
        return { nodeId: childId, parentId, folder };
      const nested = await walk(childId, folder, childId);
      if (nested) return nested;
    }
    return null;
  };
  return walk(tierFolderId, "", null);
}
