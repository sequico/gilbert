/**
 * The knowledge base's durable format (ADR 0024) — one definition, both tiers.
 *
 * The KB is a tree of **articles** and **topic folders** under
 * `gilbert/knowledge` in an account's own app folder: the Master's account for
 * the company's KB, a group's own for a group's. An **article** is a leaf folder
 * named by its title, holding the single mutable `draft.json`, the immutable
 * approved revisions under `revisions/`, and the `state.json` that says which
 * revision is in force and which is still pending its effective instant. A
 * **topic folder** holds no `state.json` — it is pure grouping, with only its
 * own order in a `folder.json` — and `revisions` is the one reserved child name
 * of an article.
 *
 * The web client reads those documents and the server route writes them, so
 * the shape, the validators, the lifecycle arithmetic and the pure text
 * helpers live here rather than twice. Nothing here touches the network or a
 * runtime API beyond `crypto.randomUUID`, which both Node and the browser
 * provide.
 *
 * The same file carries the **wire shapes** the server route answers and the
 * client reads (`KnowledgeTierView`, `KnowledgeArticleView`): a field added on
 * one side and forgotten on the other compiles on both and arrives as
 * `undefined` on one.
 */

import { isRecord } from "./json.js";

/** The folder under the app folder that holds a tier's articles. */
export const KNOWLEDGE_FOLDER = "knowledge";

/** The working document of an article: the one mutable copy everyone edits. */
export const DRAFT_FILE = "draft.json";

/** An article's lifecycle pointer: the revision in force and the one pending. */
export const STATE_FILE = "state.json";

/** The immutable approved revisions of an article, one file each. */
export const REVISIONS_FOLDER = "revisions";

/** A revision file's name inside `revisions/`: `<revision>.json`. */
export function revisionFileName(revision: string): string {
  return `${revision}.json`;
}

export const MAX_TITLE = 200;
export const MAX_TAG = 60;
export const MAX_TAGS = 40;
export const MAX_TEXT = 200_000;

/** Who and when, on every document this KB writes. */
export interface KnowledgeTimes {
  by: string;
  at: string;
}

/**
 * A checklist template's **rules** — the process, as data (ADR 0030).
 *
 * A template is not a form: it is an ordered list of **sections**, each holding
 * steps. *What exists* depends on the **variants** chosen once for a workorder;
 * *how many times* on a **repeat**. A condition names a variant key and a value
 * and may sit on a section or a step, at any depth — so a step inside a repeated
 * section branches on a value chosen at the top, a cross-scope rule a JSON
 * Schema form cannot express. This is the one definition both tiers read; a
 * workorder materialises the applicable steps from it and never copies the text.
 */
export interface KnowledgeChecklist {
  variants: KnowledgeVariant[];
  sections: KnowledgeSection[];
}

/** A choice that varies by case; a workorder picks one value per variant. */
export interface KnowledgeVariant {
  key: string;
  label: string;
  values: KnowledgeVariantValue[];
}

export interface KnowledgeVariantValue {
  value: string;
  label: string;
}

/** The gate on a section or a step: a variant holds one value. */
export interface KnowledgeCondition {
  variant: string;
  equals: string;
}

/** A repeat: the section is instantiated once per item a workorder names. */
export interface KnowledgeRepeat {
  /** What one item is, e.g. "Container". */
  item: string;
  /** Optional per-item data fields (a container number, a seal, a weight). */
  fields: KnowledgeItemField[];
}

export interface KnowledgeItemField {
  key: string;
  label: string;
}

/** One check of a template: the step's stable key and its controlled label. */
export interface KnowledgeStep {
  key: string;
  label: string;
  condition?: KnowledgeCondition;
}

/** One section: steps, an optional condition, repeat and group. */
export interface KnowledgeSection {
  key: string;
  label: string;
  condition?: KnowledgeCondition;
  repeat?: KnowledgeRepeat;
  /** The account id of the group competent for this section; absent = global. */
  group?: string;
  steps: KnowledgeStep[];
}

/** The working draft: identity, the editor's blocks, and the search text. */
export interface KnowledgeDraft {
  v: 1;
  id: string;
  title: string;
  tags: string[];
  /** BlockNote's own block document; opaque to every reader but the editor. */
  blocks: unknown[];
  /** The denormalised plain text: what search and an agent read. */
  text: string;
  /** A checklist template's rules, or null for an ordinary page (ADR 0030). */
  checklist?: KnowledgeChecklist | null;
  created: KnowledgeTimes;
  updated: KnowledgeTimes;
}

