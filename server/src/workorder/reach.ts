/**
 * The Master's account, the caller's own session, and what a caller may see.
 *
 * The Master does every read and every write; the caller's group membership
 * decides, per request, which parts of a workorder they reach (ADR 0017).
 */

import { administrator, openMasterAccount } from "../adminSession.js";
import type { Ctx } from "../appFolder.js";
import { groupAccountsDetailed, memberReach } from "../groupAccess.js";
import type { LiveSession } from "../sessions.js";
import { checklistGroups, checklistHasGlobalSection } from "../shared/knowledge.js";
import type { WorkorderDoc } from "../shared/workorder.js";
import { findActive } from "./documents.js";
import { WorkorderAdminError } from "./errors.js";
import { type TemplateDef, templateDef } from "./templates.js";

/* ------------------------------------------------------------------ */
/* The Master's account, and the caller's own session                  */
/* ------------------------------------------------------------------ */

/**
 * The Master's own account and its session — the workorder acceptance of the
 * shared admin-session door (`adminSession.ts`): the sentence names workorders
 * and the refusal is the workorder surface's own.
 */
export function masterAccount(
  admin: LiveSession,
): Promise<{ ctx: Ctx; accountId: string }> {
  return openMasterAccount(admin, {
    what: "workorders",
    missingCode: "no_workorder_account",
    missingMessage:
      "The Master's own account could not be read, so workorders cannot be reached.",
    files: true,
    refuse: (code, message, status) => new WorkorderAdminError(code, message, status),
  });
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
export interface WorkorderReach {
  ctx: Ctx;
  accountId: string;
  admin: boolean;
  /** Every group the Master holds, by name, with the account each answers as. */
  masterGroups: Map<string, string>;
  /** Every group the caller's own session reaches, by name (ADR 0005, live). */
  callerGroups: Map<string, string>;
  /** The groups the caller is a member of: the parts they may check. */
  own: Set<string>;
  /**
   * Those same groups by account id. A workorder's competence is read from the
   * template's assignments (ADR 0030), which name accounts, so the two are
   * compared on the account id rather than on the name.
   */
  ownAccounts: Set<string>;
  /** One template revision's rules per request, resolved once (see `templateDef`). */
  defs: Map<string, Promise<TemplateDef>>;
  /**
   * One template article's folder path per request, by account and article id.
   *
   * Finding an article by id walks the knowledge tree, and two workorders bound
   * to two revisions of one template ask the same walk: the folder is resolved
   * once and the revision is read from it.
   */
  articleFolders: Map<string, Promise<string | null>>;
}

/**
 * Everything one request needs, read **once**.
 *
 * The caller's own groups are read with a single `memberReach` — one live
 * session and one probe pass — rather than once per group: the answer cannot
 * differ between calls, and asking it for every group the Master holds made a
 * read pay for the whole group set over and over (the check's slowness).
 * The Master's session, its groups and the caller's groups are therefore
 * resolved here and carried through the request, so the read that composes the
 * view and the gate reconcile that follows a write share them instead of
 * opening a second Master session and a second probe pass.
 */
export async function workorderReach(session: LiveSession): Promise<WorkorderReach> {
  const admin = await administrator(session);
  const { ctx, accountId } = await masterAccount(session);
  const masterGroups = (await groupAccountsDetailed(ctx)).groups;
  const mine = await memberReach(session);
  const own = new Set<string>();
  const ownAccounts = new Set<string>();
  for (const name of masterGroups.keys()) {
    if (!mine.groups.has(name)) continue;
    const groupAccount = masterGroups.get(name);
    if (!groupAccount) continue;
    own.add(name);
    ownAccounts.add(groupAccount);
  }
  return {
    ctx,
    accountId,
    admin,
    masterGroups,
    callerGroups: mine.groups,
    own,
    ownAccounts,
    defs: new Map(),
    articleFolders: new Map(),
  };
}

/**
 * Whether a caller may see a workorder at all.
 *
 * Any workorder in the registry is an administrator's to see. For everybody
 * else the template's assignment of its sections decides it (ADR 0030), and the
 * two halves of that answer are two different questions: a section assigned to
 * **no** group is global and makes the workorder **every user's**, while a
 * workorder whose sections are all assigned is its groups' alone, reached by
 * their members. A member does not reach the Master's registry (ADR 0028).
 *
 * Either answer is read from the template, not from the accident of whether a
 * group's part document can be read right now: a part whose document is gone is
 * simply not there in the view, never a reason the workorder — and with it the
 * global checklist its readers are entitled to — disappears. A template whose
 * rules cannot be read falls back to what the documents themselves say: the root
 * **is** the global checklist, so a root carrying steps answers for a workorder
 * with a global section, and one carrying none leaves it to the part a group
 * already holds.
 *
 * The reference the root carries names the revision whose assignments decide
 * this, so the answer is read from the root and its template alone — a hidden
 * workorder has no group's part probed for it and no summary composed. The same
 * answer whether the workorder is listed or read by uid.
 */
export async function maySee(
  reach: WorkorderReach,
  root: WorkorderDoc,
): Promise<boolean> {
  if (reach.admin) return true;
  const def = (await templateDef(reach, root.checklist.template)).checklist;
  /*
   * A template's own assignment is the whole of competence, and it is the same
   * set of groups a part is written for at creation — so a readable template
   * answers without reading a group's part at all. What carries that equality is
   * an invariant nothing else enforces: **a root's template reference is written
   * once, at creation, and never changes** (`createWorkorder` is its only
   * writer, and no route re-binds one), so the parts that exist are exactly the
   * groups the revision it names assigns. Re-pin a live workorder to another
   * revision and a member whose part holds the finished work would lose the
   * workorder, silently: their template no longer names their group. The
   * fallback below is the part-probe for the case the template cannot be read;
   * it is not a substitute for that invariant.
   */
  if (def) {
    /*
     * A section assigned to no group is the workorder's own, and a workorder
     * carrying one is **everybody's to see** (ADR 0028): the global section is
     * the part of the process the whole installation shares, so seeing which
     * workorders are running is not a fact a group can own. Competence answers
     * only for a workorder that is entirely groups'.
     */
    if (checklistHasGlobalSection(def)) return true;
    return checklistGroups(def).some((accountId) => reach.ownAccounts.has(accountId));
  }
  /*
   * A template whose rules cannot be read falls back to what the documents
   * themselves say (ADR 0028). The root **is** the global checklist — creation
   * instantiates the unassigned sections' steps there and each assigned group's
   * in its part — so a root carrying steps is a workorder with a global section,
   * and answers as one. A root carrying none leaves the question to the part a
   * group already holds. The steps are the narrower reading of the two, which is
   * the right way to be wrong: a section whose steps a variant closed is not
   * read as global, so this can only fail to widen, never widen wrongly.
   */
  if (root.checklist.steps.length) return true;
  for (const accountId of reach.ownAccounts) {
    if (await findActive(reach.ctx, accountId, root.uid)) return true;
  }
  return false;
}
