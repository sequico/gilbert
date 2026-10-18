/**
 * The workorder writes: creation, checking a step, closing and references.
 *
 * Every write is a read-modify-write under the account's compare-and-set,
 * retried once, and the gates a step opens are reconciled on the Master's root.
 */

import { randomUUID } from "node:crypto";
import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  ensureFolderPath,
  filesAccountId,
  findFolderPath,
  readAppJsonAt,
  updateAppNode,
  writeAppFileIn,
} from "../appFolder.js";
import { groupAccountsDetailed } from "../groupAccess.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { findArticleById } from "../knowledgeAdmin.js";
import type { LiveSession } from "../sessions.js";
import { errorMessage } from "../shared/errors.js";
import { refusalOf } from "../shared/jmap.js";
import {
  checklistGroups,
  isKnowledgeRevision,
  isKnowledgeState,
  KNOWLEDGE_FOLDER,
  type KnowledgeChecklist,
  REVISIONS_FOLDER,
  revisionFileName,
  revisionInForceAt,
  STATE_FILE,
} from "../shared/knowledge.js";
import {
  applicableStepPaths,
  buildChecklist,
  buildWorkorderDoc,
  isTerminalState,
  isWorkorderRef,
  isWorkorderState,
  isWorkorderStepState,
  isWorkorderTemplateRef,
  stepOf,
  WORKORDER_FOLDER,
  type WorkorderCheckInput,
  type WorkorderCreateInput,
  type WorkorderDoc,
  type WorkorderItem,
  type WorkorderRef,
  type WorkorderRefChange,
  type WorkorderState,
  type WorkorderStepState,
  type WorkorderSummary,
  type WorkorderTemplateRef,
  workorderClosedPath,
  workorderFileName,
} from "../shared/workorder.js";
import {
  findActive,
  findRoot,
  type WorkorderFound,
  writeRootUnderCas,
} from "./documents.js";
import { groupNotGranted, requireState, WorkorderAdminError } from "./errors.js";
import {
  gateOpen,
  readWorkorder,
  readWorkorderWithReach,
  sectionCompletion,
  type WorkorderGates,
} from "./listing.js";
import { masterAccount, maySee, type WorkorderReach, workorderReach } from "./reach.js";
import { templateDef } from "./templates.js";

/**
 * The choices a create names, checked against the template's rules.
 *
 * Every variant the template declares needs a value and every repeated section
 * needs at least one item: a branch left undecided would materialise a process
 * that is not the one the template describes, so the create is refused whole
 * (`workorder_choices_missing`) rather than half-built. Each chosen item
 * carries only the data fields the template declares for it, trimmed.
 */
