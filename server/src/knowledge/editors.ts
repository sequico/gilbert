/**
 * The editors and the lifecycle writes.
 *
 * Every write goes through this module, which acts as the Master because a
 * reader's own session holds nothing of the Master's account: a create, a
 * save, an approval, a restore, a rename, a reorder, a move, a folder and a
 * delete. The compare-and-set shape is the same in all of them.
 */

import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  ensureFolderPath,
  fileChildren,
  findFolderPath,
  readAppJsonAt,
  readAppJsonForWrite,
  updateAppNode,
  writeAppFileIn,
} from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import type { LiveSession } from "../sessions.js";
import { FOLDER_PROPS } from "../shared/appFolder.js";
import { mapLimit, READ_CONCURRENCY } from "../shared/concurrency.js";
import { refusalOf } from "../shared/jmap.js";
import {
  buildDraft,
  buildFolderDoc,
  buildRevision,
  buildState,
  DRAFT_FILE,
  isChecklistTemplate,
  isKnowledgeFolderDoc,
  isKnowledgeRevision,
  isReservedArticleName,
  KNOWLEDGE_FOLDER,
  KNOWLEDGE_FOLDER_FILE,
  type KnowledgeArticleInput,
  type KnowledgeChecklist,
  type KnowledgeDraft,
  type KnowledgeIssued,
  type KnowledgeState,
  type KnowledgeSummary,
  type KnowledgeTarget,
  knowledgeFolderName,
  knowledgeId,
  knowledgeSummary,
  leafFolderName,
  plainTextFromBlocks,
  REVISIONS_FOLDER,
  revisionFileName,
  revisionInForceAt,
  STATE_FILE,
  stateAfterApproval,
} from "../shared/knowledge.js";
import { asDraft, asState, titleFor } from "./documents.js";
import { KnowledgeAdminError, requireState } from "./errors.js";
import { highestRevisionNumber, revisionsExist } from "./reads.js";
import { knowledgeFolder, tierAccount } from "./scope.js";
import {
  type ArticleFolder,
  articlePathOf,
  articleTarget,
  findArticle,
  resolveArticleFolder,
  resolveParentFolder,
} from "./tree.js";

/**
 * The last order a create minted.
 *
 * A create lands last among its siblings; the clock alone hands two creates in
 * the same millisecond the same number, which leaves their order to the node
 * id. Kept strictly above the clock, so a create always follows the one before
 * it.
 */
let lastCreateOrder = 0;

/**
 * A topic folder's order, read from its `folder.json` (0 when absent).
 *
 * The document and its shape are `@gilbert/shared/knowledge`'s rule; this is
 * only its read path, so the server and the client agree on what a folder's
 * place is.
 */
export async function folderOrder(
  ctx: Ctx,
  accountId: string,
  folder: string,
): Promise<number> {
  const doc = await readAppJsonAt(
    ctx,
    accountId,
    `${KNOWLEDGE_FOLDER}/${folder}/${KNOWLEDGE_FOLDER_FILE}`,
  );
  return isKnowledgeFolderDoc(doc) ? doc.order : 0;
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
  blocks: unknown[] = [],
  checklist: KnowledgeChecklist | null = null,
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
    blocks,
    text: plainTextFromBlocks(blocks),
    checklist,
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
    // A create that carries a checklist definition is a template from its
    // first moment, exactly as a save that adds one would make it.
    template: isChecklistTemplate(draft) ? "checklist" : null,
  });
  // The two documents are written as one unit: the listing key (`state.json`)
  // is what makes the directory an article, so a draft that landed without it
  // would be an invisible directory whose name is now taken. A refused write
  // takes the folder back with it rather than leaving that behind.
  try {
    await writeAppFileIn(ctx, accountId, nodeId, DRAFT_FILE, draft);
    await writeAppFileIn(ctx, accountId, nodeId, STATE_FILE, state);
  } catch (err) {
    await destroyAppNode(ctx, accountId, nodeId, { removeChildren: true }).catch(
      () => undefined,
    );
    throw err;
  }
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
export async function freeChildFolderName(
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
  // The folder's place is its only document; a write that is refused takes the
  // directory back with it rather than leaving an empty one whose name is taken.
  try {
    await writeAppFileIn(
      ctx,
      accountId,
      nodeId,
      KNOWLEDGE_FOLDER_FILE,
      buildFolderDoc(order),
    );
  } catch (err) {
    await destroyAppNode(ctx, accountId, nodeId, { removeChildren: true }).catch(
      () => undefined,
    );
    throw err;
  }
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
  return await writeDraft({ ctx, accountId, article, input, by: admin.username });
}