/** An issued revision: the draft, frozen, plus what approval records. */
export interface KnowledgeRevision extends KnowledgeDraft {
  revision: string;
  /** The revision's own number, per article: 1, 2, 3 … */
  rev: number;
  approvedBy: string;
  approvedAt: string;
  effectiveAt: string;
  /** The revision this one replaced, or null when it is the first. */
  supersedes: string | null;
}

/** A revision as the lifecycle records it, without its content. */
export interface KnowledgeIssued {
  revision: string;
  /** The revision's own number, per article: 1, 2, 3 …, minted at approval. */
  rev: number;
  effectiveAt: string;
  approvedBy: string;
  approvedAt: string;
  /**
   * The title and tags this revision carries, so a listing can mirror it the
   * instant it becomes the one in force — a pending revision whose date arrives
   * changes what readers see without any write.
   */
  title: string;
  tags: string[];
}

/** An article's mutable lifecycle pointer. */
export interface KnowledgeState {
  v: 1;
  id: string;
  /** Beside the draft so a listing reads only this small document. */
  title: string;
  tags: string[];
  /** The revision readers see now, or null before the first approval. */
  inForce: KnowledgeIssued | null;
  /** A revision approved with a future effective instant, until that instant. */
  pending: KnowledgeIssued | null;
  /**
   * The article's position among its siblings — a free number, so a drag lands
   * between two neighbours without renumbering the rest.
   */
  order: number;
  /**
   * When the article was **retired**: withdrawn from the tree but kept, with
   * its revisions, for traceability. An article that was never approved is
   * destroyed instead; a retired one is found only through a search that asks
   * for it. Null while it stands.
   */
  retired: KnowledgeTimes | null;
  created: KnowledgeTimes;
  updated: KnowledgeTimes;
  /**
   * What the page is a template of — a **checklist** template, whose steps a
   * workorder instantiates — or null for an ordinary page. Derived from the
   * draft's blocks and written down so a listing carries it.
   */
  template?: KnowledgeTemplate | null;
}

/* ------------------------------------------------------------------ */
/* Wire shapes: what the route answers and the client reads            */
/* ------------------------------------------------------------------ */

export type KnowledgeScope = "company" | "group";

/** Where the company KB lives, discovered through the server (Q1's share). */
export interface KnowledgeCompanyView {
  accountId: string;
  folderId: string;
}

/** One article or one topic folder, as a listing shows it. */
export interface KnowledgeSummary {
  /** An article has a draft and, once approved, revisions; a folder is a group. */
  kind: "article" | "folder";
  id: string;
  title: string;
  tags: string[];
  /** The article's folder path within its tier (a leaf name at the root). */
  folder: string;
  /** The article folder node's id. */
  nodeId: string;
  /** The parent article folder's node id, or null at the tier root. */
  parentId: string | null;
  inForce: KnowledgeIssued | null;
  pending: KnowledgeIssued | null;
  /** The in-force revision's own number, or null before the first approval. */
  rev: number | null;
  /** The position among siblings; free, so a drag can land between two. */
  order: number;
  /** When the article was retired, or null while it stands. */
  retired: KnowledgeTimes | null;
  created: KnowledgeTimes | null;
  updated: KnowledgeTimes | null;
  /** What the page is a template of, or null for an ordinary page. */
  template: KnowledgeTemplate | null;
  /** True when a `draft.json` is present; a folder alone is not an article. */
  saved: boolean;
}

/** A revision, as the history column lists it. */
export interface KnowledgeRevisionSummary extends KnowledgeIssued {
  title: string;
  supersedes: string | null;
}

/**
 * One revision, as the history column lists it: identity and metadata, never
 * the content.
 *
 * One projection for both tiers. The server lists the history through the
 * route and the client reads it locally, so a field added on one side only
 * would arrive `undefined` on the other rather than fail to compile.
 */
export function revisionSummary(revision: KnowledgeRevision): KnowledgeRevisionSummary {
  return {
    revision: revision.revision,
    rev: revision.rev,
    effectiveAt: revision.effectiveAt,
    approvedBy: revision.approvedBy,
    approvedAt: revision.approvedAt,
    title: revision.title,
    tags: revision.tags,
    supersedes: revision.supersedes,
  };
}

