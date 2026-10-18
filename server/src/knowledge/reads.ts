/**
 * Reading one article and its revision history.
 *
 * The draft, the lifecycle document and the revisions are read through the
 * article path the walk resolves; a revision is read by id, because the
 * history beside it is a page and the revision in force is not something a
 * page may decide.
 */

import {
  type Ctx,
  documentType,
  downloadBlobText,
  fileChildren,
  findFolderPath,
  nodeStamp,
  readAppJsonAt,
} from "../appFolder.js";
import { FILE_PROPS } from "../shared/appFolder.js";
import {
  compareRevisionsNewestFirst,
  DRAFT_FILE,
  isKnowledgeRevision,
  type KnowledgeArticleView,
  type KnowledgeRevision,
  knowledgeSummary,
  REVISIONS_FOLDER,
  revisionFileName,
  revisionInForceAt,
  revisionSummary,
  STATE_FILE,
} from "../shared/knowledge.js";
import { asDraft, asState } from "./documents.js";
import { scopeOfAccount } from "./scope.js";
import { articlePathOf, findArticleFolder } from "./tree.js";

/**
 * How many revisions of an article one history read takes.
 *
 * A revision is a document of its own and the folder keeps them for ever, so the
 * history is chosen from the listing newest-first and only this many documents
 * are downloaded: the surface shows a history, not an archive, and an article
 * past this many revisions still answers its newest ones.
 */
export const REVISION_HISTORY_MAX = 50;

/** Read the newest revisions of an article, newest first by approval. */
export async function readRevisions(
  ctx: Ctx,
  accountId: string,
  articlePath: string,
): Promise<KnowledgeRevision[]> {
  const revisionsFolder = await findFolderPath(
    ctx,
    accountId,
    `${articlePath}/${REVISIONS_FOLDER}`,
  );
  if (!revisionsFolder) return [];
  const files = await fileChildren(ctx, accountId, revisionsFolder, [
    ...FILE_PROPS,
    "created",
    "modified",
  ]);
  const newest = files
    .filter((file) => file.nodeType === "file" && typeof file.blobId === "string")
    .sort((a, b) => nodeStamp(b).localeCompare(nodeStamp(a)))
    .slice(0, REVISION_HISTORY_MAX);
  const out: KnowledgeRevision[] = [];
  for (const file of newest) {
    const name = typeof file.name === "string" ? file.name : "revision.json";
    const type = documentType(file);
    try {
      const text = await downloadBlobText(
        ctx,
        accountId,
        String(file.blobId),
        type,
        name,
      );
      const parsed = JSON.parse(text) as unknown;
      if (isKnowledgeRevision(parsed)) out.push(parsed);
    } catch {
      // A revision that cannot be read is skipped: the history shows what it
      // can rather than a surface taken down by one unreadable document.
    }
  }
  out.sort(compareRevisionsNewestFirst);
  return out;
}

/** The document of one revision, by id, wherever the article's history is short. */
export async function readRevision(
  ctx: Ctx,
  accountId: string,
  articlePath: string,
  revisionId: string,
): Promise<KnowledgeRevision | null> {
  const raw = await readAppJsonAt(
    ctx,
    accountId,
    `${articlePath}/${REVISIONS_FOLDER}/${revisionFileName(revisionId)}`,
  );
  return isKnowledgeRevision(raw) ? raw : null;
}

/**
 * Open one article, or null when the folder is not there.
 *
 * `folderId` is the tier root the path is resolved against; `folder` is the
 * tier-relative path (the shape `KnowledgeSummary.folder` carries), so a
 * sub-article is `"Parent/Child"`. The `effective` revision is the one the
 * lifecycle names at now, **read by id**: the history beside it is a page, and
 * the revision in force is not something a page may decide (an article past
 * `REVISION_HISTORY_MAX` revisions would otherwise read as having none).
 */
export async function readArticle(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  folder: string,
): Promise<KnowledgeArticleView | null> {
  const article = await findArticleFolder(ctx, accountId, folderId, folder);
  if (!article) return null;
  const articlePath = articlePathOf(article);
  const draft = asDraft(
    await readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
  );
  const state = asState(
    await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
  );
  const revisions = await readRevisions(ctx, accountId, articlePath);
  const issued = state ? revisionInForceAt(state) : null;
  const effective = issued
    ? await readRevision(ctx, accountId, articlePath, issued.revision)
    : null;
  return {
    scope: scopeOfAccount(ctx, accountId),
    accountId,
    summary: knowledgeSummary({
      state,
      draft,
      folder: article.folder,
      nodeId: article.nodeId,
      parentId: article.parentId,
      saved: draft !== null,
    }),
    draft,
    effective,
    revisions: revisions.map(revisionSummary),
  };
}
