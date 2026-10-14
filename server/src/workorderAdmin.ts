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
import { administrator, openMasterAccount, stateRefuser } from "./adminSession.js";
import { groupAccountsDetailed } from "./agent/actions.js";
import { memberReach } from "./agentAdmin.js";
import {
  appFolderState,
  type Ctx,
  ensureFolderPath,
  type FileNodeLike,
  fileChildren,
  findAppFileAt,
  findFolderPath,
  readAppJsonAt,
  updateAppNode,
  writeAppFileIn,
} from "./appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "./jmap.js";
import { findArticleById } from "./knowledgeAdmin.js";
import type { LiveSession } from "./sessions.js";
import { FILE_PROPS } from "./shared/appFolder.js";
import { refusalOf } from "./shared/jmap.js";
import {
  checklistGroups,
  isKnowledgeRevision,
  isKnowledgeState,
  KNOWLEDGE_FOLDER,
  type KnowledgeChecklist,
  REVISIONS_FOLDER,
  type ResolvedSection,
  resolveChecklist,
  revisionFileName,
  revisionInForceAt,
  STATE_FILE,
} from "./shared/knowledge.js";
import {
  applicableStepPaths,
  buildChecklist,
  buildWorkorderDoc,
  isStepCompleteForGate,
  isTerminalState,
  isWorkorderDoc,
  isWorkorderRef,
  isWorkorderState,
  isWorkorderStepState,
  isWorkorderTemplateRef,
  itemKeysOf,
  stepOf,
  WORKORDER_FOLDER,
  type WorkorderCheckInput,
  type WorkorderChecklist,
  type WorkorderCreateInput,
  type WorkorderDoc,
  type WorkorderGateView,
  type WorkorderGroupView,
  type WorkorderItem,
  type WorkorderPartView,
  type WorkorderRef,
  type WorkorderRefChange,
  type WorkorderScope,
  type WorkorderState,
  type WorkorderStepState,
  type WorkorderStepView,
  type WorkorderSummary,
  type WorkorderTemplateRef,
  workorderClosedPath,
  workorderFileName,
} from "./shared/workorder.js";

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

/**
 * The account's FileNode state as the workorder conditional-write token, or a
 * refusal.
 *
 * The shared helper's sentence and code, raised as this door's own error
 * (`adminSession.ts`); `requireState(state)` stays the shape every workorder
 * write calls, so only the error type is this module's.
 */
export const requireState = stateRefuser(WorkorderAdminError);

/* ------------------------------------------------------------------ */
/* The Master's account, and the caller's own session                  */
/* ------------------------------------------------------------------ */

/**
 * The Master's own account and its session — the workorder acceptance of the
 * shared admin-session door (`adminSession.ts`): the sentence names workorders
 * and the refusal is the workorder surface's own.
 */