/**
 * Write a page's draft as the agent (ADR 0020, ADR 0027).
 *
 * A proposal is the draft and nothing more: approval still mints the revision,
 * and a person is still its author. The write is `writeDraft`'s — the same
 * merge, the same refusals over a retired page and an unreadable document, and
 * the same listing update as a person's save — over the account the caller
 * holds, which for a run is the group's own.
 */
export async function proposeArticle(
  ctx: Ctx,
  accountId: string,
  folder: string,
  input: KnowledgeArticleInput,
  by: string,
): Promise<KnowledgeSummary> {
  const clean = (folder ?? "").trim();
  if (!clean)
    throw new KnowledgeAdminError("bad_request", "An article folder is required.");
  const article = await resolveArticleFolder(
    ctx,
    accountId,
    await knowledgeFolder(ctx, accountId),
    clean,
  );
  return await writeDraft({ ctx, accountId, article, input, by });
}

/** The one write of an article's draft, signed by whoever the caller says. */
export async function writeDraft(spec: {
  ctx: Ctx;
  accountId: string;
  article: ArticleFolder;
  input: KnowledgeArticleInput;
  by: string;
}): Promise<KnowledgeSummary> {
  const { ctx, accountId, article, input, by } = spec;
  const articlePath = articlePathOf(article);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    await ensureFolderPath(ctx, accountId, articlePath);
    const state = requireState(await appFolderState(ctx, accountId));
    /*
     * Strictly, not through `readAppJsonAt`: a draft or state file that could
     * not be read reads there as absent, and this save would then treat the
     * article as new — minting an `id` and writing `inForce`/`pending`/`retired`
     * back as `null`. That revives a retired article and loses the pointer to
     * the issued revision, from a save that only meant to change the body.
     */
    // The two documents are independent reads, so they travel together.
    const [draftRead, stateRead] = await Promise.all([
      readAppJsonForWrite(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
      readAppJsonForWrite(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    ]);
    const existingDraft = asDraft(draftRead.kind === "ok" ? draftRead.doc : null);
    const existingState = asState(stateRead.kind === "ok" ? stateRead.doc : null);
    /*
     * A document that could not be read, or one that is there and does not read
     * as this article's own, is not an article this save may treat as new: it
     * would mint an `id` and write `inForce`/`pending`/`retired` back as `null`,
     * which revives a retired article and loses the pointer to the issued
     * revision, from a save that only meant to change the body. (A folder that
     * is not an article never reaches here — the walk that resolved this one
     * validated its state.)
     */
    if (
      draftRead.kind === "unreadable" ||
      stateRead.kind === "unreadable" ||
      (draftRead.kind === "ok" && !existingDraft) ||
      (stateRead.kind === "ok" && !existingState)
    )
      throw new KnowledgeAdminError(
        "article_unreadable",
        "This article's own documents could not be read as this build's, so nothing was saved — writing here would have treated it as new and dropped its revision history. Try again.",
        502,
      );
    const now = new Date().toISOString();
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
        checklist: input.checklist ?? null,
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
        // The rules decide whether the page is a checklist template: a
        // definition makes it one, and clearing it makes an ordinary page again
        // (ADR 0026).
        template: isChecklistTemplate(draft) ? "checklist" : null,
      }),
    };
    try {
      await writeAppFileIn(ctx, accountId, article.nodeId, DRAFT_FILE, draft, {
        ifInState: state,
      });
      // The draft write advanced the account's state, so the second write is
      // conditioned on a fresh token rather than the one the read used.
      const after = requireState(await appFolderState(ctx, accountId));
      await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, nextState, {
        ifInState: after,
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
      if (retryStateMismatch(err, attempt)) break;
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
 * from the request (ADR 0020, Q8).
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
  const [draftRaw, stateRaw] = await Promise.all([
    readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
    readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
  ]);
  const draft = asDraft(draftRaw);
  if (!draft)
    throw new KnowledgeAdminError(
      "draft_missing",
      "That article has no draft to approve.",
      409,
    );
  const existingState = asState(stateRaw);
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
  // in-force one still numbers forward rather than reusing it. The store's
  // newest revision is read as well as the state, so a `state.json` that is
  // missing or corrupt — or a revision whose own state write never landed —
  // resumes after the store rather than restarting at one.
  const storedRev = await highestRevisionNumber(ctx, accountId, articlePath);
  const revNumber =
    Math.max(
      existingState?.inForce?.rev ?? 0,
      existingState?.pending?.rev ?? 0,
      storedRev,
    ) + 1;
  const issued: KnowledgeIssued = {
    revision,
    rev: revNumber,
    effectiveAt: when,
    // The administrator's own address, not the Master's: the door writes as the
    // Master, whose username is the installation's agent, and an approval the
    // agent signed would be exactly the separation ADR 0020 exists to keep.
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
  // Bounded by `retryStateMismatch`, which throws on the last attempt -- so the
  // header is not the shape of an unbounded loop, it is the shape of one whose
  // bound is stated where the refusal is written rather than repeated here.
  for (let attempt = 0; ; attempt++) {
    // The token is read before the state document, as `saveDraft` reads it: a
    // token read after it is still valid while what it would be compared
    // against has already moved. Both are re-read on a retry, so whatever
    // landed between the attempts is the state the approval is applied over.
    const token = requireState(await appFolderState(ctx, accountId));
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
    const nextState = {
      ...after,
      title: inForceNow ? draft.title : base.title,
      tags: inForceNow ? draft.tags : base.tags,
      updated: { by: admin.username, at: now },
    };
    try {
      await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, nextState, {
        ifInState: token,
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
      // The race lost twice is refused here, inside the loop: the revision
      // above is already written, and a state that never points at it is an
      // issued document nobody can read.
      if (retryStateMismatch(err, attempt))
        throw new KnowledgeAdminError(
          "knowledge_approve_failed",
          "The revision was recorded but its state could not be written because another write kept winning the race.",
          502,
        );
    }
  }
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
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    // The token is read before the documents, as `saveDraft` reads it: a token
    // read after them is still valid while the documents it would be compared
    // against have already moved, which is the lost update this guards.
    const token = requireState(await appFolderState(ctx, accountId));
    const [draftRaw, stateRaw] = await Promise.all([
      readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
      readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    ]);
    const existingDraft = asDraft(draftRaw);
    const existingState = asState(stateRaw);
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
        checklist: rev.checklist ?? null,
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
        ifInState: token,
      });
      const after = requireState(await appFolderState(ctx, accountId));
      await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, nextState, {
        ifInState: after,
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
      if (retryStateMismatch(err, attempt)) break;
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
 *
 * The article is re-resolved by that node id on **every** attempt: a rename
 * that succeeded moves the folder, so a retry after a lost race must read where
 * the article is now rather than rename the path it used to be at a second
 * time.
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
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    // Re-resolved by the node id, which a rename leaves alone: an article whose
    // folder a previous attempt moved is read where it is now.
    const current = await findArticle(
      ctx,
      accountId,
      folderId,
      ({ nodeId }) => nodeId === article.nodeId,
    );
    if (!current)
      throw new KnowledgeAdminError(
        "article_not_found",
        `The knowledge base has no article "${article.folder}".`,
        404,
      );
    const articlePath = articlePathOf(current);
    const leaf = leafFolderName(current.folder);
    // The token is read before the documents, so a save landing between them and
    // the writes is refused rather than silently overwritten.
    const token = requireState(await appFolderState(ctx, accountId));
    const [draftRaw, stateRaw] = await Promise.all([
      readAppJsonAt(ctx, accountId, `${articlePath}/${DRAFT_FILE}`),
      readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    ]);
    const draft = asDraft(draftRaw);
    const state = asState(stateRaw);
    if (state?.retired)
      throw new KnowledgeAdminError(
        "article_retired",
        "That article is retired and kept on record, so it is not renamed.",
        409,
      );
    let nextFolder = current.folder;
    try {
      if (wantedName !== leaf) {
        // The parent is the article's own parent node, or the tier root: one
        // free-name helper for a rename, an article create and a folder create.
        const parentPath = current.folder.includes("/")
          ? current.folder.slice(0, current.folder.lastIndexOf("/"))
          : "";
        const name = await freeChildFolderName(
          ctx,
          accountId,
          current.parentId ?? folderId,
          wantedName,
        );
        const renamed = await updateAppNode(
          ctx,
          accountId,
          current.nodeId,
          { name },
          token,
        );
        const nameRefused = renamed.notUpdated?.[current.nodeId];
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
      const after = requireState(await appFolderState(ctx, accountId));
      if (nextDraft)
        await writeAppFileIn(ctx, accountId, current.nodeId, DRAFT_FILE, nextDraft, {
          ifInState: after,
        });
      const after2 = requireState(await appFolderState(ctx, accountId));
      if (nextState)
        await writeAppFileIn(ctx, accountId, current.nodeId, STATE_FILE, nextState, {
          ifInState: after2,
        });
      return knowledgeSummary({
        state: nextState,
        draft: nextDraft,
        folder: nextFolder,
        nodeId: current.nodeId,
        parentId: current.parentId,
        saved: nextDraft !== null,
      });
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
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
  return await writePlace({ ctx, accountId, article, order, by: admin.username });
}

/**
 * The same write under a tier the request already resolved.
 *
 * A family renumber is one request carrying every sibling's new place, and
 * resolving the tier per item would pay a live membership probe and a Master
 * session for each one. The caller resolves it once; each item still gets its
 * own compare-and-set, which is what keeps the numbers independent.
 */
export async function reorderArticleInTier(
  tier: { ctx: Ctx; accountId: string; folderId: string },
  folder: string,
  order: number,
  by: string,
): Promise<KnowledgeSummary> {
  if (!Number.isFinite(order))
    throw new KnowledgeAdminError("bad_request", "An order must be a number.");
  const clean = (folder ?? "").trim();
  if (!clean)
    throw new KnowledgeAdminError("bad_request", "An article folder is required.");
  const article = await resolveArticleFolder(
    tier.ctx,
    tier.accountId,
    tier.folderId,
    clean,
  );
  return await writePlace({
    ctx: tier.ctx,
    accountId: tier.accountId,
    article,
    order,
    by,
  });
}

/** The one place write of an article's place, under the account's compare-and-set. */
async function writePlace(spec: {
  ctx: Ctx;
  accountId: string;
  article: ArticleFolder;
  order: number;
  by: string;
}): Promise<KnowledgeSummary> {
  const { ctx, accountId, article, order, by } = spec;
  const articlePath = articlePathOf(article);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    // The token is read before the documents, as `saveDraft` reads it: a token
    // read after them is still valid while what it would be compared against
    // has already moved.
    const token = requireState(await appFolderState(ctx, accountId));
    const state = asState(
      await readAppJsonAt(ctx, accountId, `${articlePath}/${STATE_FILE}`),
    );
    try {
      if (state) {
        const next: KnowledgeState = {
          ...state,
          order,
          updated: { by, at: new Date().toISOString() },
        };
        await writeAppFileIn(ctx, accountId, article.nodeId, STATE_FILE, next, {
          ifInState: token,
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
        { ifInState: token },
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
      if (retryStateMismatch(err, attempt)) break;
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
  const leaf = leafFolderName(article.folder);
  const nextFolder = parent ? `${parent.folder}/${leaf}` : leaf;
  // The FileNode sits under the tier's own KB folder at the root; only the
  // summary spells that as a null parent, exactly as the listing does.
  const destNodeId = parent ? parent.nodeId : tierFolderId;
  const destParentId = parent ? parent.nodeId : null;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
    try {
      const res = await updateAppNode(
        ctx,
        accountId,
        article.nodeId,
        { parentId: destNodeId },
        token,
      );
      const refused = res.notUpdated?.[article.nodeId];
      if (refused)
        throw new KnowledgeAdminError(
          "knowledge_move_refused",
          refusalOf(refused) || "The article could not be moved to that folder.",
          409,
        );
      const afterPath = `${KNOWLEDGE_FOLDER}/${nextFolder}`;
      const [stateRaw, draftRaw] = await Promise.all([
        readAppJsonAt(ctx, accountId, `${afterPath}/${STATE_FILE}`),
        readAppJsonAt(ctx, accountId, `${afterPath}/${DRAFT_FILE}`),
      ]);
      const state = asState(stateRaw);
      const draft = asDraft(draftRaw);
      return knowledgeSummary({
        state,
        draft,
        folder: nextFolder,
        nodeId: article.nodeId,
        parentId: destParentId,
        saved: draft !== null,
      });
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
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
export async function subtreeHasApproval(
  ctx: Ctx,
  accountId: string,
  articlePath: string,
): Promise<boolean> {
  const folderId = await findFolderPath(ctx, accountId, articlePath);
  if (!folderId) return false;
  const children = await fileChildren(ctx, accountId, folderId, FOLDER_PROPS);
  const found = await mapLimit(children, READ_CONCURRENCY, async (child) => {
    if (child.nodeType !== "directory") return false;
    const name = typeof child.name === "string" ? child.name : "";
    if (!name || name === REVISIONS_FOLDER) return false;
    const childPath = `${articlePath}/${name}`;
    /*
     * A revision store marks an article whatever its `state.json` reads as.
     * The state is the listing key, not proof of absence: a corrupt or missing
     * one must not hide an issued revision from this check, or a folder delete
     * would take the record with it. So the store is asked first.
     */
    if (await revisionsExist(ctx, accountId, childPath)) return true;
    const state = asState(
      await readAppJsonAt(ctx, accountId, `${childPath}/${STATE_FILE}`),
    );
    /*
     * An article is a leaf: its own pointer is the whole answer and there is
     * nothing under it to descend into. A topic folder holds no documents of
     * its own, so only that recurses.
     */
    if (state) return Boolean(state.inForce) || Boolean(state.pending);
    return await subtreeHasApproval(ctx, accountId, childPath);
  });
  return found.some(Boolean);
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
  // Traceability: an article something was issued from is never destroyed. One
  // no approval ever touched is a draft nobody depended on, and it goes — but
  // only if nothing under it was issued either. Whether a revision store holds
  // anything is a listing's answer, not a download per revision.
  const everApproved =
    Boolean(state?.inForce) ||
    Boolean(state?.pending) ||
    (await revisionsExist(ctx, accountId, articlePath));
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
export async function retireArticle(
  ctx: Ctx,
  accountId: string,
  article: ArticleFolder,
  by: string,
): Promise<void> {
  const articlePath = articlePathOf(article);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
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
    const leaf = leafFolderName(article.folder);
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
        ifInState: token,
      });
      return;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw new KnowledgeAdminError(
    "knowledge_retire_failed",
    "The article could not be retired because another write kept winning the race.",
    502,
  );
}
