/**
 * The knowledge base's Master-owned write door (ADR 0024).
 *
 * The KB is a tree of articles under `gilbert/knowledge` in an account's own
 * app folder: the company's in the Master's account, a group's in the group's.
 * Every **write** goes through this module, which acts as the Master — the
 * installation's agent credential, or impersonation from the caller's session —
 * because a reader's own session holds nothing of the Master's account. The
 * company KB is **read** through the same door, as a server route: a `shareWith`
 * cannot name every account (Stalwart caps a share at 10 principals per item),
 * so the route, and not a share, is how every account reaches the folder. A
 * group's KB is read with the member's own session (membership is the grant)
 * and written here so that both tiers share one lifecycle, one shape and one
 * approval gate.
 *
 * The durable shape, the validators and the lifecycle arithmetic live in
 * `@gilbert/shared/knowledge`; this module only resolves which account and
 * folder an article lives in and applies the editors and revisions to it.
 *
 * Approval is an administrator's alone (Q8): the routes gate it with
 * `requireAdmin` and this door takes the approver and the instant from the
 * authenticated session, never from the request.
 */

import { memberGroupAccess } from "./agentAdmin.js";
import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  downloadBlobText,
  ensureFolderPath,
  FILENODE_CAP,
  fileChildren,
  filesAccountId,
  findFolderPath,
  readAppJsonAt,
  writeAppFileIn,
} from "./appFolder.js";
import {
  agentSession,
  groupAccountId,
  IdentityAdminError,
  ownIdentityAccount,
  refusalOf,
} from "./identityAdmin.js";
import { isStateMismatch, JmapClient } from "./jmap.js";
import type { LiveSession } from "./sessions.js";
import { FILE_PROPS, FOLDER_PROPS } from "./shared/appFolder.js";
import {
  blocksHaveChecklist,
  buildDraft,
  buildFolderDoc,
  buildRevision,
  buildState,
  compareKnowledgeSiblings,
  compareRevisionsNewestFirst,
  DRAFT_FILE,
  isKnowledgeDraft,
  isKnowledgeFolderDoc,
  isKnowledgeRevision,
  isKnowledgeState,
  isReservedArticleName,
  isRetired,
  KNOWLEDGE_FOLDER,
  KNOWLEDGE_FOLDER_FILE,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeDraft,
  type KnowledgeIssued,
  type KnowledgeRevision,
  type KnowledgeScope,
  type KnowledgeState,
  type KnowledgeSummary,
  type KnowledgeTarget,
  knowledgeFolderName,
  knowledgeId,
  knowledgeSummary,
  MAX_TITLE,
  REVISIONS_FOLDER,
  revisionFileName,
  revisionInForceAt,
  revisionSummary,
  STATE_FILE,
  stateAfterApproval,
} from "./shared/knowledge.js";

/** A refusal a KB caller will read: a code, and the sentence to show. */
export class KnowledgeAdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "KnowledgeAdminError";
  }
}

/**
 * The last order a create minted.
 *
 * A create lands last among its siblings; the clock alone hands two creates in
 * the same millisecond the same number, which leaves their order to the node
 * id. Kept strictly above the clock, so a create always follows the one before
 * it.
 */