function masterAccount(admin: LiveSession): Promise<{ ctx: Ctx; accountId: string }> {
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
interface WorkorderReach {
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
async function workorderReach(session: LiveSession): Promise<WorkorderReach> {
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
  };
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
  await ensureFolderPath(ctx, accountId, workorderClosedPath());
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
  const path = `${workorderClosedPath()}/${workorderFileName(uid)}`;
  const { folderId, file } = await findAppFileAt(ctx, accountId, path);
  if (!folderId || !file || typeof file.id !== "string") return null;
  const doc = await readAppJsonAt(ctx, accountId, path);
  if (!isWorkorderDoc(doc)) return null;
  return { path, folderId, nodeId: file.id, doc };
}

/**
 * Read-modify-write one workorder root under the account's compare-and-set,
 * retried once: JMAP offers no lock, and the state is whole-account, so the
 * retry is what keeps a write from being lost under two writers.
 *
 * `mutate` receives the root as it was read and returns the document to write;
 * a refusal it throws — a missing step, a reference that is not one — leaves
 * the function uncaught and reaches the caller unchanged. When the race is lost
 * twice the surface's own code is thrown, never the raw JMAP `stateMismatch`.
 *
 * What it answers is the root the write left behind: the caller that has to act
 * on the result — the gates pass a check runs next — would otherwise read one
 * document twice more in the same request.
 */
async function writeRootUnderCas(
  ctx: Ctx,
  accountId: string,
  uid: string,
  fail: { code: string; message: string },
  mutate: (found: WorkorderFound) => WorkorderDoc,
): Promise<WorkorderFound> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    // The token is read before the document, so a write landing between the two
    // is refused rather than overwritten.
    const token = requireState(await appFolderState(ctx, accountId));
    const found = await findRoot(ctx, accountId, uid);
    if (!found)
      throw new WorkorderAdminError(
        "workorder_not_found",
        `No workorder "${uid}" is there.`,
        404,
      );
    const next = mutate(found);
    try {
      await writeAppFileIn(ctx, accountId, found.folderId, workorderFileName(uid), next, {
        ifInState: token,
      });
      return { ...found, doc: next };
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw new WorkorderAdminError(fail.code, fail.message, 502);
}

/**
 * The most roots one read of the registry lists.
 *
 * The registry is one document per workorder and nothing prunes it, so a list
 * that read it whole would pay a download per workorder for as long as the
 * installation lives. The surface has no "load more", so the bound is the honest
 * answer for a bigger registry: the newest this many roots, which is what the
 * list has always shown first.
 */
export const WORKORDER_LIST_MAX = 200;

/**
 * The node properties the registry listing needs.
 *
 * `FILE_PROPS` carries the blob to read; the two stamps are what the page is cut
 * on, and they are the pair the Files view sorts a node by — `modified`, falling
 * back to `created`.
 */
const ROOT_NODE_PROPS = [...FILE_PROPS, "created", "modified"];

/** A node's own last-write stamp, the newest-first key the page is chosen by. */
function nodeStamp(node: FileNodeLike): string {
  if (typeof node.modified === "string") return node.modified;
  if (typeof node.created === "string") return node.created;
  return "";
}

/**
 * The newest `WORKORDER_LIST_MAX` roots, and only their documents.
 *
 * The listing carries each node's own last-write stamp, so the page is chosen
 * from it and the documents behind the nodes the page does not need are never
 * read: the registry grows with the installation, and a read that paid a
 * download per root would grow with it too.
 */
async function rootDocs(ctx: Ctx, accountId: string): Promise<WorkorderDoc[]> {
  const candidates: { path: string; node: FileNodeLike }[] = [];
  for (const path of [WORKORDER_FOLDER, workorderClosedPath()]) {
    const folderId = await findFolderPath(ctx, accountId, path);
    if (!folderId) continue;
    const children = await fileChildren(ctx, accountId, folderId, ROOT_NODE_PROPS);
    for (const child of children) {
      // The `closed` directory node sits among the active roots and is dropped
      // by node type; a file that is not a workorder is skipped here too.
      if (child.nodeType !== "file") continue;
      const name = typeof child.name === "string" ? child.name : "";
      if (!name.endsWith(".json")) continue;
      candidates.push({ path: `${path}/${name}`, node: child });
    }
  }
  const newest = candidates
    .sort((a, b) => {
      const stamp = nodeStamp(b.node).localeCompare(nodeStamp(a.node));
      return stamp !== 0 ? stamp : String(b.node.id).localeCompare(String(a.node.id));
    })
    .slice(0, WORKORDER_LIST_MAX);
  const out: WorkorderDoc[] = [];
  for (const { path } of newest) {
    const doc = await readAppJsonAt(ctx, accountId, path);
    if (isWorkorderDoc(doc)) out.push(doc);
  }
  return out;
}

/** A template revision's rules and title as the KB serves them (ADR 0030). */
interface TemplateDef {
  checklist: KnowledgeChecklist | null;
  title: string | null;
  rev: number | null;
}

/**
 * A template revision's rules and title, **resolved once per request**.
 *
 * The same revision is read by the view a read composes (every visible part)
 * and by the gate reconcile a write runs after it; on one request that is the
 * same bytes asked for several times, so the promise is kept on the reach and
 * returned to whoever asks next. The key is the bound reference — the account,
 * the article and the revision it names (ADR 0028) — so two workorders bound to
 * two revisions never share an answer.
 */
function templateDef(
  reach: WorkorderReach,
  template: WorkorderTemplateRef,
): Promise<TemplateDef> {
  const key = `${template.accountId}:${template.id}:${template.revision}`;
  const cached = reach.defs.get(key);
  if (cached) return cached;
  const resolved = readTemplateDef(reach.ctx, template);
  reach.defs.set(key, resolved);
  return resolved;
}

/**
 * The template revision's **rules** and title, read from the KB (ADR 0030).
 *
 * A checklist stores the template's id and revision and never a copy of the
 * controlled text, so every label and every branch is resolved from the
 * revision here. A template that cannot be read — one the Master cannot reach,
 * or a revision that is not there — leaves its rules unresolved and is a
 * finding, not a surface taken down.
 */
async function readTemplateDef(
  ctx: Ctx,
  template: WorkorderTemplateRef,
): Promise<TemplateDef> {
  let title: string | null = null;
  let rev: number | null = null;
  try {
    const tierFolder = await findFolderPath(ctx, template.accountId, KNOWLEDGE_FOLDER);
    if (!tierFolder) return { checklist: null, title, rev };
    const article = await findArticleById(
      ctx,
      template.accountId,
      tierFolder,
      template.id,
    );
    if (!article) return { checklist: null, title, rev };
    const state = await readAppJsonAt(
      ctx,
      template.accountId,
      `${KNOWLEDGE_FOLDER}/${article.folder}/${STATE_FILE}`,
    );
    title = isKnowledgeState(state) ? state.title : null;
    const revision = await readAppJsonAt(
      ctx,
      template.accountId,
      `${KNOWLEDGE_FOLDER}/${article.folder}/${REVISIONS_FOLDER}/${revisionFileName(template.revision)}`,
    );
    if (!isKnowledgeRevision(revision)) return { checklist: null, title, rev };
    rev = revision.rev;
    return { checklist: revision.checklist ?? null, title, rev };
  } catch {
    // A template that cannot be read leaves the rules unresolved; the
    // checklist itself is still served, so the workorder reads rather than
    // disappears.
    return { checklist: null, title, rev };
  }
}

/** The gate state over one whole workorder (ADR 0030). */
interface WorkorderGates {
  /** The sections completed right now, by key. */
  completion: Map<string, boolean>;
  /** The section keys whose gate has already opened. */
  latched: Set<string>;
  /** Section key → label, for the reader's marker. */
  labels: Map<string, string>;
  /**
   * Every section key the template defines. A prerequisite naming no section —
   * one an editor removed — is **tolerated**: the gate is treated as satisfied
   * rather than hiding the section for ever (ADR 0030).
   */
  known: Set<string>;
}

/**
 * One part's resolved sections, right now complete or not, by key.
 *
 * A section is complete when every step of every item it holds has been
 * **settled** — `done`, `skipped` or `not-applicable` (`isStepCompleteForGate`)
 * — or it holds no steps at all, which is complete vacuously. The chosen
 * variants, items and part decide **which** sections materialise here, so a
 * prerequisite the resolver leaves out is absent from this map; `gateOpen`
 * tolerates a prerequisite it cannot see rather than waiting for it for ever
 * (ADR 0030).
 */
function sectionCompletion(
  def: KnowledgeChecklist,
  checklist: WorkorderChecklist,
  target: string | null,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const section of resolveChecklist(
    def,
    checklist.variants,
    itemKeysOf(checklist.items),
    target,
  )) {
    const paths = section.items.flatMap((item) => item.steps.map((step) => step.path));
    out.set(
      section.key,
      paths.every((path) => {
        const instance = stepOf(checklist, path);
        return instance ? isStepCompleteForGate(instance.state) : false;
      }),
    );
  }
  return out;
}

