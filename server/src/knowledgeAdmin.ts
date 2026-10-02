/**
 * The knowledge base's Master-owned write door (ADR 0024).
 *
 * The KB is a tree of articles under `gilbert/knowledge` in an account's own
 * app folder: the company's in the Master's account, a group's in the group's.
 * Every **write** goes through this module, which acts as the Master — the
 * installation's agent credential, or impersonation from the caller's session —
 * because the company KB is read through a read-only share that grants the
 * caller's own session nothing to write with. A group's KB is read with the
 * member's own session (membership is the grant) and written here so that both
 * tiers share one lifecycle, one shape and one approval gate.
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
  IdentityAdminError,
  ownIdentityAccount,
  refusalOf,
} from "./identityAdmin.js";
import { isStateMismatch, JMAP_PRINCIPALS, JmapClient } from "./jmap.js";
import type { LiveSession } from "./sessions.js";
import { sameAddress } from "./shared/address.js";
import { FILE_PROPS, FOLDER_PROPS } from "./shared/appFolder.js";
import {
  buildDraft,
  buildRevision,
  buildState,
  DRAFT_FILE,
  isKnowledgeDraft,
  isKnowledgeRevision,
  isKnowledgeState,
  isReservedArticleName,
  isRetired,
  KNOWLEDGE_FOLDER,
  type KnowledgeArticleInput,
  type KnowledgeArticleView,
  type KnowledgeDraft,
  type KnowledgeIssued,
  type KnowledgeRevision,
  type KnowledgeRevisionSummary,
  type KnowledgeScope,
  type KnowledgeState,
  type KnowledgeSummary,
  type KnowledgeTarget,
  knowledgeFolderName,
  knowledgeId,
  MAX_TITLE,
  REVISIONS_FOLDER,
  revisionFileName,
  revisionInForceAt,
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

/** How many principals one page of the enumeration asks for. */
const PRINCIPAL_PAGE = 500;

/* ------------------------------------------------------------------ */
/* Where a tier's knowledge base lives                                 */
/* ------------------------------------------------------------------ */

/**
 * Ensure `gilbert/knowledge` exists and share it read-only with every
 * principal.
 *
 * The company KB is the installation's, owned by the Master and read by every
 * account through a read-only share — the ADR 0023 shape Global contacts
 * already uses. The share is re-applied on every door call so an account
 * created since the last one is brought in; an enumeration that names nobody
 * fails loudly, because a knowledge base nobody can read is not a knowledge
 * base.
 */
async function shareWithEveryone(
  ctx: Ctx,
  accountId: string,
  folderId: string,
): Promise<void> {
  const client = new JmapClient(ctx);
  const wanted: Record<string, { mayRead: boolean }> = {};
  for (let position = 0; ; position += PRINCIPAL_PAGE) {
    const page = await client.call<{ ids?: unknown[]; total?: unknown }>(
      "Principal/query",
      { accountId, position, limit: PRINCIPAL_PAGE, calculateTotal: true },
      [JMAP_PRINCIPALS],
    );
    const ids = (page.ids ?? []).filter((id): id is string => typeof id === "string");
    for (const id of ids) if (id !== accountId) wanted[id] = { mayRead: true };
    if (ids.length < PRINCIPAL_PAGE) break;
    if (typeof page.total === "number" && position + ids.length >= page.total) break;
  }
  if (!Object.keys(wanted).length)
    throw new KnowledgeAdminError(
      "knowledge_share",
      "No principal could be enumerated, so the knowledge base could not be shared with anyone.",
      502,
    );

  const current = await client.call<{ list?: Array<{ shareWith?: unknown }> }>(
    "FileNode/get",
    { accountId, ids: [folderId], properties: ["id", "shareWith"] },
    [FILENODE_CAP],
  );
  const existing = (current.list?.[0]?.shareWith ?? {}) as Record<string, unknown>;
  const shareWith = { ...existing, ...wanted };
  const res = await client.call<{ notUpdated?: Record<string, unknown> }>(
    "FileNode/set",
    { accountId, update: { [folderId]: { shareWith } } },
    [FILENODE_CAP, JMAP_PRINCIPALS],
  );
  const refused = res.notUpdated?.[folderId];
  if (refused)
    throw new KnowledgeAdminError(
      "knowledge_share",
      refusalOf(refused as { type?: unknown; description?: unknown }) ||
        "The knowledge base could not be shared.",
      502,
    );
}

/**
 * Ensure the KB folder exists, sharing it only when the tier is the company's.
 *
 * The company KB is installation-wide and reaches every account through the
 * read-only share; a group's KB is reached by membership and is **never**
 * shared, or the group's documents would leak to every principal in the
 * directory (`gilbert-groups`). That is the whole difference between the two
 * tiers at this level, so it is a parameter rather than two folder walks.
 */
async function knowledgeFolder(
  ctx: Ctx,
  accountId: string,
  share: boolean,
): Promise<string> {
  const folderId = await ensureFolderPath(ctx, accountId, KNOWLEDGE_FOLDER);
  if (share) await shareWithEveryone(ctx, accountId, folderId);
  return folderId;
}