function checklistChoices(
  def: KnowledgeChecklist,
  input: WorkorderCreateInput,
): { variants: Record<string, string>; items: Record<string, WorkorderItem[]> } {
  const rawVariants = input.variants ?? {};
  const variants: Record<string, string> = {};
  for (const variant of def.variants) {
    const value = (rawVariants[variant.key] ?? "").trim();
    if (!value || !variant.values.some((v) => v.value === value))
      throw new WorkorderAdminError(
        "workorder_choices_missing",
        `The choice "${variant.label}" needs one of its values.`,
      );
    variants[variant.key] = value;
  }
  const rawItems = input.items ?? {};
  const items: Record<string, WorkorderItem[]> = {};
  for (const section of def.sections) {
    const repeat = section.repeat;
    if (!repeat) continue;
    // A section whose condition the chosen values do not meet does not
    // materialise (ADR 0030), so its repeat names no items and none are
    // required — only a section that will appear needs at least one.
    if (
      section.condition &&
      variants[section.condition.variant] !== section.condition.equals
    )
      continue;
    const chosen: WorkorderItem[] = [];
    for (const entry of rawItems[section.key] ?? []) {
      const key = entry.key.trim();
      if (!key) continue;
      const data: Record<string, string> = {};
      for (const field of repeat.fields)
        data[field.key] = (entry.data?.[field.key] ?? "").trim();
      chosen.push({ key, data });
    }
    if (!chosen.length)
      throw new WorkorderAdminError(
        "workorder_choices_missing",
        `The section "${section.label}" needs at least one ${repeat.item}.`,
      );
    items[section.key] = chosen;
  }
  return { variants, items };
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
  // The revision the state names is the controlled process of every step; an
  // unreadable one would silently bind the workorder to an empty checklist, so
  // it is refused rather than half-created.
  if (!isKnowledgeRevision(revision))
    throw new WorkorderAdminError(
      "template_not_in_force",
      "The template's revision could not be read, so a checklist cannot be built from it.",
      404,
    );
  const def = revision.checklist ?? null;
  if (!def)
    throw new WorkorderAdminError(
      "template_not_a_process",
      "That template carries no checklist rules, so a workorder cannot be built from it.",
      409,
    );
  const bound: WorkorderTemplateRef = {
    accountId: template.accountId,
    id: template.id,
    revision: inForce.revision,
  };
  // The choices a create names are checked against the rules before anything is
  // written: a branch left undecided refuses the whole request.
  const { variants, items } = checklistChoices(def, input);
  const buildInstance = (target: string | null) =>
    buildChecklist({
      template: bound,
      variants,
      items,
      stepPaths: applicableStepPaths(def, variants, items, target),
    });

  // The parts are the groups the template **assigns sections to** (ADR 0030):
  // the global checklist holds the unassigned sections and each assigned group's
  // part holds its own. Resolve every assigned group before writing anything, so
  // a group the Master does not hold refuses the whole request rather than a
  // half-written workorder.
  const heldAccounts = new Set(masterGroups.values());
  const targets = checklistGroups(def);
  for (const groupAccount of targets) {
    if (!heldAccounts.has(groupAccount))
      throw groupNotGranted(
        "the group a section is assigned to",
        "its part cannot be written",
      );
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
    checklist: buildInstance(null),
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
      checklist: buildInstance(targetAccount),
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
 * Set one step's state, keeping its signature.
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
  path: string;
  state: WorkorderStepState;
  note: string;
  by: string;
}): Promise<WorkorderDoc> {
  const { ctx, accountId, uid, path, state, note, by } = input;
  const at = new Date().toISOString();
  const written = await writeRootUnderCas(
    ctx,
    accountId,
    uid,
    {
      code: "workorder_check_failed",
      message:
        "The check could not be saved because another write kept winning the race.",
    },
    (found) => {
      refuseIfTerminal(found.doc);
      if (!stepOf(found.doc.checklist, path))
        throw new WorkorderAdminError(
          "step_not_found",
          `That workorder has no step "${path}".`,
          404,
        );
      return {
        ...found.doc,
        checklist: {
          ...found.doc.checklist,
          steps: found.doc.checklist.steps.map((step) =>
            step.path === path ? { ...step, state, by, at, note } : step,
          ),
        },
        updated: { by, at },
      };
    },
  );
  return written.doc;
}

/**
 * Refuse checking a step once the workorder is terminal, and answer the root it
 * read.
 *
 * A closed workorder is kept for ever and its checklist is the record of the
 * work, not a document that keeps moving. The state lives on the Master's
 * root — a group's part does not carry one — so the check reads the root in
 * both cases, from the account the caller's write will reach it through.
 *
 * The document travels back because the gates pass that follows needs it: a
 * group's check writes one of its parts and leaves the root where it was, so
 * the same read answers both.
 */
async function refuseTerminal(
  ctx: Ctx,
  accountId: string,
  uid: string,
): Promise<WorkorderDoc | null> {
  const root = await findRoot(ctx, accountId, uid);
  if (root) refuseIfTerminal(root.doc);
  return root?.doc ?? null;
}

