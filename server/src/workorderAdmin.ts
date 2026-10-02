/**
 * The workorder surface's door (ADR 0028).
 *
 * A workorder is one **uid** and a document named `<uid>.json` under
 * `workorders/` in an account's `gilbert` app folder. The **Master's** copy is
 * the workorder's **root** — its identity, its friendly name, its global
 * checklist and its state — and the Master's `workorders/` folder is the
 * registry; a terminal state moves the root to `workorders/closed/`. A
 * **group's** copy, in the group's own account, is the group's **part**. The
 * durable shape, the validators and the builders live in
 * `@gilbert/shared/workorder`; this module only resolves which account and
 * folder a document lives in, composes the view a caller may reach, and applies
 * the writes.
 *
 * The Master does every read and every write, because it is a member of every
 * group the installation grants it on (ADR 0007): the route serves the surface
 * as the Master and decides, per request, what each caller may reach by the
 * caller's own group membership (ADR 0017). Nothing here is read through a
 * Stalwart share — a workorder is route-only. Because the Master is the only
 * writer, the caller's own address on a step's signature comes from the
 * authenticated session, never from the request.
 */

import { randomUUID } from "node:crypto";
import { groupAccountsDetailed } from "./agent/actions.js";
import { memberGroupAccess } from "./agentAdmin.js";
import {
  appFolderState,
  type Ctx,
  ensureFolderPath,
  FILENODE_CAP,
  fileChildren,
  filesAccountId,
  findAppFileAt,
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
import { isStateMismatch, JmapClient } from "./jmap.js";
import { findArticleById } from "./knowledgeAdmin.js";
import type { LiveSession } from "./sessions.js";
import { FILE_PROPS } from "./shared/appFolder.js";
import {
  checklistStepsFromBlocks,
  isKnowledgeRevision,
  isKnowledgeState,
  KNOWLEDGE_FOLDER,
  REVISIONS_FOLDER,
  revisionFileName,
  revisionInForceAt,
  STATE_FILE,
} from "./shared/knowledge.js";
import {
  buildChecklist,
  buildWorkorderDoc,
  isTerminalState,
  isWorkorderDoc,
  isWorkorderRef,
  isWorkorderState,
  isWorkorderTemplateRef,
  stepOf,
  WORKORDER_CLOSED_FOLDER,
  WORKORDER_FOLDER,
  type WorkorderCreateInput,
  type WorkorderDoc,
  type WorkorderPartView,
  type WorkorderRef,
  type WorkorderState,
  type WorkorderSummary,
  type WorkorderTemplateRef,
  workorderFileName,
} from "./shared/workorder.js";
import { fetchAccountIntrospection, isStalwartAdmin, upstreamFor } from "./upstream.js";

/** A refusal a workorder caller will read: a code, and the sentence to show. */
export class WorkorderAdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "WorkorderAdminError";
  }
}

/* ------------------------------------------------------------------ */
/* The Master's account, and the caller's own session                  */
/* ------------------------------------------------------------------ */

/**
 * The Master's own session for a workorder write.
 *
 * `agentSession` raises `IdentityAdminError`; it is translated here so the
 * routes have one error shape to map and a caller reads a code that names the
 * workorders' own state rather than another surface's message.
 */
async function masterSession(admin: LiveSession): Promise<Ctx> {
  try {
    return await agentSession(admin);
  } catch (err) {
    if (err instanceof IdentityAdminError)
      throw new WorkorderAdminError(
        err.code,
        err.code === "agent_not_configured"
          ? "This deployment names no agent, so workorders cannot be reached."
          : `The installation's agent could not be used for workorders: ${err.message}`,
        err.status,
      );
    throw err;
  }
}

/** The Master's own account and its session: the registry's one writer. */
async function masterAccount(
  admin: LiveSession,
): Promise<{ ctx: Ctx; accountId: string }> {
  const ctx = await masterSession(admin);
  const accountId = filesAccountId(ctx) || ownIdentityAccount(ctx);
  if (!accountId)
    throw new WorkorderAdminError(
      "no_workorder_account",
      "The Master's own account could not be read, so workorders cannot be reached.",
      409,
    );
  return { ctx, accountId };
}

