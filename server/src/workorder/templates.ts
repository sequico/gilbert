/**
 * The checklist template a workorder's revision names (ADR 0030).
 *
 * A checklist stores the template's id and revision and never a copy of the
 * controlled text, so the rules are resolved from the KB revision here.
 */

import { type Ctx, findFolderPath, readAppJsonAt } from "../appFolder.js";
import { findArticleById } from "../knowledgeAdmin.js";
import {
  isKnowledgeRevision,
  isKnowledgeState,
  KNOWLEDGE_FOLDER,
  type KnowledgeChecklist,
  REVISIONS_FOLDER,
  revisionFileName,
  STATE_FILE,
} from "../shared/knowledge.js";
import type { WorkorderTemplateRef } from "../shared/workorder.js";
import type { WorkorderReach } from "./reach.js";

/** A template revision's rules and title as the KB serves them (ADR 0030). */
export interface TemplateDef {
  checklist: KnowledgeChecklist | null;
  title: string | null;
  rev: number | null;
}

/**
 * A template revision's rules and title, **resolved once per request**.
 *
 * The same revision is read by the view a read composes (every visible part)
 * and by the gate reconcile a write runs after it; on one request that is the
 * same bytes asked for several times, so the promise is kept on the reach and
 * returned to whoever asks next. The key is the bound reference — the account,
 * the article and the revision it names (ADR 0028) — so two workorders bound to
 * two revisions never share an answer.
 */
export function templateDef(
  reach: WorkorderReach,
  template: WorkorderTemplateRef,
): Promise<TemplateDef> {
  const key = `${template.accountId}:${template.id}:${template.revision}`;
  const cached = reach.defs.get(key);
  if (cached) return cached;
  const resolved = readTemplateDef(reach.ctx, template);
  reach.defs.set(key, resolved);
  return resolved;
}

/**
 * The template revision's **rules** and title, read from the KB (ADR 0030).
 *
 * A checklist stores the template's id and revision and never a copy of the
 * controlled text, so every label and every branch is resolved from the
 * revision here. A template that cannot be read — one the Master cannot reach,
 * or a revision that is not there — leaves its rules unresolved and is a
 * finding, not a surface taken down.
 */
async function readTemplateDef(
  ctx: Ctx,
  template: WorkorderTemplateRef,
): Promise<TemplateDef> {
  let title: string | null = null;
  let rev: number | null = null;
  try {
    const tierFolder = await findFolderPath(ctx, template.accountId, KNOWLEDGE_FOLDER);
    if (!tierFolder) return { checklist: null, title, rev };
    const article = await findArticleById(
      ctx,
      template.accountId,
      tierFolder,
      template.id,
    );
    if (!article) return { checklist: null, title, rev };
    const state = await readAppJsonAt(
      ctx,
      template.accountId,
      `${KNOWLEDGE_FOLDER}/${article.folder}/${STATE_FILE}`,
    );
    title = isKnowledgeState(state) ? state.title : null;
    const revision = await readAppJsonAt(
      ctx,
      template.accountId,
      `${KNOWLEDGE_FOLDER}/${article.folder}/${REVISIONS_FOLDER}/${revisionFileName(template.revision)}`,
    );
    if (!isKnowledgeRevision(revision)) return { checklist: null, title, rev };
    rev = revision.rev;
    return { checklist: revision.checklist ?? null, title, rev };
  } catch {
    // A template that cannot be read leaves the rules unresolved; the
    // checklist itself is still served, so the workorder reads rather than
    // disappears.
    return { checklist: null, title, rev };
  }
}