/**
 * The rule itself, on a document the caller already holds.
 *
 * A root carries the state and a group's part does not, so the write that
 * targets the root has the answer in the compare-and-set it is already running
 * and needs no read of its own — while a part's write cannot see it at all and
 * is refused from the root `refuseTerminal` read for it.
 */
function refuseIfTerminal(doc: WorkorderDoc): void {
  if (isTerminalState(doc.state ?? "running"))
    throw new WorkorderAdminError(
      "workorder_closed",
      "That workorder is closed, so its checklist no longer changes.",
      409,
    );
}

/**
 * Record on the Master's root every gate a step write has just opened.
 *
 * A section's gate opens once its prerequisites are all complete; from then on
 * the latch keeps it open for the rest of the workorder, so re-opening a
 * prerequisite never hides a section a group has already been given. The check
 * is made over every part the Master holds, because a prerequisite may live in
 * another part (ADR 0030). A workorder with no gate writes nothing.
 *
 * It reads through the request's own reach — the Master's session, its groups
 * and the resolved template — so the reconcile a write runs does not open a
 * second Master session or resolve the template a second time.
 */
async function reconcileGates(
  reach: WorkorderReach,
  uid: string,
  root: WorkorderDoc | null,
): Promise<Map<string, WorkorderFound | null>> {
  // The parts this pass read, so the summary composed for the same request does
  // not read one per group again: the caller gets them back either way.
  const parts = new Map<string, WorkorderFound | null>();
  if (!root || isTerminalState(root.state ?? "running")) return parts;
  const def = (await templateDef(reach, root.checklist.template)).checklist;
  if (!def) return parts;
  /*
   * The same gate the reader sees, decided through `gateOpen` so the latch
   * records exactly what `groupsFor` will serve: a prerequisite the resolver
   * never computed — excluded by the chosen values, or a part that is not here
   * — is tolerated rather than waited on for ever (ADR 0030).
   */
  const gates: WorkorderGates = {
    completion: new Map<string, boolean>(),
    latched: new Set(root.gates ?? []),
    labels: new Map<string, string>(),
    known: new Set(def.sections.map((section) => section.key)),
  };
  const gated = def.sections.filter((section) => (section.requires?.length ?? 0) > 0);
  const pending = gated.filter((section) => !gates.latched.has(section.key));
  if (!pending.length) return parts;

  for (const [key, value] of sectionCompletion(def, root.checklist, null))
    gates.completion.set(key, value);
  for (const groupAccount of reach.masterGroups.values()) {
    const part = await findActive(reach.ctx, groupAccount, uid);
    parts.set(groupAccount, part);
    if (!part) continue;
    for (const [key, value] of sectionCompletion(def, part.doc.checklist, groupAccount))
      gates.completion.set(key, value);
  }

  const opened = pending
    .filter((section) => gateOpen(section, gates))
    .map((section) => section.key);
  if (!opened.length) return parts;

  await writeRootUnderCas(
    reach.ctx,
    reach.accountId,
    uid,
    {
      code: "workorder_check_failed",
      message: "The opened gates could not be recorded.",
    },
    (found) => {
      const have = new Set(found.doc.gates ?? []);
      const add = opened.filter((key) => !have.has(key));
      if (!add.length) return found.doc;
      return { ...found.doc, gates: [...(found.doc.gates ?? []), ...add] };
    },
  );
  return parts;
}

/**
 * Reconcile the gates after a step write, without failing the write.
 *
 * The step is already saved when this runs, and a gate that could not be
 * recorded is re-decided from the prerequisites' current state on the next
 * read, so the section is not hidden while they stay complete. A failed record
 * is warned about rather than thrown: it only matters if a prerequisite is
 * reopened before the next write reconciles it.
 *
 * It answers the parts it read, for the summary the same request composes: an
 * empty map when there was nothing to reconcile, which leaves that read whole.
 */
async function recordOpenedGates(
  reach: WorkorderReach,
  uid: string,
  root: WorkorderDoc | null,
): Promise<Map<string, WorkorderFound | null>> {
  try {
    return await reconcileGates(reach, uid, root);
  } catch (err) {
    console.warn(
      `[gilbert] workorder ${uid}: opened gates were not recorded:`,
      errorMessage(err),
    );
    return new Map();
  }
}