/**
 * Whether one prerequisite of a gate is satisfied.
 *
 * A prerequisite is satisfied when it is complete, and also when it cannot be
 * seen at all: a key the template does not define (an editor removed the
 * section) and a section the resolver never materialised here (the chosen
 * variant excludes it, or its part is not among these) are both tolerated, so a
 * gate never waits for ever on something nothing will ever complete (ADR 0030).
 */
function prerequisiteSatisfied(key: string, gates: WorkorderGates): boolean {
  return !gates.known.has(key) || gates.completion.get(key) !== false;
}

/**
 * Whether a section's gate is open: latched, or every prerequisite satisfied.
 * A prerequisite that is unknown, or that the resolver never computed, is
 * tolerated, never a silent dead end (ADR 0030).
 */
function gateOpen(
  section: { key: string; requires?: string[] },
  gates: WorkorderGates,
): boolean {
  const requires = section.requires ?? [];
  if (!requires.length) return true;
  return (
    gates.latched.has(section.key) ||
    requires.every((key) => prerequisiteSatisfied(key, gates))
  );
}

/** The read-only marker on a visible gated section, or null when it has no gate. */
function openedGate(
  section: ResolvedSection,
  gates: WorkorderGates,
): WorkorderGateView | null {
  const requires = section.requires ?? [];
  if (!requires.length) return null;
  return { requires, labels: requires.map((key) => gates.labels.get(key) ?? key) };
}

/**
 * One checklist's sections as a reader sees them (ADR 0030).
 *
 * The instance's own chosen `variants` and item `key`s are resolved through
 * the template's rules — the one place branching and repeats are decided — and
 * each applicable step is joined with the state the instance stored for it. A
 * **gated** section whose gate has not opened is left out entirely: a group
 * sees a section only once its prerequisites have been completed once. A rule
 * that cannot be read leaves the groups empty: the checklist's own steps are
 * still served, so a workorder reads rather than disappears.
 */
