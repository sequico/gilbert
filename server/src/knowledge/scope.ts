/**
 * Where a tier's knowledge base lives.
 *
 * The company tier is the Master's own account and its KB folder, written as
 * the Master because a reader holds nothing of that account. A group's tier is
 * a non-personal account the caller is a member of, written with the caller's
 * own session. Both resolve to the account and folder every other module here
 * reads and writes through.
 */

import { openMasterAccount } from "../adminSession.js";
import { type Ctx, ensureFolderPath } from "../appFolder.js";
import { memberGroupAccess } from "../groupAccess.js";
import type { LiveSession } from "../sessions.js";
import {
  KNOWLEDGE_FOLDER,
  type KnowledgeScope,
  type KnowledgeTarget,
} from "../shared/knowledge.js";
import { isGroupAccountRecord } from "../shared/sessionAccount.js";
import { KnowledgeAdminError } from "./errors.js";

/* ------------------------------------------------------------------ */
/* Where a tier's knowledge base lives                                 */
/* ------------------------------------------------------------------ */

/**
 * Ensure `gilbert/knowledge` exists in the account.
 *
 * The folder is the whole of what a tier needs here: the company KB reaches
 * every account through the server route this door serves — a `shareWith`
 * cannot name every account — and a group's KB is reached by membership.
 * Neither is a share, so making the folder is all this does.
 */
export async function knowledgeFolder(ctx: Ctx, accountId: string): Promise<string> {
  return ensureFolderPath(ctx, accountId, KNOWLEDGE_FOLDER);
}

/**
 * Make the Master's company knowledge base exist.
 *
 * Run at boot so the company KB is there for every reader without anyone
 * creating it — a thing the product needs is made to happen, not asked for with
 * a button. Idempotent and safe on every boot. Readers reach the folder through
 * the route, not a share; a group's KB is created on first use, as
 * `gilbert/chat` is, and by membership.
 */
export async function ensureKnowledge(ctx: Ctx, accountId: string): Promise<void> {
  await knowledgeFolder(ctx, accountId);
}

/**
 * The company tier: the Master's own account and its KB folder.
 *
 * The Master's session comes from the shared admin-session door, with the KB's
 * own sentence and error (`adminSession.ts`).
 */
export async function companyKnowledgeAccount(
  admin: LiveSession,
): Promise<{ ctx: Ctx; accountId: string; folderId: string }> {
  const { ctx, accountId } = await openMasterAccount(admin, {
    what: "the knowledge base",
    missingCode: "no_knowledge_account",
    missingMessage:
      "The Master's own account could not be read, so the company knowledge base cannot be reached.",
    files: true,
    refuse: (code, message, status) => new KnowledgeAdminError(code, message, status),
  });
  // Readers reach the folder through the route this door serves, not a share,
  // so making the folder is all this resolves.
  const folderId = await knowledgeFolder(ctx, accountId);
  return { ctx, accountId, folderId };
}

/**
 * The group tier: the caller's membership is the grant, and the group's KB is
 * written with the caller's own session.
 *
 * The membership read is the member door's own (`memberGroupAccess`), forced
 * live so a member removed from the group loses access at once; its answer is
 * both the account the group's documents live in and the session that reaches
 * them. A refusal keeps the denial's code and answers 403. Nothing here acts as
 * the Master: the installation's agent needs no grant on the group, and the
 * draft records the member who wrote it as its last change.
 */
export async function groupKnowledgeAccount(
  admin: LiveSession,
  group: string,
): Promise<{ ctx: Ctx; accountId: string; folderId: string }> {
  const access = await memberGroupAccess(admin, group, { need: "knowledge" });
  if (!access.ok)
    throw new KnowledgeAdminError(
      access.error,
      `The knowledge base of "${group.trim() || group}" is out of reach: you may not be a member of that group, or the mail server did not answer about it.`,
      403,
    );
  // The group's KB is reached by membership, never a share (`gilbert-groups`);
  // only the folder is made, on first use.
  const folderId = await knowledgeFolder(access.ctx, access.accountId);
  return { ctx: access.ctx, accountId: access.accountId, folderId };
}

/** Which tier a target names, with the account and KB folder resolved. */
export async function tierAccount(
  admin: LiveSession,
  target: KnowledgeTarget,
): Promise<{ ctx: Ctx; accountId: string; folderId: string }> {
  if (target.scope === "group") {
    const group = (target.group ?? "").trim();
    if (!group)
      throw new KnowledgeAdminError(
        "bad_request",
        "A group knowledge base needs the group's name.",
      );
    return groupKnowledgeAccount(admin, group);
  }
  return companyKnowledgeAccount(admin);
}

/**
 * The scope is a fact about the owning account, not a parameter: the company KB
 * is the Master's own personal account, a group's is a non-personal one the
 * caller is a member of (ADR 0020's two tiers). `readArticle` therefore derives
 * it the same way `groupKnowledgeAccount` finds the group.
 */
export function scopeOfAccount(ctx: Ctx, accountId: string): KnowledgeScope {
  const account = ctx.session.accounts?.[accountId] as
    | { name?: unknown; isPersonal?: unknown }
    | undefined;
  return isGroupAccountRecord(account) ? "group" : "company";
}