/**
 * Set one step's state on the global checklist, or on one group's part.
 *
 * The global checklist is the Master's own and is checked by an administrator
 * or the agent; a group's part is checked by a member of that group. The route
 * gates the request with `requireSession` alone, so the two rules live here,
 * where the caller is known.
 */
export async function checkStep(
  session: LiveSession,
  input: WorkorderCheckInput,
): Promise<WorkorderSummary> {
  const uid = (input?.uid ?? "").trim();
  if (!uid) throw new WorkorderAdminError("bad_request", "A workorder uid is required.");
  const path = (input?.path ?? "").trim();
  if (!path) throw new WorkorderAdminError("bad_request", "A step path is required.");
  const state = input?.state;
  if (!isWorkorderStepState(state))
    throw new WorkorderAdminError(
      "bad_request",
      "A step state must be open, done, skipped or not-applicable.",
    );
  const note = typeof input?.note === "string" ? input.note.trim() : "";
  // One reach for the whole request: the validation, the write, the gate
  // reconcile and the read-back all answer from it, so a check opens the
  // Master's session, probes the groups and resolves the template once.
  const reach = await workorderReach(session);
  // The parts a gates pass read, so the summary the same request composes does
  // not read one per group a second time (empty when nothing was reconciled,
  // which leaves that read whole).
  let readParts = new Map<string, WorkorderFound | null>();
  if (input?.scope === "global") {
    /*
     * The same rule the read uses, asked before the write rather than after it:
     * a caller who may see the workorder may check its global checklist, and one
     * who may not is told the workorder is not there — the answer a hidden
     * workorder gets everywhere else on this surface, so a refusal cannot be
     * used to discover that one exists.
     */
    const found = await findRoot(reach.ctx, reach.accountId, uid);
    if (!found || !(await maySee(reach, found.doc)))
      throw new WorkorderAdminError(
        "workorder_not_found",
        `No workorder "${uid}" is there to check.`,
        404,
      );
    // The document the gates pass reads is the one this write leaves behind:
    // the step is on the root, so its read is already in hand under the
    // compare-and-set's own.
    const written = await applyStep({
      ctx: reach.ctx,
      accountId: reach.accountId,
      uid,
      path,
      state,
      note,
      by: session.username,
    });
    readParts = await recordOpenedGates(reach, uid, written);
  } else if (input?.scope === "group") {
    const group = (input.group ?? "").trim();
    if (!group)
      throw new WorkorderAdminError(
        "bad_request",
        "A group checklist needs the group's name.",
      );
    // The caller's own membership, from the same live read: a name they do not
    // reach is not a group this person may check.
    if (!reach.callerGroups.has(group.toLowerCase()))
      throw new WorkorderAdminError(
        "forbidden",
        `You are not a member of ${group}, so its checklist is not yours to check.`,
        403,
      );
    // The root's state is read from the Master's own account before that: a
    // part carries no state of its own, so the rule -- and the document the
    // gates pass reads, which the part write leaves where it was -- both come
    // from this one read.
    const root = await refuseTerminal(reach.ctx, reach.accountId, uid);
    const groupAccount = reach.masterGroups.get(group.toLowerCase());
    if (!groupAccount) throw groupNotGranted(group, "its checklist cannot be written");
    await applyStep({
      ctx: reach.ctx,
      accountId: groupAccount,
      uid,
      path,
      state,
      note,
      by: session.username,
    });
    readParts = await recordOpenedGates(reach, uid, root);
  } else
    throw new WorkorderAdminError(
      "bad_request",
      'The scope must be "global" or "group".',
    );

  const summary = await readWorkorderWithReach(reach, uid, readParts);
  if (!summary)
    throw new WorkorderAdminError(
      "workorder_not_found",
      `No workorder "${uid}" is there to check.`,
      404,
    );
  return summary;
}

