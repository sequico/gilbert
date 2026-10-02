/**
 * The knowledge base, client half (ADR 0024).
 *
 * The durable format — the draft, the revisions, the lifecycle pointer, the
 * validators and the pure helpers — is one definition in
 * `@gilbert/shared/knowledge`, read by both tiers. This module is the client's
 * read of it: the FileNode tree under `gilbert/knowledge` in an account's app
 * folder, and the server routes that read and write the company KB as the
 * Master. The shared half is re-exported, so `@/lib/knowledge` is the one
 * import a surface needs.
 *
 * Writes go through `/api/knowledge/*`, because the company KB lives in the
 * Master's account and a reader reaches it through a route, not a session that
 * may write it (ADR 0024, Q1). The **company** KB is read through the route
 * too: a `shareWith` naming every account cannot work (Stalwart caps a share at
 * 10 principals per item, live-probed; ADR 0023), so the route is how every
 * account reaches the folder. A group's KB is read straight from the reader's
 * own session on the group account, membership being the grant; its approval
 * still goes through the route, an administrator's alone.
 */

import { APP_DOCUMENT_TYPE, FOLDER_PROPS } from "@gilbert/shared/appFolder";
import {
  compareKnowledgeSiblings,
  compareRevisionsNewestFirst,
  DRAFT_FILE,
  isKnowledgeDraft,
  isKnowledgeFolderDoc,
  isKnowledgeRevision,
  isKnowledgeState,
  isRetired,
  KNOWLEDGE_FOLDER,
  KNOWLEDGE_FOLDER_FILE,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeRevision,
  type KnowledgeScope,
  type KnowledgeSummary,
  type KnowledgeTarget,
  knowledgeSummary,
  orderBetween,
  REVISIONS_FOLDER,
  revisionInForceAt,
  revisionSummary,
  STATE_FILE,
} from "@gilbert/shared/knowledge";
import { apiFetch, client } from "@/jmap/client";
import type { FileNode, GetResponse, Id } from "@/jmap/types";
import { findAppFolder, findInFolder, listChildrenWithState } from "@/lib/appFolder";

export * from "@gilbert/shared/knowledge";

/**
 * The FileNode properties a KB read asks for: enough to tell a folder from a
 * file, find the reserved documents by name and read their blobs. `name` and
 * `nodeType` carry the tree, `blobId` the documents.
 */
const ARTICLE_PROPS = [...FOLDER_PROPS, "blobId", "type"];

/** One JSON document's parsed value, straight from its blob. */
export async function readJsonNode(accountId: Id, blobId: Id): Promise<unknown> {
  const text = await client.fetchBlobText(accountId, blobId, APP_DOCUMENT_TYPE);
  return JSON.parse(text) as unknown;
}

/**
 * The account's own `gilbert/knowledge` folder, or null when it has none yet.
 *
 * This reads and never creates: a group's KB is born on first use, exactly as
 * `gilbert/chat` is, and a tier with no folder is a tier with no articles
 * rather than a folder made on the reader's behalf. The company KB's folder is
 * created at boot by the installation, and discovered through the server route
 * below rather than searched for in an account the reader cannot enter.
 */
export async function findKnowledgeFolder(accountId: Id): Promise<Id | null> {
  const app = await findAppFolder(accountId);
  if (!app) return null;
  const found = await findInFolder(accountId, app, KNOWLEDGE_FOLDER);
  return found && found.nodeType === "directory" ? found.id : null;
}

/**
 * The company KB's tree, as the server reads it as the Master (ADR 0024, Q1).
 *
 * The route answers the account the articles live in and their summaries, so
 * the client never searches an account it cannot enter. A route that fails is
 * the caller's to handle; no company KB is an empty answer, not a failure.
 */
export async function companyTree(includeRetired = false): Promise<{
  accountId: Id;
  articles: KnowledgeSummary[];
}> {
  const res = await apiFetch<{
    ok: true;
    accountId: Id;
    articles: KnowledgeSummary[];
  }>(`/api/knowledge/company/tree${includeRetired ? "?retired=1" : ""}`);
  return { accountId: res.accountId, articles: res.articles ?? [] };
}