/**
 * Whether the caller is an installation administrator, read the way the
 * administration's own route reads it. An unreadable introspection is
 * non-admin: this only decides what the view offers, while `requireAdmin`
 * stays the enforcement on every write.
 */
async function isAdministrator(session: LiveSession): Promise<boolean> {
  try {
    const intro = await fetchAccountIntrospection(
      session.authorization,
      upstreamFor(session.username),
    );
    return isStalwartAdmin(intro.permissions);
  } catch (err) {
    console.warn(
      `[gilbert] could not read whether ${session.username} administers the installation:`,
      (err as Error).message,
    );
    return false;
  }
}

/**
 * Everything a composition needs: the Master's session, the groups the Master
 * holds, and the groups the caller is a member of.
 *
 * The Master's groups are the candidate set — a part can only live in an
 * account the Master is granted on, because the Master writes it. The caller's
 * own groups are what they may check: an administrator sees every part but
 * checks only the parts of groups they are in, exactly as a member does.
 */
interface WorkorderReach {
  ctx: Ctx;
  accountId: string;
  admin: boolean;
  /** Every group the Master holds, by name, with the account each answers as. */
  masterGroups: Map<string, string>;
  /** The groups the caller is a member of: the parts they may check. */
  own: Set<string>;
}

async function workorderReach(session: LiveSession): Promise<WorkorderReach> {
  const admin = await isAdministrator(session);
  const { ctx, accountId } = await masterAccount(session);
  const masterGroups = (await groupAccountsDetailed(ctx)).groups;
  const own = new Set<string>();
  for (const name of masterGroups.keys()) {
    const access = await memberGroupAccess(session, name, { need: "workorders" });
    if (access.ok) own.add(name);
  }
  return { ctx, accountId, admin, masterGroups, own };
}

/* ------------------------------------------------------------------ */
/* Preparing the registry                                              */
/* ------------------------------------------------------------------ */

/**
 * Ensure `gilbert/workorders` and its `closed/` child exist.
 *
 * Run at boot so the registry is there for every reader without anyone
 * creating it. Idempotent and safe on every boot. No share is applied: a
 * workorder is route-only, reached through the door and never through a grant
 * to every principal (`gilbert-groups`).
 */
export async function ensureWorkorders(ctx: Ctx, accountId: string): Promise<void> {
  await ensureFolderPath(
    ctx,
    accountId,
    `${WORKORDER_FOLDER}/${WORKORDER_CLOSED_FOLDER}`,
  );
}

/* ------------------------------------------------------------------ */
/* Reading one document                                                */
/* ------------------------------------------------------------------ */

/** A root or a part found on disk, with the node a move needs. */
interface WorkorderFound {
  /** The app-folder-relative path the document was read at. */
  path: string;
  /** The folder node holding it. */
  folderId: string;
  /** The file node's id — kept when a root moves. */
  nodeId: string;
  doc: WorkorderDoc;
}

/** The active copy of a uid, or null when it is not there. */
async function findActive(
  ctx: Ctx,
  accountId: string,
  uid: string,
): Promise<WorkorderFound | null> {
  const path = `${WORKORDER_FOLDER}/${workorderFileName(uid)}`;
  const { folderId, file } = await findAppFileAt(ctx, accountId, path);
  if (!folderId || !file || typeof file.id !== "string") return null;
  const doc = await readAppJsonAt(ctx, accountId, path);
  if (!isWorkorderDoc(doc)) return null;
  return { path, folderId, nodeId: file.id, doc };
}

/**
 * The Master's copy of a uid, active or closed.
 *
 * A terminal state moves the root to `workorders/closed/`; the uid is the
 * identity, so a reader looks in both places. A part never moves, so a group's
 * copy is found by `findActive` alone.
 */