/** Newest first by approval instant, the one order both tiers list history in. */
export function compareRevisionsNewestFirst(
  a: Pick<KnowledgeRevisionSummary, "approvedAt">,
  b: Pick<KnowledgeRevisionSummary, "approvedAt">,
): number {
  return (Date.parse(b.approvedAt) || 0) - (Date.parse(a.approvedAt) || 0);
}

/** One article opened: its summary, its draft, the revision in force, the history. */
export interface KnowledgeArticleView {
  scope: KnowledgeScope;
  accountId: string;
  summary: KnowledgeSummary;
  draft: KnowledgeDraft | null;
  /** The revision a reader sees now (the pending one once its date is due). */
  effective: KnowledgeRevision | null;
  revisions: KnowledgeRevisionSummary[];
}

/** One tier, as the surface lists it. */
export interface KnowledgeTierView {
  scope: KnowledgeScope;
  accountId: string;
  /** The group's own name (address) for a group tier, null for the company. */
  group: string | null;
  /** Whether the caller is an installation administrator (approval's gate). */
  canApprove: boolean;
  articles: KnowledgeSummary[];
}

export interface KnowledgeTiersView {
  tiers: KnowledgeTierView[];
}

/** What a writer sends to create or save an article. */
export interface KnowledgeArticleInput {
  title: string;
  tags: string[];
  blocks: unknown[];
  text: string;
  /** A checklist template's rules, when the page is one (ADR 0030). */
  checklist?: KnowledgeChecklist | null;
}

/** The tag of a request that names an article: its scope and its folder. */
export interface KnowledgeTarget {
  scope: KnowledgeScope;
  /** The group's name, required when the scope is "group". */
  group?: string;
  /** The article folder's FileNode name. */
  folder?: string;
}

/* ------------------------------------------------------------------ */
/* Validators                                                          */
/* ------------------------------------------------------------------ */

function isTimes(x: unknown): x is KnowledgeTimes {
  return isRecord(x) && typeof x.by === "string" && typeof x.at === "string";
}

function isTags(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((t) => typeof t === "string");
}

export function isKnowledgeIssued(x: unknown): x is KnowledgeIssued {
  return (
    isRecord(x) &&
    typeof x.revision === "string" &&
    typeof x.effectiveAt === "string" &&
    typeof x.approvedBy === "string" &&
    typeof x.approvedAt === "string" &&
    typeof x.rev === "number" &&
    Number.isInteger(x.rev) &&
    x.rev >= 1 &&
    typeof x.title === "string" &&
    isTags(x.tags)
  );
}

function isKnowledgeVariant(x: unknown): x is KnowledgeVariant {
  return (
    isRecord(x) &&
    typeof x.key === "string" &&
    typeof x.label === "string" &&
    Array.isArray(x.values) &&
    x.values.every(
      (v) => isRecord(v) && typeof v.value === "string" && typeof v.label === "string",
    )
  );
}

function isKnowledgeCondition(x: unknown): x is KnowledgeCondition {
  return isRecord(x) && typeof x.variant === "string" && typeof x.equals === "string";
}

function isKnowledgeRepeat(x: unknown): x is KnowledgeRepeat {
  return (
    isRecord(x) &&
    typeof x.item === "string" &&
    Array.isArray(x.fields) &&
    x.fields.every(
      (f) => isRecord(f) && typeof f.key === "string" && typeof f.label === "string",
    )
  );
}

function isKnowledgeStep(x: unknown): x is KnowledgeStep {
  return (
    isRecord(x) &&
    typeof x.key === "string" &&
    typeof x.label === "string" &&
    (x.condition === undefined || isKnowledgeCondition(x.condition))
  );
}

function isKnowledgeSection(x: unknown): x is KnowledgeSection {
  return (
    isRecord(x) &&
    typeof x.key === "string" &&
    typeof x.label === "string" &&
    (x.condition === undefined || isKnowledgeCondition(x.condition)) &&
    (x.repeat === undefined || isKnowledgeRepeat(x.repeat)) &&
    (x.group === undefined || typeof x.group === "string") &&
    Array.isArray(x.steps) &&
    x.steps.every(isKnowledgeStep)
  );
}

export function isKnowledgeChecklist(x: unknown): x is KnowledgeChecklist {
  return (
    isRecord(x) &&
    Array.isArray(x.variants) &&
    x.variants.every(isKnowledgeVariant) &&
    Array.isArray(x.sections) &&
    x.sections.every(isKnowledgeSection)
  );
}