/**
 * One company KB article, read through the route that acts as the Master.
 *
 * `folder` is the article's folder path within its tier, the value every
 * summary carries. A path the route does not resolve answers null.
 */
export async function companyArticle(
  folder: string,
): Promise<KnowledgeArticleView | null> {
  const res = await apiFetch<{
    ok: true;
    article: KnowledgeArticleView | null;
  }>(`/api/knowledge/company/article?folder=${encodeURIComponent(folder)}`);
  return res.article;
}

/** Read and validate a named document node, or null when it is not one. */
async function readDocument<T>(
  accountId: Id,
  node: FileNode | undefined,
  validate: (x: unknown) => x is T,
): Promise<T | null> {
  if (!node?.blobId) return null;
  try {
    const doc = await readJsonNode(accountId, node.blobId);
    return validate(doc) ? doc : null;
  } catch {
    // A blob that will not read is a document the caller does not hold; the
    // listing still names the folder, which is the honest half of the answer.
    return null;
  }
}

/** The node for a named file in a listing, or undefined. */
function fileNode(list: FileNode[], name: string): FileNode | undefined {
  return list.find((n) => n.nodeType === "file" && n.name === name);
}

/** The `revisions` child of an article folder, or undefined. */
function revisionsNode(list: FileNode[]): FileNode | undefined {
  return list.find((n) => n.nodeType === "directory" && n.name === REVISIONS_FOLDER);
}

/** The child nodes of a listing — every directory but the reserved child. */
function childFolders(list: FileNode[]): FileNode[] {
  return list.filter((n) => n.nodeType === "directory" && n.name !== REVISIONS_FOLDER);
}

/** A folder's position among its siblings, from its `folder.json`; absent is 0. */
async function folderOrder(accountId: Id, node: FileNode | undefined): Promise<number> {
  const doc = await readDocument(accountId, node, isKnowledgeFolderDoc);
  return doc?.order ?? 0;
}

/**
 * One tree node and everything under it, flattened depth-first.
 *
 * A folder is an article only when it carries a `state.json` or a `draft.json`;
 * an article is a leaf and is not recursed into (`revisions/` is its one child
 * and is reserved). A directory holding neither document is a **topic folder**:
 * a group of siblings whose title is its name, whose position comes from its
 * `folder.json`, and which is recursed into. A folder with a readable state
 * still lists even when the state cannot be read — its title is its name and it
 * carries no metadata — and `saved` says whether a draft is there.
 *
 * Siblings are emitted in `order` then `title` order: the children are
 * summarised first, so their summaries carry the order this node sorts by.
 */
async function summarizeArticle(
  accountId: Id,
  node: FileNode,
  parentId: Id | null,
  path: string,
  includeRetired: boolean,
): Promise<KnowledgeSummary[]> {
  const { list } = await listChildrenWithState(accountId, node.id, ARTICLE_PROPS);
  const draftNode = fileNode(list, DRAFT_FILE);
  const stateNode = fileNode(list, STATE_FILE);

  if (!draftNode && !stateNode) {
    const summary = knowledgeSummary({
      state: null,
      draft: null,
      folder: path,
      nodeId: node.id,
      parentId,
      folderOrder: await folderOrder(accountId, fileNode(list, KNOWLEDGE_FOLDER_FILE)),
      saved: false,
    });
    const descendants = await summarizeChildren(
      accountId,
      list,
      node.id,
      path,
      includeRetired,
    );
    return [summary, ...descendants];
  }

  const state = await readDocument(accountId, stateNode, isKnowledgeState);
  // A retired article is withdrawn from the tree but kept for traceability: it
  // is shown only where a caller asks for it. An article is a leaf, so this
  // branch does not recurse into the article's children.
  if (state && isRetired(state) && !includeRetired) return [];
  const draft = await readDocument(accountId, draftNode, isKnowledgeDraft);
  return [
    knowledgeSummary({
      state,
      draft,
      folder: path,
      nodeId: node.id,
      parentId,
      saved: Boolean(draftNode?.blobId),
    }),
  ];
}