function groupsFor(
  def: KnowledgeChecklist | null,
  checklist: WorkorderChecklist,
  target: string | null,
  gates: WorkorderGates,
): WorkorderGroupView[] {
  if (!def) return [];
  const resolved = resolveChecklist(
    def,
    checklist.variants,
    itemKeysOf(checklist.items),
    target,
  );
  const out: WorkorderGroupView[] = [];
  for (const section of resolved) {
    if (!gateOpen(section, gates)) continue;
    const view: WorkorderGroupView = {
      key: section.key,
      label: section.label,
      repeat: section.repeat ? section.repeat.item : null,
      items: section.items.map((item) => {
        const stored = section.repeat
          ? (checklist.items[section.key] ?? []).find((one) => one.key === item.key)
          : undefined;
        const fields = (section.repeat?.fields ?? []).map((field) => ({
          key: field.key,
          label: field.label,
          value: stored?.data[field.key] ?? "",
        }));
        const steps: WorkorderStepView[] = item.steps.map((step) => {
          const instance = stepOf(checklist, step.path);
          return {
            path: step.path,
            label: step.label,
            state: instance?.state ?? "open",
            by: instance?.by ?? null,
            at: instance?.at ?? null,
            note: instance?.note ?? "",
          };
        });
        return { key: item.key, label: item.label, fields, steps };
      }),
    };
    const gate = openedGate(section, gates);
    if (gate) view.gate = gate;
    out.push(view);
  }
  return out;
}

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

/**
 * One workorder as the caller sees it: the global part from the root, then a
 * part for every group the caller may see.
 *
 * A member sees only their own groups' parts; an administrator sees every part
 * the Master holds, because the route reads them as the Master. A part whose
 * document is gone is omitted — a finding the fleet reconciles, never an empty
 * part. Whether the workorder is the reader's at all is `maySee`'s answer, which
 * competence decides and not this view.
 */
