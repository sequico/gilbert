/**
 * The knowledge base (ADR 0020): the company tier, read and written as the
 * Master, and the group tier a member reads and writes with their own session.
 */

import type { Context, Hono } from "hono";
import {
  approveArticle,
  companyArticle,
  companyKnowledgeAccount,
  companyTree,
  createArticle,
  createFolder,
  deleteArticle,
  KnowledgeAdminError,
  moveArticle,
  readArticleRevision,
  readDraftText,
  renameArticle,
  reorderArticle,
  reorderArticleInTier,
  restoreArticle,
  saveDraft,
  tierAccount,
} from "../knowledgeAdmin.js";
import { errorMessage } from "../shared/errors.js";
import {
  isKnowledgeChecklist,
  type KnowledgeArticleInput,
  type KnowledgeChecklist,
  type KnowledgeTarget,
} from "../shared/knowledge.js";
import type { Env } from "./shared.js";
import {
  enforceAdmin,
  failureFor,
  readJson,
  requireAdmin,
  requireSession,
} from "./shared.js";

export function registerKnowledgeRoutes(api: Hono<Env>): void {
  // ---------- The knowledge base (ADR 0020) ----------

  /** A refusal from the KB surfaces: the code and the sentence, or upstream's. */
  const knowledgeFailure = failureFor(KnowledgeAdminError);

  /**
   * The scope of a KB request, checked before anything is asked of a server.
   *
   * Every write names the tier it acts on: the company's or a group the caller
   * is a member of. A group scope without a name is a refusal here, where the
   * sentence names what is missing, rather than a 403 from a membership check
   * about an empty group.
   */
  const knowledgeTarget = (
    body: {
      scope?: unknown;
      group?: unknown;
      folder?: unknown;
    } | null,
  ): KnowledgeTarget => {
    const raw = body?.scope;
    const scope = raw === "company" || raw === "group" ? raw : null;
    if (!scope)
      throw new KnowledgeAdminError(
        "bad_request",
        'The scope must be "company" or "group".',
      );
    const group = typeof body?.group === "string" ? body.group.trim() : "";
    if (scope === "group" && !group)
      throw new KnowledgeAdminError(
        "bad_request",
        "A group knowledge base needs the group's name.",
      );
    const folder = typeof body?.folder === "string" ? body.folder : "";
    const target: KnowledgeTarget = { scope };
    if (group) target.group = group;
    if (folder) target.folder = folder;
    return target;
  };

  /**
   * The shape of a group's tree is its members' (`gilbert-groups`): creating,
   * creating a folder, renaming, moving, reordering and restoring in a group's
   * KB is what membership gives, and the write is made with the member's own
   * session. Approval and dealing with a page for good stay an administrator's
   * (ADR 0020, ADR 0013), on `requireAdmin`. The company tier is an
   * administration write throughout, on the same door as every other admin
   * route.
   */
  const adminUnlessGroup = async (
    c: Context<Env>,
    target: KnowledgeTarget,
  ): Promise<Response | null> => {
    if (target.scope === "group") return null;
    return await enforceAdmin(c);
  };

  /** A tag that is not text is a body that does not fit, not a tag to drop. */
  const badTags = new KnowledgeAdminError(
    "bad_request",
    "An article's tags are text: one of them is not.",
  );

  /** The editor's small shape, narrowed to what the draft writes. */
  const knowledgeInput = (raw: unknown): KnowledgeArticleInput => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const checklist = r.checklist ?? null;
    if (
      typeof r.title !== "string" ||
      !Array.isArray(r.tags) ||
      !Array.isArray(r.blocks) ||
      typeof r.text !== "string" ||
      (checklist !== null && !isKnowledgeChecklist(checklist))
    )
      throw new KnowledgeAdminError(
        "bad_request",
        "The article body must carry title, tags, blocks and text.",
      );
    return {
      title: r.title,
      /*
       * Refused rather than filtered. A tag that is a number or an object is a
       * body that does not fit, and dropping it would write the article without
       * the label a reader files it by, answer success, and leave the person's
       * own text missing from the page they just saved.
       */
      tags: r.tags.map((tag) => {
        if (typeof tag !== "string") throw badTags;
        return tag;
      }),
      blocks: r.blocks,
      text: r.text,
      checklist: (checklist as KnowledgeChecklist | null) ?? null,
    };
  };

  const bodyFolder = (body: { folder?: unknown } | null): string =>
    typeof body?.folder === "string" ? body.folder : "";

  /**
   * Where the company knowledge base lives: its account and root folder.
   *
   * The surface reads the articles through `/knowledge/company/tree` and
   * `/knowledge/company/article`; this answers the **location** a caller that
   * composes the tree itself names (the door test reaching the folder id, and a
   * future reader of the same shape). The folder is made on demand, so there is
   * no absent state to report: a failure here is a deployment error
   * (`agent_not_configured`, `no_knowledge_account`) and is answered as one.
   */
  api.get("/knowledge/company", requireSession, async (c) => {
    try {
      const tier = await companyKnowledgeAccount(c.get("session"));
      return c.json({
        ok: true,
        company: { accountId: tier.accountId, folderId: tier.folderId },
      });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  /**
   * The company KB's tree, read as the Master (ADR 0020).
   *
   * A reader is not a member of the Master's account, so the company tier is
   * served here rather than by a JMAP share; the same door every write uses
   * reads it. `accountId` names the tier the folders belong to, so the surface
   * can tell a company article from a group's.
   */
  api.get("/knowledge/company/tree", requireSession, async (c) => {
    try {
      const tree = await companyTree(c.get("session"), {
        includeRetired: c.req.query("retired") === "1",
      });
      return c.json({ ok: true, accountId: tree.accountId, articles: tree.articles });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  /**
   * One company article by its tier-relative folder, read as the Master.
   *
   * A folder that is not there answers `article: null` — a state the surface
   * shows as nothing rather than a failure the reader cannot act on.
   */
  api.get("/knowledge/company/article", requireSession, async (c) => {
    try {
      return c.json({
        ok: true,
        article: await companyArticle(c.get("session"), c.req.query("folder") ?? ""),
      });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  /**
   * One company article's draft text, without its history.
   *
   * The search index reads every page's body, and the whole article view would
   * make that cost a revision history per page: this answers the one document
   * a search reads. A folder that is not there answers `text: null`.
   */
  api.get("/knowledge/company/text", requireSession, async (c) => {
    try {
      const { ctx, accountId, folderId } = await companyKnowledgeAccount(
        c.get("session"),
      );
      return c.json({
        ok: true,
        text: await readDraftText(ctx, accountId, folderId, c.req.query("folder") ?? ""),
      });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  /**
   * One revision of a company article, without the history around it.
   *
   * A workorder binds to a revision and its builder needs that revision's
   * rules: reading the article whole to find a document already named would
   * cost a history per pick.
   */
  api.get("/knowledge/company/revision", requireSession, async (c) => {
    try {
      const { ctx, accountId, folderId } = await companyKnowledgeAccount(
        c.get("session"),
      );
      const revision = await readArticleRevision(
        ctx,
        accountId,
        folderId,
        c.req.query("folder") ?? "",
        c.req.query("revision") ?? "",
      );
      return c.json({
        ok: true,
        revision: revision
          ? {
              revision: revision.revision,
              rev: revision.rev,
              checklist: revision.checklist ?? null,
            }
          : null,
      });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/create", requireSession, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      title?: unknown;
      parentFolder?: unknown;
      blocks?: unknown;
      checklist?: unknown;
    }>(c);
    try {
      const target = knowledgeTarget(body);
      const refusal = await adminUnlessGroup(c, target);
      if (refusal) return refusal;
      const parentFolder = body?.parentFolder;
      const rawChecklist = body?.checklist ?? null;
      // A create refuses a malformed definition rather than silently making an
      // ordinary page of it, so a caller never believes it created a template.
      if (rawChecklist !== null && !isKnowledgeChecklist(rawChecklist))
        throw new KnowledgeAdminError(
          "bad_request",
          "A checklist definition must carry the variants and sections of a process.",
        );
      const summary = await createArticle(
        c.get("session"),
        target,
        typeof body?.title === "string" ? body.title : "",
        typeof parentFolder === "string" && parentFolder.trim()
          ? parentFolder.trim()
          : null,
        Array.isArray(body?.blocks) ? body.blocks : [],
        rawChecklist as KnowledgeChecklist | null,
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/save", requireSession, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      folder?: unknown;
      input?: unknown;
    }>(c);
    try {
      const target = knowledgeTarget(body);
      // The company tier is an administration write; in a group's tier a
      // member's write is the draft of a page that exists, so that one shared
      // write cannot carry `requireAdmin`.
      const refusal = await adminUnlessGroup(c, target);
      if (refusal) return refusal;
      const summary = await saveDraft(
        c.get("session"),
        target,
        bodyFolder(body),
        knowledgeInput(body?.input),
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/rename", requireSession, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      folder?: unknown;
      title?: unknown;
    }>(c);
    try {
      const target = knowledgeTarget(body);
      const refusal = await adminUnlessGroup(c, target);
      if (refusal) return refusal;
      const summary = await renameArticle(
        c.get("session"),
        target,
        bodyFolder(body),
        typeof body?.title === "string" ? body.title : "",
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/restore", requireSession, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      folder?: unknown;
      revision?: unknown;
    }>(c);
    try {
      const target = knowledgeTarget(body);
      const refusal = await adminUnlessGroup(c, target);
      if (refusal) return refusal;
      const summary = await restoreArticle(
        c.get("session"),
        target,
        bodyFolder(body),
        typeof body?.revision === "string" ? body.revision : "",
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/approve", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      folder?: unknown;
      effectiveAt?: unknown;
    }>(c);
    try {
      const summary = await approveArticle(
        c.get("session"),
        knowledgeTarget(body),
        bodyFolder(body),
        typeof body?.effectiveAt === "string" ? body.effectiveAt : "",
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/delete", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      folder?: unknown;
    }>(c);
    try {
      const result = await deleteArticle(
        c.get("session"),
        knowledgeTarget(body),
        bodyFolder(body),
      );
      return c.json({ ok: true, retired: result.retired });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/folder", requireSession, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      name?: unknown;
      parentFolder?: unknown;
    }>(c);
    try {
      const target = knowledgeTarget(body);
      const refusal = await adminUnlessGroup(c, target);
      if (refusal) return refusal;
      const parentFolder = body?.parentFolder;
      const summary = await createFolder(
        c.get("session"),
        target,
        typeof body?.name === "string" ? body.name : "",
        typeof parentFolder === "string" && parentFolder.trim()
          ? parentFolder.trim()
          : null,
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/reorder", requireSession, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      folder?: unknown;
      order?: unknown;
      orders?: unknown;
    }>(c);
    try {
      const target = knowledgeTarget(body);
      const refusal = await adminUnlessGroup(c, target);
      if (refusal) return refusal;
      /*
       * A family renumbered at once. A drop orders two neighbours by their
       * midpoint, and the fractional gap runs out of precision after enough
       * drops into one slot; the client then sends every sibling's new place in
       * one request. Each is applied with its own compare-and-set, so the
       * numbers stay independent (ADR 0020).
       *
       * What a failure does **not** do is leave the rest as the client sent
       * them: this is a loop of writes, and one that throws stops the loop with
       * its predecessors already written. An error answer alone would then be
       * a lie in both directions — the client's cached order is wrong, and a
       * retry applies a different set from the one that landed. So each item is
       * reported: what was written, and what was not.
       */
      if (Array.isArray(body?.orders)) {
        const applied: string[] = [];
        const refused: Array<{ folder: string; error: string }> = [];
        /*
         * The tier is resolved once for the family: every item is the same
         * account, and resolving it per row would pay a live membership probe
         * and a session for each sibling. The writes stay independent (each has
         * its own compare-and-set), which is the point of the batch.
         */
        const tier = await tierAccount(c.get("session"), target);
        const by = c.get("session").username;
        for (const item of body.orders as Array<{
          folder?: unknown;
          order?: unknown;
        }>) {
          const folder = typeof item?.folder === "string" ? item.folder : "";
          try {
            await reorderArticleInTier(
              tier,
              folder,
              typeof item?.order === "number" ? item.order : Number.NaN,
              by,
            );
            applied.push(folder);
          } catch (err) {
            refused.push({ folder, error: errorMessage(err) });
          }
        }
        return c.json({ ok: refused.length === 0, applied, refused });
      }
      const summary = await reorderArticle(
        c.get("session"),
        target,
        bodyFolder(body),
        typeof body?.order === "number" ? body.order : Number.NaN,
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });

  api.post("/knowledge/move", requireSession, async (c) => {
    const body = await readJson<{
      scope?: unknown;
      group?: unknown;
      folder?: unknown;
      parentFolder?: unknown;
    }>(c);
    try {
      const target = knowledgeTarget(body);
      const refusal = await adminUnlessGroup(c, target);
      if (refusal) return refusal;
      const parentFolder = body?.parentFolder;
      const summary = await moveArticle(
        c.get("session"),
        target,
        bodyFolder(body),
        typeof parentFolder === "string" && parentFolder.trim()
          ? parentFolder.trim()
          : null,
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return knowledgeFailure(c, err);
    }
  });
}