/**
 * The children of one listing, each with its own subtree, in sibling order.
 *
 * A child is summarised first — an article into one leaf, a folder into itself
 * and its descendants — and the groups are sorted by the child's own summary,
 * which carries the `order` this listing follows. An empty group is a retired
 * article kept out of the listing, and contributes nothing.
 */
async function summarizeChildren(
  accountId: Id,
  list: FileNode[],
  parentId: Id | null,
  basePath: string,
  includeRetired: boolean,
): Promise<KnowledgeSummary[]> {
  const subtrees: Array<{ head: KnowledgeSummary; rest: KnowledgeSummary[] }> = [];
  for (const child of childFolders(list)) {
    const path = basePath ? `${basePath}/${child.name}` : child.name;
    const flat = await summarizeArticle(accountId, child, parentId, path, includeRetired);
    const head = flat[0];
    if (!head) continue;
    subtrees.push({ head, rest: flat.slice(1) });
  }
  subtrees.sort((a, b) => compareKnowledgeSiblings(a.head, b.head));
  return subtrees.flatMap((s) => [s.head, ...s.rest]);
}

/**
 * Every node under a tier's `knowledge` folder, flat and in sibling order.
 *
 * The tree is the FileNode tree — a folder whose children are its siblings,
 * with articles as the leaves — so one listing carries the titles without
 * reading a blob, and each folder is read once for its `state.json` or
 * `folder.json` as the walk reaches it. Every node is returned in one flat
 * array and the parent is named on the summary (`parentId`), which is what lets
 * a surface rebuild the tree however it draws it.
 */
export async function listArticles(
  accountId: Id,
  folderId: Id,
  includeRetired = false,
): Promise<KnowledgeSummary[]> {
  const { list } = await listChildrenWithState(accountId, folderId, ARTICLE_PROPS);
  return summarizeChildren(accountId, list, null, "", includeRetired);
}

/**
 * The article's parent article node, or null when it hangs directly under the
 * tier's `knowledge` folder.
 *
 * The parent is the folder node's own `parentId` unless that is the tier root
 * itself, which the summary calls null: the tier is the surface, not an
 * article. The root is told from an article by the shared folder name — the
 * one marker there is.
 */
async function parentArticleId(accountId: Id, nodeId: Id): Promise<Id | null> {
  try {
    const got = await client.call<GetResponse<FileNode>>("FileNode/get", {
      accountId,
      ids: [nodeId],
      properties: ["id", "parentId"],
    });
    const parent = got.list[0]?.parentId ?? null;
    if (!parent) return null;
    const pg = await client.call<GetResponse<FileNode>>("FileNode/get", {
      accountId,
      ids: [parent],
      properties: ["id", "name"],
    });
    const pnode = pg.list[0];
    return pnode && pnode.name !== KNOWLEDGE_FOLDER ? parent : null;
  } catch {
    return null;
  }
}

/**
 * One article opened: its summary, its draft, the revision in force and the
 * history, newest first.
 *
 * `folderId` is the article folder whose children are read; `nodeId` is the
 * same FileNode id, recorded on the summary. `scope` and `parentId` are the two
 * facts a listing holds and a bare folder read cannot recover, so a caller that
 * has them passes them and one that does not leaves them to be resolved here —
 * the scope defaults to the company tier and the parent is looked up.
 */