async function summaryOf(
  reach: WorkorderReach,
  root: WorkorderDoc,
  readParts?: Map<string, WorkorderFound | null>,
): Promise<WorkorderSummary> {
  // An administrator sees every part the Master holds; a member sees only the
  // parts of their own groups. Either way the account is the Master's to read.
  const visible = (reach.admin ? [...reach.masterGroups.keys()] : [...reach.own]).sort(
    (a, b) => a.localeCompare(b),
  );
  const global = await templateDef(reach, root.checklist.template);

  /*
   * Every part this caller may see, gathered before the view is composed so
   * the **gate** is decided once over the whole workorder: a section of one
   * part may depend on a section of another (the global checklist or a
   * different group's), and only the sum of all parts says whether it opens.
   */
  interface PartEntry {
    scope: WorkorderScope;
    accountId: string | null;
    group: string | null;
    def: KnowledgeChecklist | null;
    title: string | null;
    rev: number | null;
    checklist: WorkorderChecklist;
    canCheck: boolean;
  }
  const entries: PartEntry[] = [
    {
      scope: "global",
      accountId: null,
      group: null,
      def: global.checklist,
      title: global.title,
      rev: global.rev,
      checklist: root.checklist,
      canCheck: reach.admin,
    },
  ];
  for (const name of visible) {
    const groupAccount = reach.masterGroups.get(name);
    if (!groupAccount) continue;
    // A part this request has already read -- the gates pass a check runs reads
    // them all -- is not read a second time. A group the map never looked at is
    // read here, which is the whole of the common case.
    const part = readParts?.has(groupAccount)
      ? (readParts.get(groupAccount) ?? null)
      : await findActive(reach.ctx, groupAccount, root.uid);
    if (!part) continue;
    const info = await templateDef(reach, part.doc.checklist.template);
    entries.push({
      scope: "group",
      accountId: groupAccount,
      group: name,
      def: info.checklist,
      title: info.title,
      rev: info.rev,
      checklist: part.doc.checklist,
      canCheck: reach.own.has(name),
    });
  }

  /*
   * The gate over the whole workorder. Completion is read across every part; a
   * section key is unique in the template, so one map serves them all. The
   * ladder is the root's: a gate that opened stays open even if its
   * prerequisite is reopened later (ADR 0030).
   */
  const gates: WorkorderGates = {
    completion: new Map<string, boolean>(),
    latched: new Set(root.gates ?? []),
    labels: new Map<string, string>(),
    known: new Set<string>(),
  };
  for (const entry of entries) {
    if (!entry.def) continue;
    for (const section of entry.def.sections) {
      gates.known.add(section.key);
      if (!gates.labels.has(section.key)) gates.labels.set(section.key, section.label);
    }
    for (const [key, complete] of sectionCompletion(
      entry.def,
      entry.checklist,
      entry.accountId,
    ))
      gates.completion.set(key, complete);
  }

  const parts: WorkorderPartView[] = entries.map((entry) => ({
    scope: entry.scope,
    accountId: entry.accountId,
    group: entry.group,
    checklist: entry.checklist,
    groups: groupsFor(entry.def, entry.checklist, entry.accountId, gates),
    templateTitle: entry.title,
    templateRev: entry.rev,
    canCheck: entry.canCheck,
  }));

  return {
    uid: root.uid,
    name: root.name ?? "",
    state: root.state ?? "running",
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
 * Any workorder in the registry is an administrator's to see. A member reaches
 * their groups, not the Master's registry (ADR 0028) — and what makes a
 * workorder theirs is
 * **competence**: the template assigns a section to a group they are in
 * (ADR 0030), so that group is what the workorder is for. Membership therefore
 * decides this, not the accident of whether the group's part document can be
 * read right now: a part whose document is gone is a finding the fleet
 * reconciles and is simply not there in the view (ADR 0028), never a reason the
 * workorder — and with it the global checklist the member is entitled to read —
 * disappears. A template whose rules cannot be read falls back to the part
 * itself, which is the one thing that is known to be there.
 *
 * The reference the root carries names the revision whose assignments decide
 * this, so the answer is read from the root and its template alone — a hidden
 * workorder has no group's part probed for it and no summary composed. The same
 * answer whether the workorder is listed or read by uid.
 */
async function maySee(reach: WorkorderReach, root: WorkorderDoc): Promise<boolean> {
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
  if (def)
    return checklistGroups(def).some((accountId) => reach.ownAccounts.has(accountId));
  // A template whose rules cannot be read falls back to the part a group
  // already holds (ADR 0028).
  for (const accountId of reach.ownAccounts) {
    if (await findActive(reach.ctx, accountId, root.uid)) return true;
  }
  return false;
}

/** The newest page of what the caller may see, newest write first. */
export async function listWorkorders(session: LiveSession): Promise<WorkorderSummary[]> {
  const reach = await workorderReach(session);
  const roots = await rootDocs(reach.ctx, reach.accountId);
  const out: WorkorderSummary[] = [];
  for (const root of roots) {
    if (!(await maySee(reach, root))) continue;
    out.push(await summaryOf(reach, root));
  }
  out.sort((a, b) => b.updated.at.localeCompare(a.updated.at));
  return out;
}

/** One workorder by uid, or null when the caller may not see it. */
export async function readWorkorder(
  session: LiveSession,
  uid: string,
): Promise<WorkorderSummary | null> {
  const reach = await workorderReach(session);
  return readWorkorderWithReach(reach, uid);
}

/**
 * One workorder by uid under a reach the caller already built.
 *
 * The write path resolves the reach once and reads the summary back through
 * this, so a check does not open a second Master session and a second probe
 * pass over the caller's groups just to answer with what it already holds. The
 * parts that same request already read travel in with it for the same reason.
 */
async function readWorkorderWithReach(
  reach: WorkorderReach,
  uid: string,
  readParts?: Map<string, WorkorderFound | null>,
): Promise<WorkorderSummary | null> {
  const id = (uid ?? "").trim();
  if (!id) return null;
  const root = await findRoot(reach.ctx, reach.accountId, id);
  if (!root) return null;
  // Visibility first, the same as the list: a workorder the caller may not see
  // is not composed at all.
  if (!(await maySee(reach, root.doc))) return null;
  return summaryOf(reach, root.doc, readParts);
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
      throw new WorkorderAdminError(
        "group_not_granted",
        "The installation's agent is not a member of the group a section is assigned to, so its part cannot be written.",
        409,
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
      (err as Error).message,
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
    if (!reach.admin)
      throw new WorkorderAdminError(
        "forbidden",
        "Only an installation administrator checks the global checklist.",
        403,
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
    if (!groupAccount)
      throw new WorkorderAdminError(
        "group_not_granted",
        `The installation's agent is not a member of ${group}, so its checklist cannot be written.`,
        409,
      );
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
      "A workorder state must be running, completed, cancelled or replaced.",
    );
  const { ctx, accountId } = await masterAccount(session);
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
    (root) => ({ ...root.doc, state, updated: { by, at } }),
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