/**
 * Settle one step of a group's checklist, as the agent working that group
 * (ADR 0028, ADR 0031).
 *
 * The same writer as the administration's check (`applyStep`), the same refusal
 * of a closed workorder and the same gate latch; what differs is who is calling:
 * the agent holds a `Ctx` on the Master's account rather than a person's
 * session, and it settles the step in the group its run lives in. The signature
 * is the caller's, so the step says the agent settled it and not a person.
 */
export async function settleStepAsAgent(input: {
  ctx: Ctx;
  accountId: string;
  uid: string;
  path: string;
  state: WorkorderStepState;
  note: string;
  by: string;
}): Promise<WorkorderDoc> {
  const master = filesAccountId(input.ctx);
  if (!master)
    throw new WorkorderAdminError(
      "no_workorder_account",
      "The Master's own account could not be read, so workorders cannot be reached.",
      502,
    );
  const root = await findRoot(input.ctx, master, input.uid);
  if (!root)
    throw new WorkorderAdminError(
      "workorder_not_found",
      `No workorder "${input.uid}" is there to check.`,
      404,
    );
  const written = await applyStep({
    ctx: input.ctx,
    accountId: input.accountId,
    uid: input.uid,
    path: input.path,
    state: input.state,
    note: input.note,
    by: input.by,
  });
  /*
   * The latch lives on the Master's root, which this write does not move: a
   * group's check writes its own part. The reach is built from the account the
   * agent already holds, and every group the Master is granted on is the set a
   * part can live in.
   */
  await recordOpenedGates(
    {
      ctx: input.ctx,
      accountId: master,
      admin: false,
      masterGroups: (await groupAccountsDetailed(input.ctx)).groups,
      callerGroups: new Map(),
      own: new Set(),
      ownAccounts: new Set(),
      defs: new Map(),
    },
    input.uid,
    root.doc,
  );
  return written;
}

/**
 * Move a root between the active folder and `closed/`, keeping its id.
 *
 * The move is a second write after the state change, and it is conditional on
 * the account's FileNode state and retried once, exactly as every other
 * workorder write is: a write that lands first is refused rather than silently
 * overwritten, which is what keeps two closers from racing the folder. A move
 * that still cannot be made throws `workorder_move_failed`; the caller treats
 * that as recoverable, because the folder is a projection of the state and the
 * state is the truth. Exported so a test can make the mock lose the
 * compare-and-set and see the refusal.
 */
export async function moveRoot(
  ctx: Ctx,
  accountId: string,
  nodeId: string,
  parentId: string,
): Promise<void> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = requireState(await appFolderState(ctx, accountId));
    try {
      const res = await updateAppNode(ctx, accountId, nodeId, { parentId }, token);
      const refused = res.notUpdated?.[nodeId];
      if (refused)
        throw new WorkorderAdminError(
          "workorder_move_failed",
          refusalOf(refused) || "The workorder could not be moved.",
          502,
        );
      return;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw new WorkorderAdminError(
    "workorder_move_failed",
    "The workorder could not be moved because another write kept winning the race.",
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
      "A workorder state must be running, completed or cancelled.",
    );
  /*
   * `replaced` is a state and **not** a choice. It is what another workorder
   * says about the one it succeeds, so a door that let a person set it would
   * write a relation nothing stands behind — no successor named, nothing that
   * had replaced anything — and the badge would then read a state no act
   * produced. The successor's own act is what sets it, and that is not built
   * yet (`ROADMAP.md`), so the door refuses rather than accepts a state the
   * surface no longer offers: a menu and a door that disagree is how a control
   * nobody can press becomes a write nobody can explain.
   */
  /*
   * `replaced` names a successor, and this door has no way to name one — so a
   * request that asks for it here is refused rather than honoured. The state is
   * written by `replaceWorkorder`, which creates the successor and sets both
   * facts in the same act; a root marked `replaced` with nobody named would be a
   * relation nothing stands behind.
   */
  if (state === "replaced")
    throw new WorkorderAdminError(
      "replaced_is_not_a_choice",
      "A workorder is replaced by the one that succeeds it, which names that workorder: replace it rather than closing it into that state.",
      409,
    );
  // A workorder is not completed over an unfinished checklist: an open step is
  // done, or explicitly skipped with a reason, first. The guard is here, on the
  // effect, so no surface can complete around it.
  if (state === "completed") {
    const current = await readWorkorder(session, id);
    const openSteps = (current?.parts ?? [])
      .flatMap((part) => part.groups.flatMap((group) => group.items))
      .flatMap((item) => item.steps)
      .filter((step) => step.state === "open").length;
    if (openSteps > 0)
      throw new WorkorderAdminError(
        "workorder_open_steps",
        "The workorder still has open steps: finish them, or set each one skipped with a reason, before completing it.",
        409,
      );
  }
  return setRootState(session, id, state, null);
}