async function findRoot(
  ctx: Ctx,
  accountId: string,
  uid: string,
): Promise<WorkorderFound | null> {
  const active = await findActive(ctx, accountId, uid);
  if (active) return active;
  const path = `${WORKORDER_FOLDER}/${WORKORDER_CLOSED_FOLDER}/${workorderFileName(uid)}`;
  const { folderId, file } = await findAppFileAt(ctx, accountId, path);
  if (!folderId || !file || typeof file.id !== "string") return null;
  const doc = await readAppJsonAt(ctx, accountId, path);
  if (!isWorkorderDoc(doc)) return null;
  return { path, folderId, nodeId: file.id, doc };
}

/** Every valid root under the active folder and under `closed/`. */
async function rootDocs(ctx: Ctx, accountId: string): Promise<WorkorderDoc[]> {
  const out: WorkorderDoc[] = [];
  for (const path of [
    WORKORDER_FOLDER,
    `${WORKORDER_FOLDER}/${WORKORDER_CLOSED_FOLDER}`,
  ]) {
    const folderId = await findFolderPath(ctx, accountId, path);
    if (!folderId) continue;
    const children = await fileChildren(ctx, accountId, folderId, FILE_PROPS);
    for (const child of children) {
      // The `closed` directory node sits among the active roots and is dropped
      // by node type; a file that is not a workorder is skipped here too.
      if (child.nodeType !== "file") continue;
      const name = typeof child.name === "string" ? child.name : "";
      if (!name.endsWith(".json")) continue;
      const doc = await readAppJsonAt(ctx, accountId, `${path}/${name}`);
      if (isWorkorderDoc(doc)) out.push(doc);
    }
  }
  return out;
}

/**
 * Each step's label, read from the template revision the checklist is bound to.
 *
 * The checklist stores the template's id and revision and never a copy of the
 * controlled text. A template that cannot be read — one the Master cannot
 * reach, or a revision that is not there — leaves its labels unresolved and is
 * a finding, not a surface taken down.
 */
async function labelsFor(
  ctx: Ctx,
  template: WorkorderTemplateRef,
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  try {
    const tierFolder = await findFolderPath(ctx, template.accountId, KNOWLEDGE_FOLDER);
    if (!tierFolder) return labels;
    const article = await findArticleById(
      ctx,
      template.accountId,
      tierFolder,
      template.id,
    );
    if (!article) return labels;
    const revision = await readAppJsonAt(
      ctx,
      template.accountId,
      `${KNOWLEDGE_FOLDER}/${article.folder}/${REVISIONS_FOLDER}/${revisionFileName(template.revision)}`,
    );
    if (!isKnowledgeRevision(revision)) return labels;
    for (const step of checklistStepsFromBlocks(revision.blocks))
      labels[step.id] = step.label;
  } catch {
    // A template that cannot be read leaves the labels empty; the checklist
    // itself is still served, so the workorder reads rather than disappears.
  }
  return labels;
}

/**
 * One workorder as the caller sees it: the global part from the root, then a
 * part for every group the caller may see.
 *
 * A member sees only their own groups' parts; an administrator sees every part
 * the Master holds, because the route reads them as the Master. A part whose
 * document is gone is omitted — a finding the fleet reconciles, never an empty
 * part.
 */
async function summaryOf(
  reach: WorkorderReach,
  root: WorkorderDoc,
): Promise<WorkorderSummary> {
  // An administrator sees every part the Master holds; a member sees only the
  // parts of their own groups. Either way the account is the Master's to read.
  const visible = (reach.admin ? [...reach.masterGroups.keys()] : [...reach.own]).sort(
    (a, b) => a.localeCompare(b),
  );
  const parts: WorkorderPartView[] = [
    {
      scope: "global",
      accountId: null,
      group: null,
      checklist: root.checklist,
      labels: await labelsFor(reach.ctx, root.checklist.template),
      canCheck: reach.admin,
    },
  ];
  for (const name of visible) {
    const groupAccount = reach.masterGroups.get(name);
    if (!groupAccount) continue;
    const part = await findActive(reach.ctx, groupAccount, root.uid);
    if (!part) continue;
    parts.push({
      scope: "group",
      accountId: groupAccount,
      group: name,
      checklist: part.doc.checklist,
      labels: await labelsFor(reach.ctx, part.doc.checklist.template),
      canCheck: reach.own.has(name),
    });
  }
  return {
    uid: root.uid,
    name: root.name ?? "",
    state: root.state ?? "running",
    replacedBy: root.replacedBy ?? null,
    parts,
    refs: root.refs,
    created: root.created,
    updated: root.updated,
    canAdminister: reach.admin,
  };
}

