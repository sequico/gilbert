/**
 * The campaign's script, as the group's knowledge base holds it (ADR 0040).
 *
 * A campaign reads **one revision** of its script: two callers saying different
 * things because somebody edited the page on Wednesday is worse than a script that
 * is a week old, so the campaign pins the revision it started with and this is the
 * reader that answers it — the revision it asked for, never the one in force today.
 *
 * The page is the group's own, in the group's own account, read with the caller's
 * session like every other document here. A page deleted after the campaign started
 * is not an error the caller can act on: the campaign keeps its ref and the screen
 * shows no script.
 */

import { type Ctx, findFolderPath } from "../appFolder.js";
import { findArticleById, listArticles } from "../knowledge/listing.js";
import { readArticle, readRevision } from "../knowledge/reads.js";
import { KNOWLEDGE_FOLDER } from "../shared/knowledge.js";
import type { CampaignScriptRef } from "../shared/outbound.js";

/** One page a campaign may take its script from, as the client chooses it. */
export interface ScriptPage {
  nodeId: string;
  /** The tier-relative folder path: the page's name, and what a reader sees. */
  folder: string;
  /** The revision in force when it was chosen: what a new campaign pins. */
  revision: string;
}

/** The group's knowledge pages, with the revision each one is at. */
export async function listScriptPages(
  ctx: Ctx,
  accountId: string,
): Promise<ScriptPage[]> {
  const tier = await findFolderPath(ctx, accountId, KNOWLEDGE_FOLDER);
  if (!tier) return [];
  const articles = await listArticles(ctx, accountId, tier);
  const pages: ScriptPage[] = [];
  for (const article of articles) {
    const view = await readArticle(ctx, accountId, tier, article.folder, {
      history: false,
    });
    if (view?.effective) {
      pages.push({
        nodeId: view.summary.nodeId,
        folder: article.folder,
        revision: view.effective.revision,
      });
    }
  }
  return pages;
}

/** The text of the revision a campaign pinned, or null when it is no longer there. */
export async function readScript(
  ctx: Ctx,
  accountId: string,
  script: CampaignScriptRef | null,
): Promise<string | null> {
  if (!script) return null;
  const tier = await findFolderPath(ctx, accountId, KNOWLEDGE_FOLDER);
  if (!tier) return null;
  const article = await findArticleById(ctx, accountId, tier, script.nodeId);
  if (!article) return null;
  const revision = await readRevision(
    ctx,
    accountId,
    `${KNOWLEDGE_FOLDER}/${article.folder}`,
    script.revision,
  );
  return revision ? revision.text : null;
}