/**
 * Write a terminal state onto a root and move it where that state belongs.
 *
 * One place, because two acts reach it: closing by hand, and being replaced by
 * the workorder that succeeds one. `replacedBy` is written only when the state
 * being written is `replaced`; every other write **preserves** it, which is what
 * the shape asks of a writer (ADR 0028) and what keeps a reopened workorder
 * naming what had succeeded it.
 */
async function setRootState(
  session: LiveSession,
  id: string,
  state: WorkorderState,
  replacedBy: string | null,
): Promise<WorkorderSummary> {
  const { ctx, accountId } = await masterAccount(session);
  const activeId = await ensureFolderPath(ctx, accountId, WORKORDER_FOLDER);
  const closedId = await ensureFolderPath(ctx, accountId, workorderClosedPath());
  const target = isTerminalState(state) ? closedId : activeId;
  const by = session.username;
  const at = new Date().toISOString();
  const found = await writeRootUnderCas(
    ctx,
    accountId,
    id,
    {
      code: "workorder_close_failed",
      message:
        "The workorder could not be closed because another write kept winning the race.",
    },
    (root) => ({
      ...root.doc,
      state,
      ...(state === "replaced" ? { replacedBy } : {}),
      updated: { by, at },
    }),
  );
  /*
   * The folder is a projection of the state, not the state itself, and the move
   * is a second write that can lose to another writer even after the state
   * landed. The state is the truth and is already written, so a move that
   * cannot be made is reported and left recoverable — a reader looks in both
   * folders, and the next close moves the root — rather than turning a closed
   * workorder into a failed request.
   */
  try {
    await moveRoot(ctx, accountId, found.nodeId, target);
  } catch (err) {
    if (!(err instanceof WorkorderAdminError)) throw err;
    console.warn(
      `[gilbert] workorder ${id} was ${state} but its folder could not be moved:`,
      err.message,
    );
  }
  const summary = await readWorkorder(session, id);
  if (!summary)
    throw new WorkorderAdminError("workorder_not_found", `No workorder "${id}".`, 404);
  return summary;
}

/**
 * Take back a successor this call created and then could not hand over.
 *
 * The root is destroyed **first**, so the workorder leaves the registry at once
 * and whatever remains is unreachable by any surface: what a failure here can
 * leave is a part document in a group's account that nothing lists. The reverse
 * order would leave a visible workorder whose checklist is half gone — something
 * a reader can open and act on, and should not have to.
 *
 * `true` means the installation is where it was before the act. `false` is the
 * orphan, and the caller says so by name rather than reporting a success: a
 * successor that exists and that nothing names is a fact somebody has to
 * reconcile, and inventing an outcome for it is worse than the orphan.
 */
