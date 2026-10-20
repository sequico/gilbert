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
import { FILE_PROPS, STAMP_PROPS } from "../shared/appFolder.js";
import { mapLimit, READ_CONCURRENCY } from "../shared/concurrency.js";
import {
  compareRevisionsNewestFirst,
  DRAFT_FILE,
  isKnowledgeRevision,
  type KnowledgeArticleView,
  type KnowledgeRevision,
  knowledgeSummary,
  REVISION_HISTORY_MAX,
  REVISIONS_FOLDER,
  revisionFileName,
  revisionInForceAt,
  revisionSummary,
  STATE_FILE,
} from "../shared/knowledge.js";
import { asDraft, asState } from "./documents.js";
import { scopeOfAccount } from "./scope.js";
import { articlePathOf, findArticleFolder } from "./tree.js";

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
    ...STAMP_PROPS,
  ]);
  const newest = files
    .filter((file) => file.nodeType === "file" && typeof file.blobId === "string")
    .sort((a, b) => nodeStamp(b).localeCompare(nodeStamp(a)))
    .slice(0, REVISION_HISTORY_MAX);
  /*
   * One download per revision and each independent: the history is read in
   * bounded parallel rather than one round trip after another, so opening an
   * article does not cost as long as its own history.
   */
  const read = await mapLimit(newest, READ_CONCURRENCY, async (file) => {
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
      return isKnowledgeRevision(parsed) ? parsed : null;
    } catch {
      // A revision that cannot be read is skipped: the history shows what it
      // can rather than a surface taken down by one unreadable document.
      return null;
    }
  });
  const out = read.filter((revision): revision is KnowledgeRevision => revision !== null);
  out.sort(compareRevisionsNewestFirst);
  return out;
}

/**
 * The highest revision number the article's store holds, or 0 when it holds
 * none.
 *
 * Revisions are immutable and numbered forward at approval, so the newest file
 * carries the highest number — including one whose state write never landed.
 * Reading that one document answers the question the whole history was read
 * for.
 */
export async function highestRevisionNumber(
  ctx: Ctx,
  accountId: string,
  articlePath: string,
): Promise<number> {
  const revisionsFolder = await findFolderPath(
    ctx,
    accountId,
    `${articlePath}/${REVISIONS_FOLDER}`,
  );
  if (!revisionsFolder) return 0;
  const files = await fileChildren(ctx, accountId, revisionsFolder, [
    ...FILE_PROPS,
    ...STAMP_PROPS,
  ]);
  const newest = files
    .filter((file) => file.nodeType === "file" && typeof file.blobId === "string")
    .sort((a, b) => nodeStamp(b).localeCompare(nodeStamp(a)))[0];
  if (!newest) return 0;
  try {
    const text = await downloadBlobText(
      ctx,
      accountId,
      String(newest.blobId),
      documentType(newest),
      typeof newest.name === "string" ? newest.name : "revision.json",
    );
    const parsed = JSON.parse(text) as unknown;
    return isKnowledgeRevision(parsed) ? parsed.rev : 0;
  } catch {
    return 0;
  }
}

/**
 * Whether an article's revision store holds any document.
 *
 * The question a delete asks — was anything ever issued from this page? — is
 * answered by the listing alone: downloading the revisions to count them costs
 * as much as reading the whole history.
 */
export async function revisionsExist(
  ctx: Ctx,
  accountId: string,
  articlePath: string,
): Promise<boolean> {
  const revisionsFolder = await findFolderPath(
    ctx,
    accountId,
    `${articlePath}/${REVISIONS_FOLDER}`,
  );
  if (!revisionsFolder) return false;
  const files = await fileChildren(ctx, accountId, revisionsFolder);
  return files.some((file) => file.nodeType === "file" && typeof file.name === "string");
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
 *
 * `history: false` is the reader that needs the page and not its past — the
 * agent's, above all: the history is up to `REVISION_HISTORY_MAX` documents, and
 * a turn that reads a page to answer a question pays for none of them. The
 * revision in force is then the one read, and it is the only one.
 */
export async function readArticle(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  folder: string,
  opts: { history?: boolean } = {},
): Promise<KnowledgeArticleView | null> {
  const article = await findArticleFolder(ctx, accountId, folderId, folder);
  if (!article) return null;
  const articlePath = articlePathOf(article);
  // Three independent reads, so they travel together: the draft, the lifecycle
  // pointer and the history do not depend on one another.
  const [draftRaw, stateRaw, revisions] = await Promise.all([
    readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
    readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    opts.history === false ? [] : readRevisions(ctx, accountId, articlePath),
  ]);
  const draft = asDraft(draftRaw);
  const state = asState(stateRaw);
  const issued = state ? revisionInForceAt(state) : null;
  /*
   * The revision the lifecycle names is usually the newest one the history has
   * just read, and reading it again by id would download the same document
   * twice. What is in the history is used; a revision older than the page (a
   * restored one) is read by id, exactly as before.
   */
  const effective = issued
    ? (revisions.find((one) => one.revision === issued.revision) ??
      (await readRevision(ctx, accountId, articlePath, issued.revision)))
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

/**
 * One revision of one article by its id, without the history around it.
 *
 * A workorder is bound to a revision, and the builder asks for that revision's
 * rules alone: reading the whole article to find the document already named
 * would cost a history per pick.
 */
export async function readArticleRevision(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  folder: string,
  revisionId: string,
): Promise<KnowledgeRevision | null> {
  const clean = (revisionId ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) return null;
  const article = await findArticleFolder(ctx, accountId, folderId, folder);
  if (!article) return null;
  return await readRevision(ctx, accountId, articlePathOf(article), clean);
}

/**
 * One article's draft text, and nothing else.
 *
 * Search reads the body of every page, and the whole article view would make
 * that cost a revision history per page: what a search indexes is the draft's
 * own text, so that is the only document read here.
 */
export async function readDraftText(
  ctx: Ctx,
  accountId: string,
  folderId: string,
  folder: string,
): Promise<string | null> {
  const article = await findArticleFolder(ctx, accountId, folderId, folder);
  if (!article) return null;
  const draft = asDraft(
    await readAppJsonAt(ctx, accountId, `${articlePathOf(article)}/${DRAFT_FILE}`),
  );
  return draft?.text ?? "";
}