export function isKnowledgeDraft(x: unknown): x is KnowledgeDraft {
  return (
    isRecord(x) &&
    x.v === 1 &&
    typeof x.id === "string" &&
    typeof x.title === "string" &&
    isTags(x.tags) &&
    Array.isArray(x.blocks) &&
    typeof x.text === "string" &&
    (x.checklist === undefined ||
      x.checklist === null ||
      isKnowledgeChecklist(x.checklist)) &&
    isTimes(x.created) &&
    isTimes(x.updated)
  );
}

export function isKnowledgeRevision(x: unknown): x is KnowledgeRevision {
  return (
    isKnowledgeDraft(x) &&
    typeof (x as KnowledgeRevision).revision === "string" &&
    typeof (x as KnowledgeRevision).rev === "number" &&
    Number.isInteger((x as KnowledgeRevision).rev) &&
    (x as KnowledgeRevision).rev >= 1 &&
    typeof (x as KnowledgeRevision).approvedBy === "string" &&
    typeof (x as KnowledgeRevision).approvedAt === "string" &&
    typeof (x as KnowledgeRevision).effectiveAt === "string" &&
    ((x as KnowledgeRevision).supersedes === null ||
      typeof (x as KnowledgeRevision).supersedes === "string")
  );
}

export function isKnowledgeState(x: unknown): x is KnowledgeState {
  return (
    isRecord(x) &&
    x.v === 1 &&
    typeof x.id === "string" &&
    typeof x.title === "string" &&
    isTags(x.tags) &&
    (x.inForce === null || isKnowledgeIssued(x.inForce)) &&
    (x.pending === null || isKnowledgeIssued(x.pending)) &&
    typeof x.order === "number" &&
    Number.isFinite(x.order) &&
    (x.retired === null || isTimes(x.retired)) &&
    (x.template === undefined || x.template === null || x.template === "checklist") &&
    isTimes(x.created) &&
    isTimes(x.updated)
  );
}

/* ------------------------------------------------------------------ */
/* Builders — the only places a document is minted                     */
/* ------------------------------------------------------------------ */

/** Normalise a title into the folder name Files will carry. */
export function knowledgeFolderName(title: string): string {
  const cleaned = String(title ?? "")
    .replace(/\p{Cc}/gu, "")
    .replace(/\//g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, MAX_TITLE)
    .trim();
  return cleaned || "Untitled";
}

/** Whether a folder name is the KB's own reserved child, never an article. */
export function isReservedArticleName(name: string): boolean {
  return name === REVISIONS_FOLDER;
}

/** Trim, dedupe and bound a tag list — the one normaliser. */
export function normalizeKnowledgeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const tag = value.replace(/\s+/g, " ").trim().slice(0, MAX_TAG);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Walk a block document into plain text — what search and agents read. */
export function plainTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const out: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const line = inlineText(block.content);
    if (line) out.push(line);
    const children = plainTextFromBlocks(block.children);
    if (children) out.push(children);
  }
  return out.join("\n").slice(0, MAX_TEXT);
}

function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (typeof item.text === "string") parts.push(item.text);
    else if (item.content) parts.push(inlineText(item.content));
  }
  return parts.join("");
}

/**
 * Mint a block document from plain text.
 *
 * The KB's body is the editor's blocks; an agent or a seed writes text, and
 * this turns it into blocks: a **blank line** separates blocks, a line starting
 * with `# `, `## ` or `### ` is a heading, `- ` or `* ` a bullet and `1. ` a
 * numbered item, and consecutive plain lines fold into one paragraph. Text with
 * none of that is a single paragraph, so a page reads back as what was written
 * rather than as an empty document beside a full `text` field.
 */