/**
 * Make the Master's company knowledge base exist and be shared.
 *
 * Run at boot so the company KB is there for every reader without anyone
 * creating it — a thing the product needs is made to happen, not asked for with
 * a button. Idempotent and safe on every boot. A group's KB is created on first
 * use, as `gilbert/chat` is, and by membership rather than a share.
 */
export async function ensureKnowledge(ctx: Ctx, accountId: string): Promise<void> {
  await knowledgeFolder(ctx, accountId, true);
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
  const folderId = await knowledgeFolder(ctx, accountId, true);
  return { ctx, accountId, folderId };
}

/**
 * A group's own account in a session that holds it: non-personal and carrying
 * the group's address — the same rule `identityAdmin.ts`'s `groupAccountId`
 * applies, so a files share is never read as a group.
 */
function groupAccountId(ctx: Ctx, group: string): string {
  for (const [id, account] of Object.entries(ctx.session.accounts ?? {})) {
    const a = account as { name?: unknown; isPersonal?: unknown };
    if (a.isPersonal !== false) continue;
    if (typeof a.name !== "string") continue;
    if (!sameAddress(a.name, group)) continue;
    return id;
  }
  return "";
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
  // No share: the group's KB is reached by membership, never by a grant to
  // every principal (`gilbert-groups`). Only the folder is made, on first use.
  const folderId = await knowledgeFolder(ctx, accountId, false);
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
  /** The article this one sits inside, or null directly under the tier root. */
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

/** Resolve the tier and one article in it for an editor or lifecycle write. */
async function articleTarget(
  admin: LiveSession,
  target: KnowledgeTarget,
  folder: string,
): Promise<{ ctx: Ctx; accountId: string; article: ArticleFolder }> {
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
  return { ctx: tier.ctx, accountId: tier.accountId, article };
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
 * One article's summary, in the one shape every listing and write answers with.
 *
 * `saved` is passed rather than derived: a listing judges an article by the
 * presence of its `state.json` (written with the draft), while an opened
 * article has the draft itself in hand.
 */
function summaryOf(input: {
  state: KnowledgeState | null;
  draft: KnowledgeDraft | null;
  folder: string;
  nodeId: string;
  parentId: string | null;
  saved: boolean;
}): KnowledgeSummary {
  const { state, draft, folder, nodeId, parentId, saved } = input;
  return {
    id: state?.id ?? draft?.id ?? nodeId,
    title: state?.title ?? draft?.title ?? folder.split("/").pop() ?? folder,
    tags: state?.tags ?? draft?.tags ?? [],
    folder,
    nodeId,
    parentId,
    inForce: state?.inForce ?? null,
    pending: state?.pending ?? null,
    retired: state?.retired ?? null,
    created: state?.created ?? draft?.created ?? null,
    updated: state?.updated ?? draft?.updated ?? null,
    saved,
  };
}

/**
 * List the articles under one folder, depth-first.
 *
 * A listing reads each article's small `state.json`, never its draft or its
 * revisions: the folder is the tree and the state is the title, so navigation
 * costs one document per article (`KnowledgeSummary`). A directory without a
 * `state.json` is a folder alone, not an article -- it is still listed and
 * still recursed into, so a plain folder holding articles is navigable.
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
    // A retired article is withdrawn from the tree but kept for traceability:
    // it and its sub-articles are listed only where a caller asks for them.
    if (state && isRetired(state) && !includeRetired) continue;
    direct.push(
      summaryOf({
        state,
        draft: null,
        folder,
        nodeId: childId,
        parentId,
        saved: state !== null,
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
  direct.sort((a, b) => a.title.localeCompare(b.title));
  return [...direct, ...nested];
}

/** The articles under a KB folder node, siblings ordered by title. */
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
  out.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
  return out;
}

/** A revision, as the history column lists it. */
function revisionSummary(revision: KnowledgeRevision): KnowledgeRevisionSummary {
  return {
    revision: revision.revision,
    effectiveAt: revision.effectiveAt,
    approvedBy: revision.approvedBy,
    approvedAt: revision.approvedAt,
    title: revision.title,
    supersedes: revision.supersedes,
  };
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
    summary: summaryOf({
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

/* ------------------------------------------------------------------ */
/* Editors                                                             */
/* ------------------------------------------------------------------ */

/** Whether a folder already holds a `state.json`, and is therefore an article. */
async function holdsState(
  ctx: Ctx,
  accountId: string,
  articlePath: string,
): Promise<boolean> {
  const folderId = await findFolderPath(ctx, accountId, articlePath);
  if (!folderId) return false;
  const children = await fileChildren(ctx, accountId, folderId, FOLDER_PROPS);
  return children.some((node) => node.nodeType === "file" && node.name === STATE_FILE);
}

/**
 * A folder name under `parentPath` no article holds.
 *
 * Only a folder that holds a `state.json` is an article (ADR 0024: a folder
 * alone is not), so a name a plain folder carries may be reused; one an issued
 * article carries is never overwritten and gets ` (2)`, ` (3)` and so on.
 */
async function freeArticleFolderName(
  ctx: Ctx,
  accountId: string,
  parentPath: string,
  base: string,
): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base} (${n})`;
    if (!(await holdsState(ctx, accountId, `${parentPath}/${candidate}`)))
      return candidate;
  }
  throw new KnowledgeAdminError(
    "article_name_taken",
    `The knowledge base already holds a thousand articles named "${base}".`,
    409,
  );
}

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
  const parent = parentFolder
    ? await resolveArticleFolder(ctx, accountId, tierFolderId, parentFolder)
    : null;
  const parentPath = parent ? `${KNOWLEDGE_FOLDER}/${parent.folder}` : KNOWLEDGE_FOLDER;
  const name = await freeArticleFolderName(ctx, accountId, parentPath, wantedName);
  const nodeId = await ensureFolderPath(ctx, accountId, `${parentPath}/${name}`);
  const id = knowledgeId();
  const now = new Date().toISOString();
  const by = ctx.username;
  const draft = buildDraft({
    id,
    title: docTitle,
    tags: [],
    blocks: [],
    text: "",
    by,
    at: now,
  });
  const state = buildState({ id, title: docTitle, tags: [], by, at: now });
  await writeAppFileIn(ctx, accountId, nodeId, DRAFT_FILE, draft);
  await writeAppFileIn(ctx, accountId, nodeId, STATE_FILE, state);
  return summaryOf({
    state,
    draft,
    folder: parent ? `${parent.folder}/${name}` : name,
    nodeId,
    parentId: parent?.nodeId ?? null,
    saved: true,
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
    const by = ctx.username;
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
    const nextState: KnowledgeState = {
      ...(existingState ?? {}),
      ...buildState({
        id,
        title: draft.title,
        tags: draft.tags,
        by,
        at: now,
        created,
        inForce: existingState?.inForce ?? null,
        pending: existingState?.pending ?? null,
        retired: existingState?.retired ?? null,
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
      return summaryOf({
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
      "invalid_effective_date",
      "An approval needs the date the revision takes effect.",
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
  const now = new Date().toISOString();
  const revision = knowledgeId();
  const issued: KnowledgeIssued = {
    revision,
    effectiveAt: when,
    // The administrator's own address, not the Master's: the door writes as the
    // Master, whose username is the installation's agent, and an approval the
    // agent signed would be exactly the separation ADR 0024 exists to keep.
    approvedBy: admin.username,
    approvedAt: now,
  };
  const supersedes = existingState
    ? (revisionInForceAt(existingState)?.revision ??
      existingState.pending?.revision ??
      null)
    : null;
  const rev = buildRevision(draft, {
    revision,
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
    // Re-read on a retry: whatever landed between the attempts is the state
    // the approval is applied over, so nothing else is overwritten.
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
    nextState = {
      ...stateAfterApproval(base, issued, new Date(now)),
      title: draft.title,
      tags: draft.tags,
      updated: { by: admin.username, at: now },
    };
    const token = await appFolderState(ctx, accountId);
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
  return summaryOf({
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
  const by = ctx.username;
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
      title: draft.title,
      tags: draft.tags,
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
      return summaryOf({
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
  const { ctx, accountId, article } = await articleTarget(admin, target, folder);
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
    let nextFolder = article.folder;
    try {
      if (wantedName !== currentLeaf) {
        const parentPath = article.folder.includes("/")
          ? article.folder.slice(0, article.folder.lastIndexOf("/"))
          : "";
        const appParentPath = parentPath
          ? `${KNOWLEDGE_FOLDER}/${parentPath}`
          : KNOWLEDGE_FOLDER;
        const name = await freeArticleFolderName(
          ctx,
          accountId,
          appParentPath,
          wantedName,
        );
        await client.call(
          "FileNode/set",
          {
            accountId,
            ...(token ? { ifInState: token } : {}),
            update: { [article.nodeId]: { name } },
          },
          [FILENODE_CAP],
        );
        nextFolder = parentPath ? `${parentPath}/${name}` : name;
      }
      const now = new Date().toISOString();
      const by = ctx.username;
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
      return summaryOf({
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
  // no approval ever touched is a draft nobody depended on, and it goes.
  const everApproved =
    Boolean(state?.inForce) || Boolean(state?.pending) || revisions.length > 0;
  if (!everApproved) {
    await destroyAppNode(ctx, accountId, article.nodeId, { removeChildren: true });
    return { retired: false };
  }
  await retireArticle(ctx, accountId, article);
  return { retired: true };
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
): Promise<void> {
  const articlePath = articlePathOf(article);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await appFolderState(ctx, accountId);
    const state = asState(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    );
    if (state?.retired) return;
    const now = new Date().toISOString();
    const by = ctx.username;
    const base =
      state ??
      buildState({
        id: article.nodeId,
        title: article.folder,
        tags: [],
        by,
        at: now,
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
