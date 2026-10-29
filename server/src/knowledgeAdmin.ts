/**
 * The knowledge base's write door (ADR 0020).
 *
 * The KB is a tree of articles under `gilbert/knowledge` in an account's own
 * app folder: the company's in the Master's account, a group's in the group's.
 * A **write** is made with the session that owns the documents where there is
 * one, and the company tier is the exception: a reader's own session holds
 * nothing of the Master's account, so the company's is written as the Master
 * (the installation's agent credential, or impersonation from the caller's
 * session) and **read** through the same door as a server route — a `shareWith`
 * cannot name every account (Stalwart caps a share at 10 principals per item).
 * A group's KB is reached by membership, and written with the member's own
 * session, so the installation's agent needs no grant on the group and the
 * draft records who last changed it.
 *
 * The durable shape, the validators and the lifecycle arithmetic live in
 * `@gilbert/shared/knowledge`; this module only resolves which account and
 * folder an article lives in and applies the editors and revisions to it.
 *
 * Approval is an administrator's alone (Q8): the routes gate it with
 * `requireAdmin` and this door takes the approver and the instant from the
 * authenticated session, never from the request.
 *
 * It defines nothing: each helper lives in the job-shaped module beside this
 * one under `server/src/knowledge/`, and these lines re-export the same names
 * callers already import.
 */

export {
  approveArticle,
  createArticle,
  createFolder,
  deleteArticle,
  moveArticle,
  proposeArticle,
  renameArticle,
  reorderArticle,
  reorderArticleInTier,
  restoreArticle,
  saveDraft,
} from "./knowledge/editors.js";
export { KnowledgeAdminError, requireState } from "./knowledge/errors.js";
export {
  companyArticle,
  companyTree,
  findArticleById,
  listArticles,
} from "./knowledge/listing.js";
export {
  readArticle,
  readArticleRevision,
  readDraftText,
} from "./knowledge/reads.js";
export {
  companyKnowledgeAccount,
  ensureKnowledge,
  tierAccount,
} from "./knowledge/scope.js";
