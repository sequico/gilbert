/**
 * The registry walk and the view a caller reads.
 *
 * The newest roots are listed from the nodes' own stamps, and one workorder is
 * composed from the Master's root and every part the caller may see.
 */

import {
  type Ctx,
  ensureFolderPath,
  type FileNodeLike,
  fileChildren,
  findFolderPath,
  nodeStamp,
  readAppJsonAt,
  STAMP_PROPS,
} from "../appFolder.js";
import type { LiveSession } from "../sessions.js";
import { FILE_PROPS } from "../shared/appFolder.js";
import { mapLimit, READ_CONCURRENCY } from "../shared/concurrency.js";
import {
  type KnowledgeChecklist,
  type ResolvedSection,
  resolveChecklist,
} from "../shared/knowledge.js";
import {
  checklistGroups,
  isStepComplete,
  isStepCompleteForGate,
  isWorkorderDoc,
  itemKeysOf,
  stepOf,
  WORKORDER_FOLDER,
  type WorkorderChecklist,
  type WorkorderDoc,
  type WorkorderGateView,
  type WorkorderGroupView,
  type WorkorderListEntry,
  type WorkorderListPart,
  type WorkorderPartView,
  type WorkorderScope,
  type WorkorderStepView,
  type WorkorderSummary,
  workorderClosedPath,
} from "../shared/workorder.js";
import { findActive, findRoot, type WorkorderFound } from "./documents.js";
import { maySee, type WorkorderReach, workorderReach } from "./reach.js";
import { templateDef } from "./templates.js";

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
 * back to `created` (`STAMP_PROPS`).
 */
const ROOT_NODE_PROPS = [...FILE_PROPS, ...STAMP_PROPS];

/**
 * The newest `WORKORDER_LIST_MAX` roots, and only their documents.
 *
 * The listing carries each node's own last-write stamp, so the page is chosen
 * from it and the documents behind the nodes the page does not need are never
 * read: the registry grows with the installation, and a read that paid a
 * download per root would grow with it too.
 *
 * The page answers with what it left out as well: `total` is how many roots the
 * registry holds, and `unreadable` names the documents that did not read as this
 * build's — a workorder that cannot be read is said rather than made to
 * disappear, or a broken document reads as one that was never opened.
 */
interface RootPage {
  docs: WorkorderDoc[];
  total: number;
  truncated: boolean;
  unreadable: string[];
}

async function rootDocs(ctx: Ctx, accountId: string): Promise<RootPage> {
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
  // The page's documents are independent, so they are fetched together: in
  // series the registry costs one round trip per workorder on a cold read.
  const read = await mapLimit(newest, READ_CONCURRENCY, async ({ path }) => ({
    path,
    doc: await readAppJsonAt(ctx, accountId, path),
  }));
  return {
    docs: read
      .map((one) => one.doc)
      .filter((doc): doc is WorkorderDoc => isWorkorderDoc(doc)),
    total: candidates.length,
    truncated: candidates.length > newest.length,
    unreadable: read.filter((one) => !isWorkorderDoc(one.doc)).map((one) => one.path),
  };
}