let lastCreateOrder = 0;

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
async function knowledgeFolder(ctx: Ctx, accountId: string): Promise<string> {
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
 * The Master's own session for a KB write, or a KB refusal.
 *
 * `agentSession` raises `IdentityAdminError`; it is translated here so the
 * routes have one error shape to map and a caller reads a code that names the
 * KB's own state rather than Global contacts' message.
 */
async function masterSession(admin: LiveSession): Promise<Ctx> {
  try {
    return await agentSession(admin);
  } catch (err) {
    if (err instanceof IdentityAdminError)
      throw new KnowledgeAdminError(
        err.code,
        err.code === "agent_not_configured"
          ? "This deployment names no agent, so the knowledge base cannot be reached."
          : `The installation's agent could not be used for the knowledge base: ${err.message}`,
        err.status,
      );
    throw err;
  }
}

/** The company tier: the Master's own account and its KB folder. */
export async function companyKnowledgeAccount(
  admin: LiveSession,
): Promise<{ ctx: Ctx; accountId: string; folderId: string }> {
  const ctx = await masterSession(admin);
  const accountId = filesAccountId(ctx) || ownIdentityAccount(ctx);
  if (!accountId)
    throw new KnowledgeAdminError(
      "no_knowledge_account",
      "The Master's own account could not be read, so the company knowledge base cannot be reached.",
      409,
    );
  // Readers reach the folder through the route this door serves, not a share,
  // so making the folder is all this resolves.
  const folderId = await knowledgeFolder(ctx, accountId);
  return { ctx, accountId, folderId };
}

/**
 * The group tier: membership is checked against the caller's **own** session
 * first, then the group's KB is written as the Master.
 *
 * The membership read is the member door's own (`memberGroupAccess`), forced
 * live so a member removed from the group loses access at once. A refusal
 * keeps the denial's code and answers 403. Only then is the Master's session
 * opened; the group must be in it too, or the agent lacks the grant and nothing
 * can be written.
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
  const ctx = await masterSession(admin);
  const accountId = groupAccountId(ctx, group);
  if (!accountId)
    throw new KnowledgeAdminError(
      "group_not_granted",
      `The installation's agent is not a member of ${group.trim() || group}, so its knowledge base cannot be written.`,
      409,
    );
  // The group's KB is reached by membership, never a share (`gilbert-groups`);
  // only the folder is made, on first use.
  const folderId = await knowledgeFolder(ctx, accountId);
  return { ctx, accountId, folderId };
}

/** Which tier a target names, with the account and KB folder resolved. */
async function tierAccount(
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
 * is the session's own personal account, a group's is a non-personal one the
 * Master holds (ADR 0024's two tiers). `readArticle` therefore derives it the
 * same way `groupKnowledgeAccount` finds the group.
 */
function scopeOfAccount(ctx: Ctx, accountId: string): KnowledgeScope {
  const account = ctx.session.accounts?.[accountId] as
    | { isPersonal?: unknown }
    | undefined;
  return account?.isPersonal === false ? "group" : "company";
}

/* ------------------------------------------------------------------ */
/* Resolving one article                                               */
/* ------------------------------------------------------------------ */

/** An article folder as the tier root sees it. */
interface ArticleFolder {
  /** The article folder's FileNode id. */
  nodeId: string;
  /** The folder this one sits inside, or null directly under the tier root. */
  parentId: string | null;
  /** The tier-relative folder path, e.g. `"Policies/Returns"`. */
  folder: string;
}

function folderSegments(folder: string): string[] {
  return folder
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Walk `tierFolderId` down the article path, or null when a segment is
 * missing. The walk is by listing, because `FileNode/query` cannot filter by
 * name (`gilbert-stalwart`).
 */
async function findArticleFolder(
  ctx: Ctx,
  accountId: string,
  tierFolderId: string,
  folder: string,
): Promise<ArticleFolder | null> {
  const segments = folderSegments(folder);
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
async function resolveArticleFolder(
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
async function resolveParentFolder(
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
async function articleTarget(
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
function articlePathOf(article: ArticleFolder): string {
  return `${KNOWLEDGE_FOLDER}/${article.folder}`;
}

/** The human title a document stores: trimmed, bounded, never empty. */
function titleFor(value: unknown): string {
  const text = String(value ?? "")
    .trim()
    .slice(0, MAX_TITLE);
  return text || "Untitled";
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function asState(raw: unknown): KnowledgeState | null {
  return isKnowledgeState(raw) ? raw : null;
}

function asDraft(raw: unknown): KnowledgeDraft | null {
  return isKnowledgeDraft(raw) ? raw : null;
}

/**
 * A topic folder's order, read from its `folder.json` (0 when absent).
 *
 * The document and its shape are `@gilbert/shared/knowledge`'s rule; this is
 * only its read path, so the server and the client agree on what a folder's
 * place is.
 */
async function folderOrder(ctx: Ctx, accountId: string, folder: string): Promise<number> {
  const doc = await readAppJsonAt(
    ctx,
    accountId,
    `${KNOWLEDGE_FOLDER}/${folder}/${KNOWLEDGE_FOLDER_FILE}`,
  );
  return isKnowledgeFolderDoc(doc) ? doc.order : 0;
}

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
async function listArticlesUnder(
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
      await readAppJsonAt(ctx, accountId, `${KNOWLEDGE_FOLDER}/${folder}/${STATE_FILE}`),
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
        await readAppJsonAt(
          ctx,
          accountId,
          `${KNOWLEDGE_FOLDER}/${folder}/${STATE_FILE}`,
        ),
      );
      if (state?.id === id) return { nodeId: childId, parentId, folder };
      const nested = await walk(childId, folder, childId);
      if (nested) return nested;
    }
    return null;
  };
  return walk(tierFolderId, "", null);
}

/** Read every readable revision of an article, newest first by approval. */
async function readRevisions(
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
  const files = await fileChildren(ctx, accountId, revisionsFolder, FILE_PROPS);
  const out: KnowledgeRevision[] = [];
  for (const file of files) {
    if (file.nodeType !== "file" || typeof file.blobId !== "string") continue;
    const name = typeof file.name === "string" ? file.name : "revision.json";
    const type =
      typeof file.type === "string" && file.type ? file.type : "application/json";
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

/**
 * Open one article, or null when the folder is not there.
 *
 * `folderId` is the tier root the path is resolved against; `folder` is the
 * tier-relative path (the shape `KnowledgeSummary.folder` carries), so a
 * sub-article is `"Parent/Child"`. The `effective` revision is the one the
 * lifecycle names at now, read from the immutable revision files.
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
    ? (revisions.find((revision) => revision.revision === issued.revision) ?? null)
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

/* ------------------------------------------------------------------ */
/* Editors                                                             */
/* ------------------------------------------------------------------ */

/**
 * Create one article, never overwriting an existing one.
 *
 * The folder is the title's file name (`knowledgeFolderName`); a title whose
 * folder an article already holds gets a numbered sibling, because a create is
 * a create and not a way to replace a controlled document.
 */
export async function createArticle(
  admin: LiveSession,
  target: KnowledgeTarget,
  title: string,
  parentFolder: string | null,
): Promise<KnowledgeSummary> {
  const { ctx, accountId, folderId: tierFolderId } = await tierAccount(admin, target);
  const clean = (title ?? "").trim();
  const docTitle = titleFor(clean);
  const wantedName = knowledgeFolderName(clean);
  if (isReservedArticleName(wantedName))
    throw new KnowledgeAdminError(
      "reserved_title",
      `"${wantedName}" is reserved for an article's revision store; choose another title.`,
      400,
    );
  const parent = await resolveParentFolder(ctx, accountId, tierFolderId, parentFolder);
  const parentPath = parent ? `${KNOWLEDGE_FOLDER}/${parent.folder}` : KNOWLEDGE_FOLDER;
  // A create never lands on an existing directory — an article or a topic
  // folder. One helper answers both, so the two creators cannot disagree.
  const name = await freeChildFolderName(
    ctx,
    accountId,
    parent ? parent.nodeId : tierFolderId,
    wantedName,
  );
  const nodeId = await ensureFolderPath(ctx, accountId, `${parentPath}/${name}`);
  const id = knowledgeId();
  const now = new Date().toISOString();
  const by = admin.username;
  const draft = buildDraft({
    id,
    title: docTitle,
    tags: [],
    blocks: [],
    text: "",
    by,
    at: now,
  });
  // A fresh article lands last among its siblings, by a number the clock mints
  // and the counter keeps strictly increasing; a drag writes its own over this.
  lastCreateOrder = Math.max(Date.now(), lastCreateOrder + 1);
  const state = buildState({
    id,
    title: docTitle,
    tags: [],
    by,
    at: now,
    order: lastCreateOrder,
  });
  await writeAppFileIn(ctx, accountId, nodeId, DRAFT_FILE, draft);
  await writeAppFileIn(ctx, accountId, nodeId, STATE_FILE, state);
  return knowledgeSummary({
    state,
    draft,
    folder: parent ? `${parent.folder}/${name}` : name,
    nodeId,
    parentId: parent?.nodeId ?? null,
    saved: true,
  });
}

/**
 * A directory name under `parentId` no directory already holds.
 *
 * A topic folder is pure grouping, so a create must not land on a folder that
 * is already there — an article above all, whose `state.json` beside a new
 * `folder.json` would mispresent it as a topic folder. A name in use gets
 * ` (2)`, ` (3)` and so on, exactly as an article create does.
 */
async function freeChildFolderName(
  ctx: Ctx,
  accountId: string,
  parentId: string,
  base: string,
): Promise<string> {
  const children = await fileChildren(ctx, accountId, parentId, FOLDER_PROPS);
  const taken = new Set(
    children
      .filter((node) => node.nodeType === "directory" && typeof node.name === "string")
      .map((node) => String(node.name)),
  );
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new KnowledgeAdminError(
    "folder_name_taken",
    `That folder already holds a thousand folders named "${base}".`,
    409,
  );
}

/**
 * Create one topic folder, never overwriting an article.
 *
 * A topic folder is a directory with no `state.json` that groups articles and
 * other folders, with no content of its own (`folder.json` is only its place
 * among its siblings). The folder is the name's file name
 * (`knowledgeFolderName`); a name a directory under the parent already holds
 * gets a numbered sibling, so a create never lands on an existing article or
 * folder.
 */
export async function createFolder(
  admin: LiveSession,
  target: KnowledgeTarget,
  name: string,
  parentFolder: string | null,
): Promise<KnowledgeSummary> {
  const { ctx, accountId, folderId: tierFolderId } = await tierAccount(admin, target);
  const clean = (name ?? "").trim();
  const wantedName = knowledgeFolderName(clean);
  if (isReservedArticleName(wantedName))
    throw new KnowledgeAdminError(
      "reserved_title",
      `"${wantedName}" is reserved for an article's revision store; choose another name.`,
      400,
    );
  const parent = await resolveParentFolder(ctx, accountId, tierFolderId, parentFolder);
  const parentPath = parent ? `${KNOWLEDGE_FOLDER}/${parent.folder}` : KNOWLEDGE_FOLDER;
  const parentNodeId = parent ? parent.nodeId : tierFolderId;
  const folderName = await freeChildFolderName(ctx, accountId, parentNodeId, wantedName);
  const nodeId = await ensureFolderPath(ctx, accountId, `${parentPath}/${folderName}`);
  // A fresh node lands last among its siblings, by the same strictly-increasing
  // counter an article create uses: the clock alone collides in one millisecond,
  // and two folders would then fall back to title order.
  lastCreateOrder = Math.max(Date.now(), lastCreateOrder + 1);
  const order = lastCreateOrder;
  await writeAppFileIn(
    ctx,
    accountId,
    nodeId,
    KNOWLEDGE_FOLDER_FILE,
    buildFolderDoc(order),
  );
  return knowledgeSummary({
    state: null,
    draft: null,
    folder: parent ? `${parent.folder}/${folderName}` : folderName,
    nodeId,
    parentId: parent ? parent.nodeId : null,
    saved: false,
    folderOrder: order,
  });
}

/**
 * Save the one shared draft and its title/tags, under a compare-and-set.
 *
 * The order is the whole of it (`writeAssignmentDoc` in `identityAdmin.ts`):
 * ensure the folder first, read the account's FileNode state, then read the
 * document, then write conditionally. A lost race is retried once, and the
 * draft's `id` and `created` are the article's, never the save's.
 */
export async function saveDraft(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
  input: KnowledgeArticleInput,
): Promise<KnowledgeSummary> {
  const { ctx, accountId, article } = await articleTarget(admin, target, folder);
  const articlePath = articlePathOf(article);
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureFolderPath(ctx, accountId, articlePath);
    const state = await appFolderState(ctx, accountId);
    const existingDraft = asDraft(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
    );
    const existingState = asState(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    );
    const now = new Date().toISOString();
    const by = admin.username;
    const id = existingDraft?.id ?? existingState?.id ?? knowledgeId();
    const created = existingDraft?.created ?? existingState?.created ?? { by, at: now };
    // A retired article is kept on record and read-only: editing it would
    // silently revive a procedure somebody withdrew.
    if (existingState?.retired)
      throw new KnowledgeAdminError(
        "article_retired",
        "That article is retired and is kept on record, so it is not edited.",
        409,
      );
    // The builders mint the fields this version owns; merging over what was
    // read carries any field a later version added through untouched, and the
    // lifecycle pointers (which this save does not change) with them.
    const draft: KnowledgeDraft = {
      ...(existingDraft ?? {}),
      ...buildDraft({
        id,
        title: titleFor(input.title),
        tags: input.tags,
        blocks: input.blocks,
        text: input.text,
        by,
        at: now,
        created,
      }),
    };
    // The tree shows what a reader sees: the in-force revision's title and tags.
    // A draft (or a pending revision not yet due) must not leak its title into
    // the listing while the body still shows the issued revision.
    const listingTitle = existingState?.inForce ? existingState.title : draft.title;
    const listingTags = existingState?.inForce ? existingState.tags : draft.tags;
    const nextState: KnowledgeState = {
      ...(existingState ?? {}),
      ...buildState({
        id,
        title: listingTitle,
        tags: listingTags,
        by,
        at: now,
        created,
        inForce: existingState?.inForce ?? null,
        pending: existingState?.pending ?? null,
        retired: existingState?.retired ?? null,
        // The position is the tier's, not the save's: spelled back so the
        // builder's default does not send the article to the top.
        order: existingState?.order ?? 0,
        // The body decides whether the page is a checklist template: any
        // `checkListItem` block makes it one, and removing them makes it an
        // ordinary page again (ADR 0028).
        template: blocksHaveChecklist(input.blocks) ? "checklist" : null,
      }),
    };
    try {
      await writeAppFileIn(ctx, accountId, article.nodeId, DRAFT_FILE, draft, {
        ifInState: state || undefined,
      });
      // The draft write advanced the account's state, so the second write is
      // conditioned on a fresh token rather than the one the read used.
      const after = await appFolderState(ctx, accountId);
      await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, nextState, {
        ifInState: after || undefined,
      });
      return knowledgeSummary({
        state: nextState,
        draft,
        folder: article.folder,
        nodeId: article.nodeId,
        parentId: article.parentId,
        saved: true,
      });
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
  throw new KnowledgeAdminError(
    "knowledge_save_failed",
    "The article could not be saved because another write kept winning the race.",
    502,
  );
}

/**
 * Approve the draft: mint an immutable revision and point the lifecycle at it.
 *
 * `effectiveAt` is the administrator's statement of when the revision takes
 * force: a date already passed puts it in force at once, a future one leaves it
 * pending beside the revision still in force (`stateAfterApproval`). The
 * approver and the approval instant come from the authenticated session, never
 * from the request (ADR 0024, Q8).
 */
export async function approveArticle(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
  effectiveAt: string,
): Promise<KnowledgeSummary> {
  const when = (effectiveAt ?? "").trim();
  if (!when || Number.isNaN(Date.parse(when)))
    throw new KnowledgeAdminError(
      "invalid_effective_instant",
      "An approval needs the instant the revision takes effect.",
    );
  const { ctx, accountId, article } = await articleTarget(admin, target, folder);
  const articlePath = articlePathOf(article);
  const draft = asDraft(
    await readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
  );
  if (!draft)
    throw new KnowledgeAdminError(
      "draft_missing",
      "That article has no draft to approve.",
      409,
    );
  const existingState = asState(
    await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
  );
  if (existingState?.retired)
    throw new KnowledgeAdminError(
      "article_retired",
      "That article is retired and kept on record, so it is not approved.",
      409,
    );
  const now = new Date().toISOString();
  const revision = knowledgeId();
  // The article's own revision number, minted here: the highest number any
  // issued revision carried, plus one, so a pending approval that overtakes an
  // in-force one still numbers forward rather than reusing it. The issued
  // revisions are read as well as the state, so a `state.json` that is missing
  // or corrupt while the store still holds revisions resumes after them rather
  // than restarting at one.
  const priorRevisions = await readRevisions(ctx, accountId, articlePath);
  const revNumber =
    Math.max(
      existingState?.inForce?.rev ?? 0,
      existingState?.pending?.rev ?? 0,
      ...priorRevisions.map((r) => r.rev),
    ) + 1;
  const issued: KnowledgeIssued = {
    revision,
    rev: revNumber,
    effectiveAt: when,
    // The administrator's own address, not the Master's: the door writes as the
    // Master, whose username is the installation's agent, and an approval the
    // agent signed would be exactly the separation ADR 0024 exists to keep.
    approvedBy: admin.username,
    approvedAt: now,
    title: draft.title,
    tags: draft.tags,
  };
  const supersedes = existingState
    ? (revisionInForceAt(existingState)?.revision ??
      existingState.pending?.revision ??
      null)
    : null;
  const rev = buildRevision(draft, {
    revision,
    rev: revNumber,
    approvedBy: admin.username,
    approvedAt: now,
    effectiveAt: when,
    supersedes,
  });
  const revisionsFolder = await ensureFolderPath(
    ctx,
    accountId,
    `${articlePath}/${REVISIONS_FOLDER}`,
  );
  await writeAppFileIn(ctx, accountId, revisionsFolder, revisionFileName(revision), rev);
  /*
   * The revision is written first, so the state write is retried on a lost race
   * rather than allowed to fail: a state that never points at the revision it
   * just recorded is an issued document nobody can read.
   */
  let nextState: KnowledgeState | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // The token is read before the state document, as `saveDraft` reads it: a
    // token read after it is still valid while what it would be compared
    // against has already moved. Both are re-read on a retry, so whatever
    // landed between the attempts is the state the approval is applied over.
    const token = await appFolderState(ctx, accountId);
    const current = asState(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    );
    const base =
      current ??
      buildState({
        id: draft.id,
        title: draft.title,
        tags: draft.tags,
        by: ctx.username,
        at: now,
        created: draft.created,
      });
    const after = stateAfterApproval(base, issued, new Date(now));
    // The listing follows the revision now in force: a future-dated approval
    // waits, and the title readers see stays the current one until then.
    const inForceNow = after.inForce?.revision === revision;
    nextState = {
      ...after,
      title: inForceNow ? draft.title : base.title,
      tags: inForceNow ? draft.tags : base.tags,
      updated: { by: admin.username, at: now },
    };
    try {
      await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, nextState, {
        ifInState: token || undefined,
      });
      break;
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
  if (!nextState)
    throw new KnowledgeAdminError(
      "knowledge_approve_failed",
      "The revision was recorded but its state could not be written because another write kept winning the race.",
      502,
    );
  return knowledgeSummary({
    state: nextState,
    draft,
    folder: article.folder,
    nodeId: article.nodeId,
    parentId: article.parentId,
    saved: true,
  });
}

/**
 * Open a new draft from a superseded revision (Q6).
 *
 * History is never edited: the revision file is read and copied into the
 * mutable draft, whose `id` and `created` stay the article's, and an
 * administrator then approves the result like any other draft.
 */
export async function restoreArticle(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
  revision: string,
): Promise<KnowledgeSummary> {
  const { ctx, accountId, article } = await articleTarget(admin, target, folder);
  const articlePath = articlePathOf(article);
  const revisionId = (revision ?? "").trim();
  // The id is a path segment; anything that could climb out of the article
  // folder is refused here rather than relied on to miss.
  if (!revisionId || !/^[A-Za-z0-9_-]+$/.test(revisionId))
    throw new KnowledgeAdminError("bad_request", "A revision id is required.");
  const raw = await readAppJsonAt(
    ctx,
    accountId,
    `${articlePath}/${REVISIONS_FOLDER}/${revisionFileName(revisionId)}`,
  );
  const rev = isKnowledgeRevision(raw) ? raw : null;
  if (!rev)
    throw new KnowledgeAdminError(
      "revision_not_found",
      `The article has no revision "${revisionId}".`,
      404,
    );
  await ensureFolderPath(ctx, accountId, articlePath);
  const by = admin.username;
  for (let attempt = 0; attempt < 2; attempt++) {
    // The token is read before the documents, as `saveDraft` reads it: a token
    // read after them is still valid while the documents it would be compared
    // against have already moved, which is the lost update this guards.
    const token = await appFolderState(ctx, accountId);
    const existingDraft = asDraft(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
    );
    const existingState = asState(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    );
    if (existingState?.retired)
      throw new KnowledgeAdminError(
        "article_retired",
        "That article is retired and kept on record, so it is not restored into a draft.",
        409,
      );
    const now = new Date().toISOString();
    const id = existingDraft?.id ?? existingState?.id ?? rev.id;
    const created = existingDraft?.created ?? existingState?.created ?? rev.created;
    // Merged over what was read, so a field a later document version added is
    // carried through the restore rather than dropped.
    const draft: KnowledgeDraft = {
      ...(existingDraft ?? {}),
      ...buildDraft({
        id,
        title: rev.title,
        tags: rev.tags,
        blocks: rev.blocks,
        text: rev.text,
        by,
        at: now,
        created,
      }),
    };
    const base =
      existingState ??
      buildState({
        id,
        title: rev.title,
        tags: rev.tags,
        by,
        at: now,
        created,
      });
    const nextState: KnowledgeState = {
      ...base,
      id: draft.id,
      // The listing mirrors the in-force revision, as `saveDraft` keeps it: a
      // restored superseded revision changes the draft, never what readers see.
      title: base.inForce ? base.title : draft.title,
      tags: base.inForce ? base.tags : draft.tags,
      updated: { by, at: now },
    };
    try {
      await writeAppFileIn(ctx, accountId, article.nodeId, DRAFT_FILE, draft, {
        ifInState: token || undefined,
      });
      const after = await appFolderState(ctx, accountId);
      await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, nextState, {
        ifInState: after || undefined,
      });
      return knowledgeSummary({
        state: nextState,
        draft,
        folder: article.folder,
        nodeId: article.nodeId,
        parentId: article.parentId,
        saved: true,
      });
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
  throw new KnowledgeAdminError(
    "knowledge_restore_failed",
    "The revision could not be restored because another write kept winning the race.",
    502,
  );
}

/**
 * Rename an article: move its folder and its stored title.
 *
 * A title whose folder a sibling article already holds gets a numbered name,
 * exactly as a create does, and only the folder's `name` moves -- the node id
 * never changes, so the articles inside it and every reference by id are
 * untouched.
 */
export async function renameArticle(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
  title: string,
): Promise<KnowledgeSummary> {
  const { ctx, accountId, folderId, article } = await articleTarget(
    admin,
    target,
    folder,
  );
  const clean = (title ?? "").trim();
  const docTitle = titleFor(clean);
  const wantedName = knowledgeFolderName(clean);
  if (isReservedArticleName(wantedName))
    throw new KnowledgeAdminError(
      "reserved_title",
      `"${wantedName}" is reserved for an article's revision store; choose another title.`,
      400,
    );
  const currentLeaf = article.folder.split("/").pop() ?? article.folder;
  const client = new JmapClient(ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    // The token is read before the documents, so a save landing between them and
    // the writes is refused rather than silently overwritten.
    const token = await appFolderState(ctx, accountId);
    const articlePath = articlePathOf(article);
    const draft = asDraft(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
    );
    const state = asState(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    );
    if (state?.retired)
      throw new KnowledgeAdminError(
        "article_retired",
        "That article is retired and kept on record, so it is not renamed.",
        409,
      );
    let nextFolder = article.folder;
    try {
      if (wantedName !== currentLeaf) {
        // The parent is the article's own parent node, or the tier root: one
        // free-name helper for a rename, an article create and a folder create.
        const parentPath = article.folder.includes("/")
          ? article.folder.slice(0, article.folder.lastIndexOf("/"))
          : "";
        const name = await freeChildFolderName(
          ctx,
          accountId,
          article.parentId ?? folderId,
          wantedName,
        );
        const renamed = await client.call<{
          notUpdated?: Record<string, { type?: unknown; description?: unknown }>;
        }>(
          "FileNode/set",
          {
            accountId,
            ...(token ? { ifInState: token } : {}),
            update: { [article.nodeId]: { name } },
          },
          [FILENODE_CAP],
        );
        const nameRefused = renamed.notUpdated?.[article.nodeId];
        if (nameRefused)
          throw new KnowledgeAdminError(
            "article_name_taken",
            refusalOf(nameRefused) ||
              `The folder name "${name}" collided with another; nothing was renamed.`,
            409,
          );
        nextFolder = parentPath ? `${parentPath}/${name}` : name;
      }
      const now = new Date().toISOString();
      const by = admin.username;
      const nextDraft = draft
        ? { ...draft, title: docTitle, updated: { by, at: now } }
        : null;
      const nextState = state
        ? { ...state, title: docTitle, updated: { by, at: now } }
        : null;
      const after = await appFolderState(ctx, accountId);
      if (nextDraft)
        await writeAppFileIn(ctx, accountId, article.nodeId, DRAFT_FILE, nextDraft, {
          ifInState: after || undefined,
        });
      const after2 = await appFolderState(ctx, accountId);
      if (nextState)
        await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, nextState, {
          ifInState: after2 || undefined,
        });
      return knowledgeSummary({
        state: nextState,
        draft: nextDraft,
        folder: nextFolder,
        nodeId: article.nodeId,
        parentId: article.parentId,
        saved: nextDraft !== null,
      });
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
  throw new KnowledgeAdminError(
    "knowledge_rename_failed",
    "The article could not be renamed because another write kept winning the race.",
    502,
  );
}

/**
 * Set an article's or topic folder's place among its siblings.
 *
 * The order is a free number, so a drag lands between two neighbours without
 * renumbering the rest: an article carries it on its `state.json`, a topic
 * folder on its `folder.json`. The document is read under the compare-and-set
 * token and written back with every other field preserved, retried once, so a
 * save that landed first is carried into the reordered copy.
 */
export async function reorderArticle(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
  order: number,
): Promise<KnowledgeSummary> {
  if (!Number.isFinite(order))
    throw new KnowledgeAdminError("bad_request", "An order must be a number.");
  const { ctx, accountId, article } = await articleTarget(admin, target, folder);
  const articlePath = articlePathOf(article);
  for (let attempt = 0; attempt < 2; attempt++) {
    // The token is read before the documents, as `saveDraft` reads it: a token
    // read after them is still valid while what it would be compared against
    // has already moved.
    const token = await appFolderState(ctx, accountId);
    const state = asState(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    );
    try {
      if (state) {
        const next: KnowledgeState = {
          ...state,
          order,
          updated: { by: admin.username, at: new Date().toISOString() },
        };
        await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, next, {
          ifInState: token || undefined,
        });
        return knowledgeSummary({
          state: next,
          draft: null,
          folder: article.folder,
          nodeId: article.nodeId,
          parentId: article.parentId,
          saved: true,
        });
      }
      const read = await readAppJsonAt(
        ctx,
        accountId,
        `${articlePath}/${KNOWLEDGE_FOLDER_FILE}`,
      );
      // Merged over what was read, so a field a later document version added is
      // carried through the reorder rather than dropped.
      const nextDoc = {
        ...(isKnowledgeFolderDoc(read) ? read : buildFolderDoc(order)),
        order,
      };
      await writeAppFileIn(
        ctx,
        accountId,
        article.nodeId,
        KNOWLEDGE_FOLDER_FILE,
        nextDoc,
        { ifInState: token || undefined },
      );
      return knowledgeSummary({
        state: null,
        draft: null,
        folder: article.folder,
        nodeId: article.nodeId,
        parentId: article.parentId,
        saved: false,
        folderOrder: order,
      });
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
  throw new KnowledgeAdminError(
    "knowledge_reorder_failed",
    "The order could not be saved because another write kept winning the race.",
    502,
  );
}

/**
 * Move an article into a topic folder, or back to the tier root.
 *
 * The move is the FileNode's `parentId` alone: the node keeps its id, its
 * draft, its state and every revision, so a reference by id still resolves and
 * a rename is not implied. The destination is a topic folder resolved by path,
 * or the tier root when `parentFolder` is null. A refusal is checked, and the
 * write is conditional on the account state so a save landing first is not
 * silently overwritten.
 */
export async function moveArticle(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
  parentFolder: string | null,
): Promise<KnowledgeSummary> {
  const {
    ctx,
    accountId,
    folderId: tierFolderId,
    article,
  } = await articleTarget(admin, target, folder);
  const parent = await resolveParentFolder(ctx, accountId, tierFolderId, parentFolder);
  // A folder cannot be moved into itself or a descendant: that would make a
  // cycle the tree walk cannot survive.
  if (
    parent &&
    (parent.nodeId === article.nodeId ||
      parent.folder === article.folder ||
      parent.folder.startsWith(`${article.folder}/`))
  )
    throw new KnowledgeAdminError(
      "knowledge_move_cycle",
      "An article cannot be moved into itself or one of its own folders.",
      400,
    );
  const leaf = article.folder.split("/").pop() ?? article.folder;
  const nextFolder = parent ? `${parent.folder}/${leaf}` : leaf;
  // The FileNode sits under the tier's own KB folder at the root; only the
  // summary spells that as a null parent, exactly as the listing does.
  const destNodeId = parent ? parent.nodeId : tierFolderId;
  const destParentId = parent ? parent.nodeId : null;
  const client = new JmapClient(ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await appFolderState(ctx, accountId);
    try {
      const res = await client.call<{
        notUpdated?: Record<string, { type?: unknown; description?: unknown }>;
      }>(
        "FileNode/set",
        {
          accountId,
          ...(token ? { ifInState: token } : {}),
          update: { [article.nodeId]: { parentId: destNodeId } },
        },
        [FILENODE_CAP],
      );
      const refused = res.notUpdated?.[article.nodeId];
      if (refused)
        throw new KnowledgeAdminError(
          "knowledge_move_refused",
          refusalOf(refused) || "The article could not be moved to that folder.",
          409,
        );
      const afterPath = `${KNOWLEDGE_FOLDER}/${nextFolder}`;
      const state = asState(
        await readAppJsonAt(ctx, accountId, `${afterPath}/${STATE_FILE}`),
      );
      const draft = asDraft(
        await readAppJsonAt(ctx, accountId, `${afterPath}/${DRAFT_FILE}`),
      );
      return knowledgeSummary({
        state,
        draft,
        folder: nextFolder,
        nodeId: article.nodeId,
        parentId: destParentId,
        saved: draft !== null,
      });
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
  throw new KnowledgeAdminError(
    "knowledge_move_failed",
    "The article could not be moved because another write kept winning the race.",
    502,
  );
}

/**
 * Whether any article at or under a folder has an issued revision.
 *
 * A topic folder can hold approved articles, and a delete reaches everything
 * under it, so a folder that was never approved can still hold approved
 * articles. Deleting it would take their revisions with it — the exact
 * controlled record the lifecycle keeps — so a destructive delete is refused
 * while any descendant is issued.
 */
async function subtreeHasApproval(
  ctx: Ctx,
  accountId: string,
  articlePath: string,
): Promise<boolean> {
  const folderId = await findFolderPath(ctx, accountId, articlePath);
  if (!folderId) return false;
  const children = await fileChildren(ctx, accountId, folderId, FOLDER_PROPS);
  for (const child of children) {
    if (child.nodeType !== "directory") continue;
    const name = typeof child.name === "string" ? child.name : "";
    if (!name || name === REVISIONS_FOLDER) continue;
    const childPath = `${articlePath}/${name}`;
    const state = asState(
      await readAppJsonAt(ctx, accountId, `${childPath}/${STATE_FILE}`),
    );
    const revisions = await readRevisions(ctx, accountId, childPath);
    if (state?.inForce || state?.pending || revisions.length > 0) return true;
    if (await subtreeHasApproval(ctx, accountId, childPath)) return true;
  }
  return false;
}

/** Retire an approved article, or destroy one that was never approved. */
export async function deleteArticle(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
): Promise<{ retired: boolean }> {
  const { ctx, accountId, article } = await articleTarget(admin, target, folder);
  const articlePath = articlePathOf(article);
  const state = asState(
    await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
  );
  const revisions = await readRevisions(ctx, accountId, articlePath);
  // Traceability: an article something was issued from is never destroyed. One
  // no approval ever touched is a draft nobody depended on, and it goes — but
  // only if nothing under it was issued either.
  const everApproved =
    Boolean(state?.inForce) || Boolean(state?.pending) || revisions.length > 0;
  if (everApproved) {
    await retireArticle(ctx, accountId, article, admin.username);
    return { retired: true };
  }
  if (await subtreeHasApproval(ctx, accountId, articlePath))
    throw new KnowledgeAdminError(
      "article_has_approved_children",
      "That folder holds an approved article, so it is not deleted: retire or move that article first.",
      409,
    );
  await destroyAppNode(ctx, accountId, article.nodeId, { removeChildren: true });
  return { retired: false };
}

/**
 * Withdraw an article from the tree, keeping its folder and its revisions.
 *
 * The marker lives on the lifecycle document, so a listing that does not ask for
 * retired articles skips it without reading a draft, and every revision stays
 * exactly where it was. Re-read inside the compare-and-set loop so a save that
 * landed first is carried into the retired document rather than overwritten.
 */
async function retireArticle(
  ctx: Ctx,
  accountId: string,
  article: ArticleFolder,
  by: string,
): Promise<void> {
  const articlePath = articlePathOf(article);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await appFolderState(ctx, accountId);
    const state = asState(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    );
    if (state?.retired) return;
    const now = new Date().toISOString();
    // A state that is missing while a draft exists: the article's own id and
    // title are the draft's, so retirement neither mints an id a reference
    // already points past nor renames the article to its path.
    const draft = asDraft(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
    );
    const leaf = article.folder.split("/").pop() ?? article.folder;
    const base =
      state ??
      buildState({
        id: draft?.id ?? article.nodeId,
        title: draft?.title ?? leaf,
        tags: draft?.tags ?? [],
        by,
        at: now,
        created: draft?.created,
      });
    const next: KnowledgeState = {
      ...base,
      retired: { by, at: now },
      updated: { by, at: now },
    };
    try {
      await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, next, {
        ifInState: token || undefined,
      });
      return;
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
  throw new KnowledgeAdminError(
    "knowledge_retire_failed",
    "The article could not be retired because another write kept winning the race.",
    502,
  );
}