async function undoSuccessor(
  session: LiveSession,
  successor: WorkorderSummary,
): Promise<boolean> {
  const { ctx, accountId } = await masterAccount(session);
  const root = await findActive(ctx, accountId, successor.uid);
  if (root) {
    try {
      await destroyAppNode(ctx, accountId, root.nodeId);
    } catch (err) {
      console.warn(
        `[gilbert] workorder ${successor.uid} could not be taken back, so it is there:`,
        errorMessage(err),
      );
      return false;
    }
  }
  let undone = true;
  for (const part of successor.parts) {
    if (part.scope !== "group" || !part.accountId) continue;
    const found = await findActive(ctx, part.accountId, successor.uid);
    if (!found) continue;
    try {
      await destroyAppNode(ctx, part.accountId, found.nodeId);
    } catch (err) {
      undone = false;
      console.warn(
        `[gilbert] workorder ${successor.uid} left a part in ${part.accountId}:`,
        errorMessage(err),
      );
    }
  }
  return undone;
}

/**
 * Replace a workorder with the one that succeeds it.
 *
 * **One act and not two requests.** The successor is created from the input the
 * caller gave — a template, its variants and items, a name: what creation asks
 * for, because this *is* a creation — and the predecessor is then marked
 * `replaced` with `replacedBy` naming it. Nothing is copied from the one it
 * replaces (ADR 0028): the successor is a new workorder that a person chose.
 *
 * **Two writes in two accounts, and Stalwart offers no transaction across
 * them.** So the second failing does not leave a half-done act: the successor
 * this call created — exposed to nobody, named by nobody — is **taken back**, and
 * the request fails with the predecessor untouched. That is what makes the pair
 * all-or-nothing from the outside: either the successor exists and the
 * predecessor names it, or neither fact is there to be seen.
 *
 * The order is the one that can be compensated. Marking first would leave a
 * `replaced` root naming a uid nobody wrote, and no retry can invent it; the
 * other way round, the thing to undo is the thing this call just made.
 *
 * `createWorkorder` is not atomic either — it writes the root and each part in
 * turn — so a failure inside it leaves a successor the caller never got a
 * summary for. That is its own documented behaviour and not this act's to
 * repair; what this act repairs is its own second write.
 */
export async function replaceWorkorder(
  session: LiveSession,
  uid: string,
  input: WorkorderCreateInput,
): Promise<WorkorderSummary> {
  const id = (uid ?? "").trim();
  if (!id) throw new WorkorderAdminError("bad_request", "A workorder uid is required.");
  const predecessor = await readWorkorder(session, id);
  if (!predecessor)
    throw new WorkorderAdminError("workorder_not_found", `No workorder "${id}".`, 404);
  if (isTerminalState(predecessor.state))
    throw new WorkorderAdminError(
      "workorder_already_closed",
      "That workorder is already closed, so nothing succeeds it.",
      409,
    );

  const successor = await createWorkorder(session, input);
  try {
    await setRootState(session, id, "replaced", successor.uid);
  } catch (err) {
    const why = errorMessage(err);
    const undone = await undoSuccessor(session, successor);
    throw new WorkorderAdminError(
      "workorder_replace_failed",
      undone
        ? `The replacement could not be recorded, so it was taken back and nothing has changed: ${why}`
        : `The replacement could not be recorded, and the workorder it created could not be taken back: "${successor.uid}" is there and nothing names it, so it needs a person: ${why}`,
      502,
    );
  }
  return successor;
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
  change: WorkorderRefChange,
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
  await writeRootUnderCas(
    ctx,
    accountId,
    id,
    {
      code: "workorder_ref_failed",
      message:
        "The reference could not be saved because another write kept winning the race.",
    },
    (root) => {
      let refs = root.doc.refs;
      if (remove) refs = refs.filter((ref) => !sameRef(ref, remove));
      if (add && !refs.some((ref) => sameRef(ref, add))) refs = [...refs, add];
      return { ...root.doc, refs, updated: { by, at } };
    },
  );
  const summary = await readWorkorder(session, id);
  if (!summary)
    throw new WorkorderAdminError("workorder_not_found", `No workorder "${id}".`, 404);
  return summary;
}