/** The gate state over one whole workorder (ADR 0026). */
export interface WorkorderGates {
  /** The sections completed right now, by key. */
  completion: Map<string, boolean>;
  /** The section keys whose gate has already opened. */
  latched: Set<string>;
  /** Section key → label, for the reader's marker. */
  labels: Map<string, string>;
  /**
   * Every section key the template defines. A prerequisite naming no section —
   * one an editor removed — is **tolerated**: the gate is treated as satisfied
   * rather than hiding the section for ever (ADR 0026).
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
 * (ADR 0026).
 */
export function sectionCompletion(
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
 * gate never waits for ever on something nothing will ever complete (ADR 0026).
 */
function prerequisiteSatisfied(key: string, gates: WorkorderGates): boolean {
  return !gates.known.has(key) || gates.completion.get(key) !== false;
}

/**
 * Whether a section's gate is open: latched, or every prerequisite satisfied.
 * A prerequisite that is unknown, or that the resolver never computed, is
 * tolerated, never a silent dead end (ADR 0026).
 */
export function gateOpen(
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
 * One checklist's sections as a reader sees them (ADR 0026).
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

/** One part this caller may see, gathered before a view is composed. */
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

/**
 * Every part the caller may see: the global one from the root, then one per
 * group they reach.
 *
 * A member sees only their own groups' parts; an administrator sees every part
 * the Master holds, because the route reads them as the Master. A part whose
 * document is gone is omitted, never answered as an empty part.
 */
async function partEntries(
  reach: WorkorderReach,
  root: WorkorderDoc,
  readParts?: Map<string, WorkorderFound | null>,
): Promise<PartEntry[]> {
  /*
   * A part exists for exactly the groups the template's sections are assigned to
   * (`maySee` rests on the same fact), so the groups worth reading are those:
   * reading every group the Master holds paid a lookup per group for parts that
   * cannot exist, on every workorder and every row of the list. A template whose
   * rules cannot be read falls back to what the caller reaches, as before.
   */
  const global = await templateDef(reach, root.checklist.template);
  const assigned = global.checklist ? new Set(checklistGroups(global.checklist)) : null;
  // An administrator sees every part the Master holds; a member sees only the
  // parts of their own groups. Either way the account is the Master's to read.
  const visible = (reach.admin ? [...reach.masterGroups.keys()] : [...reach.own])
    .filter((name) => {
      if (!assigned) return true;
      const groupAccount = reach.masterGroups.get(name);
      return groupAccount !== undefined && assigned.has(groupAccount);
    })
    .sort((a, b) => a.localeCompare(b));

  const entries: PartEntry[] = [
    {
      scope: "global",
      accountId: null,
      group: null,
      def: global.checklist,
      title: global.title,
      rev: global.rev,
      checklist: root.checklist,
      /*
       * Whoever may see a part may check it, and the global part is the one
       * every reader of the workorder sees — so this is `true` and not a role.
       * What a step carries is **who signed it** (`by`, taken from the
       * session), which is what makes the check an accountable act rather than
       * a privileged one: the signature says who asserted it, and a
       * checklist's reader can see whether that is the person they expected.
       * Administration is a rule about **templates** (only an administrator
       * approves one, ADR 0020) and has nothing to say about a workorder.
       */
      canCheck: true,
    },
  ];
  /*
   * The group parts are independent documents: they are read a bounded few at
   * a time rather than one after another, so a workorder with several parts
   * does not cost several round trips.
   */
  const parts = await mapLimit(visible, READ_CONCURRENCY, async (name) => {
    const groupAccount = reach.masterGroups.get(name);
    if (!groupAccount) return null;
    // A part this request has already read -- the gates pass a check runs reads
    // them all -- is not read a second time. A group the map never looked at is
    // read here, which is the whole of the common case.
    const part = readParts?.has(groupAccount)
      ? (readParts.get(groupAccount) ?? null)
      : await findActive(reach.ctx, groupAccount, root.uid);
    if (!part) return null;
    const info = await templateDef(reach, part.doc.checklist.template);
    const entry: PartEntry = {
      scope: "group",
      accountId: groupAccount,
      group: name,
      def: info.checklist,
      title: info.title,
      rev: info.rev,
      checklist: part.doc.checklist,
      canCheck: reach.own.has(name),
    };
    return entry;
  });
  for (const part of parts) if (part) entries.push(part);
  return entries;
}

/**
 * The gate over the whole workorder.
 *
 * Completion is read across every part; a section key is unique in the
 * template, so one map serves them all. The ladder is the root's: a gate that
 * opened stays open even if its prerequisite is reopened later (ADR 0026).
 */
function gatesFor(root: WorkorderDoc, entries: PartEntry[]): WorkorderGates {
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
  return gates;
}

/**
 * One workorder as the caller sees it, with its checklist.
 *
 * Whether the workorder is the reader's at all is `maySee`'s answer, which
 * competence decides and not this view.
 */
async function summaryOf(
  reach: WorkorderReach,
  root: WorkorderDoc,
  readParts?: Map<string, WorkorderFound | null>,
): Promise<WorkorderSummary> {
  const entries = await partEntries(reach, root, readParts);
  const gates = gatesFor(root, entries);
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
    replacedBy: root.replacedBy ?? null,
    canAdminister: reach.admin,
  };
}

/**
 * One workorder as the list shows it: the same visibility and the same
 * progress, and no checklist.
 *
 * The numbers are the ones the open panel draws (`partProgress` reads the same
 * steps), decided through the same gate — so a card and the part it opens
 * cannot disagree about how far along the work is.
 */
async function listEntryOf(
  reach: WorkorderReach,
  root: WorkorderDoc,
  readParts?: Map<string, WorkorderFound | null>,
): Promise<WorkorderListEntry> {
  const entries = await partEntries(reach, root, readParts);
  const gates = gatesFor(root, entries);
  const parts: WorkorderListPart[] = entries.map((entry) => {
    const groups = groupsFor(entry.def, entry.checklist, entry.accountId, gates);
    let complete = 0;
    let total = 0;
    for (const group of groups) {
      for (const item of group.items) {
        for (const step of item.steps) {
          total += 1;
          if (isStepComplete(step.state)) complete += 1;
        }
      }
    }
    return {
      scope: entry.scope,
      accountId: entry.accountId,
      group: entry.group,
      template: entry.checklist.template,
      templateTitle: entry.title,
      templateRev: entry.rev,
      complete,
      total,
    };
  });
  return {
    uid: root.uid,
    name: root.name ?? "",
    state: root.state ?? "running",
    parts,
    updated: root.updated,
    replacedBy: root.replacedBy ?? null,
    canAdminister: reach.admin,
  };
}

/** One page of what the caller may see, newest write first, and what it left out. */
export interface WorkorderListPage {
  workorders: WorkorderListEntry[];
  /** How many roots the registry holds, before the page was cut. */
  total: number;
  truncated: boolean;
  /** Registry documents that did not read as this build's, by path. */
  problems: string[];
}

export async function listWorkorders(session: LiveSession): Promise<WorkorderListPage> {
  const reach = await workorderReach(session);
  const roots = await rootDocs(reach.ctx, reach.accountId);
  /*
   * One listing of each registry folder the page will read, before the page is
   * composed: the level memory holds an answer rather than a promise, so
   * parallel readers would otherwise ask the same folder while the first
   * answer is still in flight.
   */
  if (roots.docs.length > 1) {
    const accounts = reach.admin
      ? [...reach.masterGroups.values()]
      : [...reach.own].flatMap((name) => {
          const accountId = reach.masterGroups.get(name);
          return accountId ? [accountId] : [];
        });
    const props = [...FILE_PROPS, ...STAMP_PROPS];
    await mapLimit(accounts, READ_CONCURRENCY, async (accountId) => {
      const folderId = await findFolderPath(reach.ctx, accountId, WORKORDER_FOLDER);
      if (folderId) await fileChildren(reach.ctx, accountId, folderId, props);
    });
  }
  /*
   * The roots are independent, so they are composed together, a bounded few at
   * a time: in series the list cost one round trip per workorder, and it is
   * re-read on every change the rail carries.
   */
  const entries = await mapLimit(roots.docs, READ_CONCURRENCY, async (root) =>
    (await maySee(reach, root)) ? await listEntryOf(reach, root) : null,
  );
  const out = entries.filter((entry): entry is WorkorderListEntry => entry !== null);
  out.sort((a, b) => b.updated.at.localeCompare(a.updated.at));
  return {
    workorders: out,
    total: roots.total,
    truncated: roots.truncated,
    problems: roots.unreadable,
  };
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
export async function readWorkorderWithReach(
  reach: WorkorderReach,
  uid: string,
  readParts?: Map<string, WorkorderFound | null>,
  /**
   * The root the caller already holds — a write's own answer. A step write has
   * just read or written it, and reading it again would download the document
   * it produced; a caller with nothing in hand leaves this out.
   */
  held?: WorkorderDoc,
): Promise<WorkorderSummary | null> {
  const id = (uid ?? "").trim();
  if (!id) return null;
  const root = held ?? (await findRoot(reach.ctx, reach.accountId, id))?.doc;
  if (!root) return null;
  // Visibility first, the same as the list: a workorder the caller may not see
  // is not composed at all.
  if (!(await maySee(reach, root))) return null;
  return summaryOf(reach, root, readParts);
}