/**
 * Whether a caller may see a workorder at all.
 *
 * An administrator sees the whole registry. A member reaches their groups, not
 * the Master's registry (ADR 0028), so a workorder one of their groups has no
 * part in is not theirs to see — the same answer whether it is listed or read
 * by uid.
 */
function maySee(reach: WorkorderReach, summary: WorkorderSummary): boolean {
  return reach.admin || summary.parts.some((part) => part.scope === "group");
}

/** Every workorder the caller may see, newest write first. */
export async function listWorkorders(session: LiveSession): Promise<WorkorderSummary[]> {
  const reach = await workorderReach(session);
  const roots = await rootDocs(reach.ctx, reach.accountId);
  const out: WorkorderSummary[] = [];
  for (const root of roots) {
    const summary = await summaryOf(reach, root);
    if (maySee(reach, summary)) out.push(summary);
  }
  out.sort((a, b) => b.updated.at.localeCompare(a.updated.at));
  return out;
}

/** One workorder by uid, or null when the caller may not see it. */
export async function readWorkorder(
  session: LiveSession,
  uid: string,
): Promise<WorkorderSummary | null> {
  const id = (uid ?? "").trim();
  if (!id) return null;
  const reach = await workorderReach(session);
  const root = await findRoot(reach.ctx, reach.accountId, id);
  if (!root) return null;
  const summary = await summaryOf(reach, root.doc);
  return maySee(reach, summary) ? summary : null;
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create a workorder: the root in the Master's account, a part in each named
 * group's.
 *
 * The checklist is an instance of a KB template in force (ADR 0024): the
 * revision bound is the one the template names at now, and a template with
 * none — never approved, or its first still pending — cannot be instantiated
 * at all. The root is written first, so a group part that cannot be written
 * leaves the registry honest about a workorder that exists. Creation is
 * privileged, so the route gates it with `requireAdmin`.
 */
export async function createWorkorder(
  session: LiveSession,
  input: WorkorderCreateInput,
): Promise<WorkorderSummary> {
  const name = (input?.name ?? "").trim();
  if (!name) throw new WorkorderAdminError("bad_request", "A workorder needs a name.");
  const template = input?.template;
  if (!isWorkorderTemplateRef(template))
    throw new WorkorderAdminError(
      "bad_request",
      "A workorder needs the template it instantiates.",
    );
  const rawGroups = input?.groups;
  const groups = Array.isArray(rawGroups)
    ? rawGroups
        .filter((group): group is string => typeof group === "string")
        .map((group) => group.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const { ctx, accountId } = await masterAccount(session);
  const masterGroups = (await groupAccountsDetailed(ctx)).groups;

  // The revision in force, which is the one a checklist may be bound to.
  const tierFolder = await findFolderPath(ctx, template.accountId, KNOWLEDGE_FOLDER);
  const article = tierFolder
    ? await findArticleById(ctx, template.accountId, tierFolder, template.id)
    : null;
  if (!article)
    throw new WorkorderAdminError(
      "template_not_found",
      `The template "${template.id}" could not be found.`,
      404,
    );
  const state = await readAppJsonAt(
    ctx,
    template.accountId,
    `${KNOWLEDGE_FOLDER}/${article.folder}/${STATE_FILE}`,
  );
  const inForce = isKnowledgeState(state) ? revisionInForceAt(state) : null;
  if (!inForce)
    throw new WorkorderAdminError(
      "template_not_in_force",
      "That template has no revision in force, so a workorder cannot be bound to it.",
      409,
    );
  if (template.revision && template.revision !== inForce.revision)
    throw new WorkorderAdminError(
      "template_not_in_force",
      `The template's revision "${template.revision}" is not the one in force.`,
      409,
    );
  const revision = await readAppJsonAt(
    ctx,
    template.accountId,
    `${KNOWLEDGE_FOLDER}/${article.folder}/${REVISIONS_FOLDER}/${revisionFileName(inForce.revision)}`,
  );
  const stepIds = isKnowledgeRevision(revision)
    ? checklistStepsFromBlocks(revision.blocks).map((step) => step.id)
    : [];
  const bound: WorkorderTemplateRef = {
    accountId: template.accountId,
    id: template.id,
    revision: inForce.revision,
  };

  // Resolve every named group before writing anything: a request that names a
  // group the Master does not hold is refused whole, not half written.
  const targets: string[] = [];
  for (const group of groups) {
    const groupAccount = masterGroups.get(group);
    if (!groupAccount)
      throw new WorkorderAdminError(
        "group_not_granted",
        `The installation's agent is not a member of ${group}, so its part cannot be written.`,
        409,
      );
    targets.push(groupAccount);
  }

  const uid = randomUUID();
  const by = session.username;
  const at = new Date().toISOString();
  const root = buildWorkorderDoc({
    uid,
    by,
    at,
    name,
    state: "running",
    checklist: buildChecklist(bound, stepIds),
  });
  await writeAppFileIn(
    ctx,
    accountId,
    await ensureFolderPath(ctx, accountId, WORKORDER_FOLDER),
    workorderFileName(uid),
    root,
  );
  for (const targetAccount of targets) {
    const part = buildWorkorderDoc({
      uid,
      by,
      at,
      checklist: buildChecklist(bound, stepIds),
    });
    await writeAppFileIn(
      ctx,
      targetAccount,
      await ensureFolderPath(ctx, targetAccount, WORKORDER_FOLDER),
      workorderFileName(uid),
      part,
    );
  }
  const summary = await readWorkorder(session, uid);
  if (!summary)
    throw new WorkorderAdminError(
      "workorder_not_written",
      "The workorder was written but could not be read back.",
      502,
    );
  return summary;
}

/* ------------------------------------------------------------------ */
/* Checking a step, closing, and editing references                    */
/* ------------------------------------------------------------------ */

/**
 * Check (or uncheck) one step, keeping its last signature.
 *
 * The document is the only record of a person's act, so the signature is the
 * caller's own address, taken from the authenticated session and never the
 * Master's. The write is a read-modify-write over the whole document under the
 * account's compare-and-set, retried once: JMAP offers no lock, and the state
 * is whole-account, so the retry is what keeps a check from being dropped
 * under two writers.
 */
async function applyStep(input: {
  ctx: Ctx;
  accountId: string;
  uid: string;
  stepId: string;
  checked: boolean;
  by: string;
  /** Whether the document is the Master's root (it may be closed) or a part. */
  root: boolean;
}): Promise<void> {
  const { ctx, accountId, uid, stepId, checked, by, root } = input;
  const at = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt++) {
    // The token is read before the document, so a write landing between the
    // two is refused rather than overwritten.
    const token = await appFolderState(ctx, accountId);
    const found = root
      ? await findRoot(ctx, accountId, uid)
      : await findActive(ctx, accountId, uid);
    if (!found)
      throw new WorkorderAdminError(
        "workorder_not_found",
        `No workorder "${uid}" is there to check.`,
        404,
      );
    if (!stepOf(found.doc.checklist, stepId))
      throw new WorkorderAdminError(
        "step_not_found",
        `That workorder has no step "${stepId}".`,
        404,
      );
    const next: WorkorderDoc = {
      ...found.doc,
      checklist: {
        ...found.doc.checklist,
        steps: found.doc.checklist.steps.map((step) =>
          step.id === stepId
            ? { ...step, state: checked ? "done" : "open", by, at }
            : step,
        ),
      },
      updated: { by, at },
    };
    try {
      await writeAppFileIn(ctx, accountId, found.folderId, workorderFileName(uid), next, {
        ifInState: token || undefined,
      });
      return;
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
    }
  }
  throw new WorkorderAdminError(
    "workorder_check_failed",
    "The check could not be saved because another write kept winning the race.",
    502,
  );
}

/**
 * Check the global checklist, or one group's part.
 *
 * The global checklist is the Master's own and is checked by an administrator
 * or the agent; a group's part is checked by a member of that group. The route
 * gates the request with `requireSession` alone, so the two rules live here,
 * where the caller is known.
 */
export async function checkStep(
  session: LiveSession,
  input: {
    uid: string;
    scope: "global" | "group";
    group?: string;
    stepId: string;
    checked: boolean;
  },
): Promise<WorkorderSummary> {
  const uid = (input?.uid ?? "").trim();
  if (!uid) throw new WorkorderAdminError("bad_request", "A workorder uid is required.");
  const stepId = (input?.stepId ?? "").trim();
  if (!stepId) throw new WorkorderAdminError("bad_request", "A step id is required.");
  const checked = input?.checked === true;
  if (input?.scope === "global") {
    if (!(await isAdministrator(session)))
      throw new WorkorderAdminError(
        "forbidden",
        "Only an installation administrator checks the global checklist.",
        403,
      );
    const { ctx, accountId } = await masterAccount(session);
    await applyStep({
      ctx,
      accountId,
      uid,
      stepId,
      checked,
      by: session.username,
      root: true,
    });
  } else if (input?.scope === "group") {
    const group = (input.group ?? "").trim();
    if (!group)
      throw new WorkorderAdminError(
        "bad_request",
        "A group checklist needs the group's name.",
      );
    const access = await memberGroupAccess(session, group, { need: "workorders" });
    if (!access.ok)
      throw new WorkorderAdminError(
        "forbidden",
        `You are not a member of ${group}, so its checklist is not yours to check.`,
        403,
      );
    // The caller is a member; the Master must hold the group too, or there is
    // no part to write and the surface names the grant that is missing.
    const { ctx } = await masterAccount(session);
    const groupAccount = (await groupAccountsDetailed(ctx)).groups.get(
      group.toLowerCase(),
    );
    if (!groupAccount)
      throw new WorkorderAdminError(
        "group_not_granted",
        `The installation's agent is not a member of ${group}, so its checklist cannot be written.`,
        409,
      );
    await applyStep({
      ctx,
      accountId: groupAccount,
      uid,
      stepId,
      checked,
      by: session.username,
      root: false,
    });
  } else
    throw new WorkorderAdminError(
      "bad_request",
      'The scope must be "global" or "group".',
    );

  const summary = await readWorkorder(session, uid);
  if (!summary)
    throw new WorkorderAdminError(
      "workorder_not_found",
      `No workorder "${uid}" is there to check.`,
      404,
    );
  return summary;
}

/** Move a root between the active folder and `closed/`, keeping its id. */
async function moveRoot(
  ctx: Ctx,
  accountId: string,
  nodeId: string,
  parentId: string,
): Promise<void> {
  const res = await new JmapClient(ctx).call<{
    notUpdated?: Record<string, { type?: unknown; description?: unknown }>;
  }>("FileNode/set", { accountId, update: { [nodeId]: { parentId } } }, [FILENODE_CAP]);
  const refused = res.notUpdated?.[nodeId];
  if (refused)
    throw new WorkorderAdminError(
      "workorder_move_failed",
      refusalOf(refused) || "The workorder could not be moved.",
      502,
    );
}

/**
 * Close a workorder, or reopen one.
 *
 * A terminal state moves the root to `workorders/closed/`; a non-terminal one
 * moves it back out. The folder is a projection of the state, not the state:
 * the `state` field is the truth, the move keeps the node id so every
 * reference by uid survives, and a group's part never moves. The route gates
 * this with `requireAdmin`.
 */
export async function closeWorkorder(
  session: LiveSession,
  uid: string,
  state: WorkorderState,
): Promise<WorkorderSummary> {
  const id = (uid ?? "").trim();
  if (!id) throw new WorkorderAdminError("bad_request", "A workorder uid is required.");
  if (!isWorkorderState(state))
    throw new WorkorderAdminError(
      "bad_state",
      "A workorder state must be running, completed, cancelled or replaced.",
    );
  const { ctx, accountId } = await masterAccount(session);
  const activeId = await ensureFolderPath(ctx, accountId, WORKORDER_FOLDER);
  const closedId = await ensureFolderPath(
    ctx,
    accountId,
    `${WORKORDER_FOLDER}/${WORKORDER_CLOSED_FOLDER}`,
  );
  const target = isTerminalState(state) ? closedId : activeId;
  const by = session.username;
  const at = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await appFolderState(ctx, accountId);
    const found = await findRoot(ctx, accountId, id);
    if (!found)
      throw new WorkorderAdminError("workorder_not_found", `No workorder "${id}".`, 404);
    const next: WorkorderDoc = { ...found.doc, state, updated: { by, at } };
    try {
      await writeAppFileIn(ctx, accountId, found.folderId, workorderFileName(id), next, {
        ifInState: token || undefined,
      });
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
      continue;
    }
    await moveRoot(ctx, accountId, found.nodeId, target);
    const summary = await readWorkorder(session, id);
    if (!summary)
      throw new WorkorderAdminError("workorder_not_found", `No workorder "${id}".`, 404);
    return summary;
  }
  throw new WorkorderAdminError(
    "workorder_close_failed",
    "The workorder could not be closed because another write kept winning the race.",
    502,
  );
}