export async function readArticle(
  accountId: Id,
  folderId: Id,
  nodeId: Id,
  folder: string,
  scope: KnowledgeScope = "company",
  parentId?: Id | null,
): Promise<KnowledgeArticleView | null> {
  const { list } = await listChildrenWithState(accountId, folderId, ARTICLE_PROPS);
  const draftNode = fileNode(list, DRAFT_FILE);
  const stateNode = fileNode(list, STATE_FILE);
  // An article carries one of its two documents; a directory with neither is a
  // topic folder, so neither document is read and the title is the folder name.
  const isFolder = !draftNode && !stateNode;
  const draft = isFolder
    ? null
    : await readDocument(accountId, draftNode, isKnowledgeDraft);
  const state = isFolder
    ? null
    : await readDocument(accountId, stateNode, isKnowledgeState);

  const revisions: KnowledgeRevision[] = [];
  const revDir = revisionsNode(list);
  if (revDir) {
    const rev = await listChildrenWithState(accountId, revDir.id, ARTICLE_PROPS);
    for (const node of rev.list) {
      if (node.nodeType !== "file" || !node.name.endsWith(".json")) continue;
      const revision = await readDocument(accountId, node, isKnowledgeRevision);
      if (revision) revisions.push(revision);
    }
  }
  revisions.sort(compareRevisionsNewestFirst);

  // The revision a reader sees now: the one the lifecycle names, matched to its
  // full document in the history. A state naming a revision that is not there
  // (it was pruned) leaves nothing rather than a half-view.
  let effective: KnowledgeRevision | null = null;
  if (state) {
    const issued = revisionInForceAt(state);
    if (issued) effective = revisions.find((r) => r.revision === issued.revision) ?? null;
  }

  const resolvedParent =
    parentId === undefined ? await parentArticleId(accountId, folderId) : parentId;
  const summary = knowledgeSummary({
    state,
    draft,
    folder,
    nodeId,
    parentId: resolvedParent,
    folderOrder: isFolder
      ? await folderOrder(accountId, fileNode(list, KNOWLEDGE_FOLDER_FILE))
      : undefined,
    saved: Boolean(draftNode?.blobId),
  });

  return {
    scope,
    accountId,
    summary,
    draft,
    effective,
    revisions: revisions.map(revisionSummary),
  };
}

/* ------------------------------------------------------------------ */
/* Writes — the server acts as the Master (ADR 0024, Q1)               */
/* ------------------------------------------------------------------ */

/** The summary the server echoes after a write; the route always answers one. */
interface Written {
  ok: true;
  summary: KnowledgeSummary;
}

/** Create an article folder, optionally under a parent article's folder name. */
export async function createArticle(
  target: KnowledgeTarget,
  title: string,
  parentFolder: string | null,
): Promise<KnowledgeSummary> {
  const res = await apiFetch<Written>("/api/knowledge/create", {
    method: "POST",
    body: JSON.stringify({ ...target, title, parentFolder }),
  });
  return res.summary;
}

/** Create a topic folder, optionally under a parent folder's path. */
export async function createKnowledgeFolder(
  target: KnowledgeTarget,
  name: string,
  parentFolder: string | null,
): Promise<KnowledgeSummary> {
  const res = await apiFetch<Written>("/api/knowledge/folder", {
    method: "POST",
    body: JSON.stringify({ ...target, name, parentFolder }),
  });
  return res.summary;
}

/** Set a node's position among its siblings; the free `order` is the whole of it. */
export async function reorderKnowledgeArticle(
  target: KnowledgeTarget,
  folder: string,
  order: number,
): Promise<KnowledgeSummary> {
  const res = await apiFetch<Written>("/api/knowledge/reorder", {
    method: "POST",
    body: JSON.stringify({ ...target, folder, order }),
  });
  return res.summary;
}

/**
 * Set several siblings' places in one request.
 *
 * Used when a drop's fractional order has run out of precision: the whole
 * family is renumbered and its new places travel together rather than one
 * request per row (ADR 0024). The server applies each with its own
 * compare-and-set, so the numbers stay independent and a write that loses a
 * race leaves the rest as they were sent.
 */
export async function reorderKnowledgeArticles(
  target: KnowledgeTarget,
  orders: Array<{ folder: string; order: number }>,
): Promise<void> {
  await apiFetch<{ ok: true }>("/api/knowledge/reorder", {
    method: "POST",
    body: JSON.stringify({ ...target, orders }),
  });
}