export function blocksFromText(text: string): unknown[] {
  const value = String(text ?? "");
  if (!value.trim()) return [];
  const blocks: unknown[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (!paragraph.length) return;
    blocks.push({
      type: "paragraph",
      content: [{ type: "text", text: paragraph.join(" ") }],
    });
    paragraph = [];
  };
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(headingBlock(heading[2] ?? "", heading[1]?.length ?? 1));
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({
        type: "bulletListItem",
        content: [{ type: "text", text: bullet[1] ?? "" }],
      });
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flush();
      blocks.push({
        type: "numberedListItem",
        content: [{ type: "text", text: numbered[1] ?? "" }],
      });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** What a page is a template **of**, or null when it is an ordinary page. */
export type KnowledgeTemplate = "checklist";

/** An empty checklist definition, so a new template has rules to edit. */
export function emptyChecklist(): KnowledgeChecklist {
  return { variants: [], sections: [] };
}

/** Whether a draft defines a checklist template (ADR 0030). */
export function isChecklistTemplate(
  draft: Pick<KnowledgeDraft, "checklist"> | null | undefined,
): boolean {
  return Boolean(draft?.checklist);
}

/** A heading block for a template section, in BlockNote's own shape. */
function headingBlock(text: string, level: number): unknown {
  return {
    type: "heading",
    props: { level },
    content: text ? [{ type: "text", text }] : [],
  };
}

/** A checklist-item block for a template step, in BlockNote's own shape. */
function checklistBlock(id: string, label: string): unknown {
  return {
    type: "checkListItem",
    id,
    props: { checked: false },
    content: label ? [{ type: "text", text: label }] : [],
    children: [],
  };
}

/** The step path of a step in a plain section: `section.step`. */
export function plainStepPath(sectionKey: string, stepKey: string): string {
  return `${sectionKey}.${stepKey}`;
}

/** The step path of a step in one item of a repeated section: `section[item].step`. */
export function itemStepPath(
  sectionKey: string,
  itemKey: string,
  stepKey: string,
): string {
  return `${sectionKey}[${itemKey}].${stepKey}`;
}

/** A condition, as a short readable clause; "" when there is none. */
export function conditionClause(condition: KnowledgeCondition | undefined): string {
  return condition ? `${condition.variant} = ${condition.equals}` : "";
}

/**
 * Build a checklist template's body from its rules (ADR 0030).
 *
 * The rules are the source and the body is the **rendering** every reader walks:
 * a section is a heading and a step a `checkListItem`, with its condition and a
 * repeated section's item named so the rendering is honest about what varies. A
 * repeated section is shown once — it materialises per item in a workorder, not
 * here. `plainTextFromBlocks` of the result is the template's `text`, so search
 * and an agent read the process without a second derivation.
 */
export function checklistBlocks(checklist: KnowledgeChecklist): unknown[] {
  const blocks: unknown[] = [];
  for (const section of checklist.sections) {
    const suffix = [
      section.repeat ? `per ${section.repeat.item}` : "",
      conditionClause(section.condition),
      section.group ? `group ${section.group}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    blocks.push(headingBlock(suffix ? `${section.label} (${suffix})` : section.label, 2));
    for (const step of section.steps) {
      const clause = conditionClause(step.condition);
      blocks.push(
        checklistBlock(
          plainStepPath(section.key, step.key),
          clause ? `${step.label} (${clause})` : step.label,
        ),
      );
    }
  }
  return blocks;
}

/** The group account ids the sections assign, in order of first appearance. */
export function checklistGroups(checklist: KnowledgeChecklist): string[] {
  const out: string[] = [];
  for (const section of checklist.sections) {
    if (section.group && !out.includes(section.group)) out.push(section.group);
  }
  return out;
}

/** One step of a resolved section, with the path a workorder stores. */
export interface ResolvedStep {
  path: string;
  label: string;
}

/** One item of a resolved section: a repeated section's item, or the section. */
export interface ResolvedItem {
  /** The item's key for a repeated section, or "" when the section is not repeated. */
  key: string;
  /** The item's label: the key for a repeated section, the section label otherwise. */
  label: string;
  steps: ResolvedStep[];
}

/** One section of a resolved checklist: the items that apply, with their steps. */
export interface ResolvedSection {
  key: string;
  label: string;
  repeat: KnowledgeRepeat | null;
  items: ResolvedItem[];
}

/** Whether a condition holds under the chosen values. */
function conditionHolds(
  condition: KnowledgeCondition | undefined,
  values: Record<string, string>,
): boolean {
  return condition ? values[condition.variant] === condition.equals : true;
}

/**
 * The sections, items and steps that apply, given a workorder's chosen values.
 *
 * This is the **one** place branching and repeats are resolved, read by a
 * workorder's instantiation and by its view (ADR 0028, ADR 0030). A section
 * whose condition does not hold is left out; a repeated section yields one item
 * per chosen key; a step whose condition does not hold is left out; and a
 * condition resolves against the **same** values wherever it sits — the
 * cross-scope rule a JSON Schema form cannot express.
 */
export function resolveChecklist(
  checklist: KnowledgeChecklist,
  values: Record<string, string>,
  items: Record<string, string[]>,
  /** The part being resolved: a group account id, or null for the global one. */
  target: string | null,
): ResolvedSection[] {
  const out: ResolvedSection[] = [];
  for (const section of checklist.sections) {
    if ((section.group ?? null) !== target) continue;
    if (!conditionHolds(section.condition, values)) continue;
    const steps = section.steps.filter((step) => conditionHolds(step.condition, values));
    const resolved: ResolvedSection = {
      key: section.key,
      label: section.label,
      repeat: section.repeat ?? null,
      items: [],
    };
    if (section.repeat) {
      for (const itemKey of items[section.key] ?? []) {
        resolved.items.push({
          key: itemKey,
          label: itemKey,
          steps: steps.map((step) => ({
            path: itemStepPath(section.key, itemKey, step.key),
            label: step.label,
          })),
        });
      }
    } else {
      resolved.items.push({
        key: "",
        label: section.label,
        steps: steps.map((step) => ({
          path: plainStepPath(section.key, step.key),
          label: step.label,
        })),
      });
    }
    out.push(resolved);
  }
  return out;
}

/** Mint a draft from a writer's input. */
export function buildDraft(input: {
  id: string;
  title: string;
  tags: string[];
  blocks: unknown[];
  text: string;
  by: string;
  at: string;
  created?: KnowledgeTimes;
  checklist?: KnowledgeChecklist | null;
}): KnowledgeDraft {
  const times: KnowledgeTimes = { by: input.by, at: input.at };
  const checklist = input.checklist ?? null;
  // A checklist template's body is **derived** from its rules (ADR 0030): the
  // definition is the one source, so the blocks and the text are the rendering
  // every reader walks rather than a second copy somebody could edit apart.
  const blocks = checklist ? checklistBlocks(checklist) : input.blocks;
  const text = checklist ? plainTextFromBlocks(blocks) : input.text;
  return {
    v: 1,
    id: input.id,
    title: input.title,
    tags: normalizeKnowledgeTags(input.tags),
    blocks,
    text: text.slice(0, MAX_TEXT),
    checklist,
    created: input.created ?? times,
    updated: times,
  };
}

/** Mint an issued revision from the draft an administrator approved. */
export function buildRevision(
  draft: KnowledgeDraft,
  issued: Omit<KnowledgeIssued, "effectiveAt" | "title" | "tags"> & {
    effectiveAt: string;
    supersedes: string | null;
  },
): KnowledgeRevision {
  return {
    ...draft,
    revision: issued.revision,
    rev: issued.rev,
    approvedBy: issued.approvedBy,
    approvedAt: issued.approvedAt,
    effectiveAt: issued.effectiveAt,
    supersedes: issued.supersedes,
  };
}

/** Mint an article's lifecycle document. */
export function buildState(input: {
  id: string;
  title: string;
  tags: string[];
  by: string;
  at: string;
  created?: KnowledgeTimes;
  inForce?: KnowledgeIssued | null;
  pending?: KnowledgeIssued | null;
  retired?: KnowledgeTimes | null;
  order?: number;
  template?: KnowledgeTemplate | null;
}): KnowledgeState {
  const times: KnowledgeTimes = { by: input.by, at: input.at };
  return {
    v: 1,
    id: input.id,
    title: input.title,
    tags: normalizeKnowledgeTags(input.tags),
    inForce: input.inForce ?? null,
    pending: input.pending ?? null,
    retired: input.retired ?? null,
    order: input.order ?? 0,
    created: input.created ?? times,
    updated: times,
    template: input.template ?? null,
  };
}

/** Whether an article has been retired: withdrawn but kept for traceability. */
export function isRetired(state: Pick<KnowledgeState, "retired">): boolean {
  return state.retired !== null;
}

/* ------------------------------------------------------------------ */
/* Lifecycle arithmetic                                                */
/* ------------------------------------------------------------------ */

/** The revision readers see at `now`: the pending one once its date is due. */
export function revisionInForceAt(
  state: Pick<KnowledgeState, "inForce" | "pending">,
  now: Date = new Date(),
): KnowledgeIssued | null {
  const pending = state.pending;
  if (pending && Date.parse(pending.effectiveAt) <= now.getTime()) return pending;
  return state.inForce;
}

/** Whether the pending revision's effective instant has arrived. */
export function pendingIsDue(
  state: Pick<KnowledgeState, "pending">,
  now: Date = new Date(),
): boolean {
  return Boolean(state.pending && Date.parse(state.pending.effectiveAt) <= now.getTime());
}

/**
 * The state after an approval, without any clock: a date already passed puts
 * the revision in force at once, a future date leaves it pending.
 *
 * A future approval names the revision in force at that instant as the one it
 * supersedes, and that revision may itself be a pending one whose date has just
 * arrived. The pending revision it replaces is no longer pointed at: an
 * approval that never took effect is not the record a reader needs, and its own
 * `supersedes` chain is the only trace it leaves.
 */
export function stateAfterApproval(
  state: KnowledgeState,
  issued: KnowledgeIssued,
  now: Date = new Date(),
): KnowledgeState {
  if (Date.parse(issued.effectiveAt) <= now.getTime())
    return { ...state, inForce: issued, pending: null };
  return { ...state, inForce: revisionInForceAt(state, now), pending: issued };
}

/** A fresh opaque id, for an article or a revision. */
export function knowledgeId(): string {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ */
/* The one summary rule, and the one sibling order (both tiers)        */
/* ------------------------------------------------------------------ */

/**
 * A topic folder's own document: it holds no draft and no revisions, so its
 * order lives in a small `folder.json` beside the articles it groups.
 */
export const KNOWLEDGE_FOLDER_FILE = "folder.json";

export interface KnowledgeFolderDoc {
  v: 1;
  order: number;
}

export function isKnowledgeFolderDoc(x: unknown): x is KnowledgeFolderDoc {
  return isRecord(x) && x.v === 1 && typeof x.order === "number";
}

export function buildFolderDoc(order: number): KnowledgeFolderDoc {
  return { v: 1, order };
}

/** The last path segment: a folder's display title when it has no state. */
export function leafFolderName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * The one place a `KnowledgeSummary` is built.
 *
 * The server's listing and the client's read both answer with this shape, and
 * building it twice is how the two drift: which revision a listing mirrors, what
 * a folder's title is, whether a node is an article or a group, and which number
 * it carries are decisions, not one tier's private arithmetic. `state`/`draft`
 * null is a **topic folder** — a group, not a KB article.
 */
export function knowledgeSummary(input: {
  state: KnowledgeState | null;
  draft: KnowledgeDraft | null;
  folder: string;
  nodeId: string;
  parentId: string | null;
  /** A topic folder's own order; ignored when the node is an article. */
  folderOrder?: number;
  saved: boolean;
}): KnowledgeSummary {
  const { state, draft, folder, nodeId, parentId, saved } = input;
  // The listing mirrors the revision a reader sees, selected by the clock: a
  // pending revision whose instant has arrived is what the tree shows, with no
  // write needed at that instant.
  const effective = state ? revisionInForceAt(state) : null;
  return {
    kind: state || draft ? "article" : "folder",
    id: state?.id ?? draft?.id ?? nodeId,
    title: effective?.title ?? state?.title ?? draft?.title ?? leafFolderName(folder),
    tags: effective?.tags ?? state?.tags ?? draft?.tags ?? [],
    folder,
    nodeId,
    parentId,
    inForce: state?.inForce ?? null,
    pending: state?.pending ?? null,
    rev: effective?.rev ?? null,
    order: state?.order ?? input.folderOrder ?? 0,
    retired: state?.retired ?? null,
    created: state?.created ?? draft?.created ?? null,
    updated: state?.updated ?? draft?.updated ?? null,
    template: state?.template ?? null,
    saved,
  };
}

/**
 * The one sibling order, so a tree the server lists and a tree the client
 * builds read the same way: by the free `order` first, then by title.
 */
export function compareKnowledgeSiblings(
  a: Pick<KnowledgeSummary, "order" | "title" | "nodeId">,
  b: Pick<KnowledgeSummary, "order" | "title" | "nodeId">,
): number {
  if (a.order !== b.order) return a.order - b.order;
  const byTitle = a.title.localeCompare(b.title);
  return byTitle !== 0 ? byTitle : a.nodeId.localeCompare(b.nodeId);
}

/**
 * The order a drop between two neighbours takes: the midpoint, or one past an
 * end. `null` on either side means that end of the list.
 */
export function orderBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return Date.now();
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}