/** Whether two references name the same object. */
function sameRef(a: WorkorderRef, b: WorkorderRef): boolean {
  return a.accountId === b.accountId && a.kind === b.kind && a.id === b.id;
}

/**
 * Add or remove a reference on the root.
 *
 * A reference is `{accountId, kind, id}` — a folder, a file or a KB article —
 * and the pointers by id are the truth: adding one that is already there
 * changes nothing, and removing one that is not there changes nothing. The
 * write is a compare-and-set over the root, retried once. The route gates this
 * with `requireAdmin`.
 */
export async function editRefs(
  session: LiveSession,
  uid: string,
  change: { add?: WorkorderRef; remove?: WorkorderRef },
): Promise<WorkorderSummary> {
  const id = (uid ?? "").trim();
  if (!id) throw new WorkorderAdminError("bad_request", "A workorder uid is required.");
  const add = change?.add;
  const remove = change?.remove;
  if (add !== undefined && !isWorkorderRef(add))
    throw new WorkorderAdminError(
      "bad_request",
      "The reference to add is not a reference.",
    );
  if (remove !== undefined && !isWorkorderRef(remove))
    throw new WorkorderAdminError(
      "bad_request",
      "The reference to remove is not a reference.",
    );
  if (add === undefined && remove === undefined)
    throw new WorkorderAdminError(
      "bad_request",
      "A reference change needs a reference to add or remove.",
    );
  const { ctx, accountId } = await masterAccount(session);
  const by = session.username;
  const at = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await appFolderState(ctx, accountId);
    const found = await findRoot(ctx, accountId, id);
    if (!found)
      throw new WorkorderAdminError("workorder_not_found", `No workorder "${id}".`, 404);
    let refs = found.doc.refs;
    if (remove) refs = refs.filter((ref) => !sameRef(ref, remove));
    if (add && !refs.some((ref) => sameRef(ref, add))) refs = [...refs, add];
    const next: WorkorderDoc = { ...found.doc, refs, updated: { by, at } };
    try {
      await writeAppFileIn(ctx, accountId, found.folderId, workorderFileName(id), next, {
        ifInState: token || undefined,
      });
    } catch (err) {
      if (attempt > 0 || !isStateMismatch(err)) throw err;
      continue;
    }
    const summary = await readWorkorder(session, id);
    if (!summary)
      throw new WorkorderAdminError("workorder_not_found", `No workorder "${id}".`, 404);
    return summary;
  }
  throw new WorkorderAdminError(
    "workorder_ref_failed",
    "The reference could not be saved because another write kept winning the race.",
    502,
  );
}