/**
 * What a before/after drop does, from the family it lands in.
 *
 * The ordinary drop takes the midpoint of its neighbours and writes one number.
 * When that number is one a sibling already carries, the fractional gap has run
 * out of precision: the family is renumbered `1..N` in the order the drop
 * leaves it, and every changed place travels in one request.
 */
export type SiblingDrop =
  | { kind: "order"; folder: string; order: number }
  | { kind: "renumber"; orders: Array<{ folder: string; order: number }> };

export function siblingDropPlan(
  siblings: KnowledgeSummary[],
  movedNodeId: string,
  targetNodeId: string,
  mode: "before" | "after",
): SiblingDrop | null {
  const rest = siblings.filter((s) => s.nodeId !== movedNodeId);
  const moved = siblings.find((s) => s.nodeId === movedNodeId);
  const at = rest.findIndex((s) => s.nodeId === targetNodeId);
  if (!moved || at < 0) return null;
  const prev = mode === "before" ? rest[at - 1] : rest[at];
  const next = mode === "before" ? rest[at] : rest[at + 1];
  const order = orderBetween(prev?.order ?? null, next?.order ?? null);
  if (!siblings.some((s) => s.order === order))
    return { kind: "order", folder: moved.folder, order };
  const ordered = [...rest];
  ordered.splice(mode === "before" ? at : at + 1, 0, moved);
  return {
    kind: "renumber",
    orders: ordered
      .map((s, index) => ({ folder: s.folder, order: index + 1, was: s.order }))
      .filter((place) => place.was !== place.order)
      .map(({ folder, order }) => ({ folder, order })),
  };
}

/** Move a node under another folder, or back to the tier root when null. */
export async function moveKnowledgeArticle(
  target: KnowledgeTarget,
  folder: string,
  parentFolder: string | null,
): Promise<KnowledgeSummary> {
  const res = await apiFetch<Written>("/api/knowledge/move", {
    method: "POST",
    body: JSON.stringify({ ...target, folder, parentFolder }),
  });
  return res.summary;
}

/** Write the one shared draft of an article. */
export async function saveDraft(
  target: KnowledgeTarget,
  input: KnowledgeArticleInput,
): Promise<KnowledgeSummary> {
  const res = await apiFetch<Written>("/api/knowledge/save", {
    method: "POST",
    body: JSON.stringify({ ...target, input }),
  });
  return res.summary;
}

/** Rename an article — its folder name follows its title. */
export async function renameArticle(
  target: KnowledgeTarget,
  title: string,
): Promise<KnowledgeSummary> {
  const res = await apiFetch<Written>("/api/knowledge/rename", {
    method: "POST",
    body: JSON.stringify({ ...target, title }),
  });
  return res.summary;
}

/** Restore a superseded revision into a new draft — history is never edited. */
export async function restoreArticle(
  target: KnowledgeTarget,
  revision: string,
): Promise<KnowledgeSummary> {
  const res = await apiFetch<Written>("/api/knowledge/restore", {
    method: "POST",
    body: JSON.stringify({ ...target, revision }),
  });
  return res.summary;
}

/** Approve the draft as a revision taking effect at `effectiveAt`. */
export async function approveArticle(
  target: KnowledgeTarget,
  effectiveAt: string,
): Promise<KnowledgeSummary> {
  const res = await apiFetch<Written>("/api/knowledge/approve", {
    method: "POST",
    body: JSON.stringify({ ...target, effectiveAt }),
  });
  return res.summary;
}

/** Retire an approved article (or remove an unapproved one), as the route decides. */
export async function deleteArticle(
  target: KnowledgeTarget,
): Promise<{ retired: boolean }> {
  const res = await apiFetch<{ ok: true; retired: boolean }>("/api/knowledge/delete", {
    method: "POST",
    body: JSON.stringify({ ...target }),
  });
  return { retired: res.retired === true };
}

/**
 * The key both the store and the surface name an article by: an id means
 * nothing outside the account that holds it, so the account is part of it.
 */
export function articleKey(accountId: Id, nodeId: Id): string {
  return `${accountId}:${nodeId}`;
}
