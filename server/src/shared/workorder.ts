/**
 * The workorder's durable format (ADR 0028) — one definition, both tiers.
 *
 * A workorder is one **uid** and everything about it is a document named
 * `<uid>.json` under `workorders/` in an account's `gilbert` app folder. The
 * **Master's** copy is the workorder's **root** — its identity, its friendly
 * name, its **global checklist** and its state — and the Master's `workorders/`
 * folder is the registry; a terminal state moves the root to `workorders/closed/`
 * and it is kept for ever. A **group's** copy, in that group's own account, is
 * the group's **part**: its checklist and its own references. The same uid names
 * every copy; the account decides which role a document has.
 *
 * A checklist is an **instance of a KB template** (ADR 0024): it stores the
 * template's id and the revision it was bound to, the **values chosen** for the
 * template's variants, the **items chosen** for its repeated sections, and each
 * applicable step's **path**, state and last signature — never a copy of the
 * controlled text, which is read from the template revision. A step's path
 * carries the repetition (`loading[CONT-1].seal`), so the same step in two
 * containers is two entries and never collides. This module carries the shape,
 * its validators, the pure helpers and the wire views the route answers, so the
 * client and the server cannot drift.
 */

import { isRecord } from "./json.js";

export const WORKORDER_FOLDER = "workorders";
export const WORKORDER_CLOSED_FOLDER = "closed";

/** The path, under the app folder, of the closed registry. One definition. */
export function workorderClosedPath(): string {
  return `${WORKORDER_FOLDER}/${WORKORDER_CLOSED_FOLDER}`;
}

/** Every state a workorder reaches. Only the root carries one. */
export type WorkorderState = "running" | "completed" | "cancelled" | "replaced";

export const WORKORDER_STATES: readonly WorkorderState[] = [
  "running",
  "completed",
  "cancelled",
  "replaced",
];

/** The states a workorder does not leave: the root moves to `closed/`. */
export const WORKORDER_TERMINAL_STATES: readonly WorkorderState[] = [
  "completed",
  "cancelled",
  "replaced",
];

export function isTerminalState(state: WorkorderState): boolean {
  return WORKORDER_TERMINAL_STATES.includes(state);
}

export interface WorkorderTimes {
  by: string;
  at: string;
}

/** The KB article and the revision a checklist is bound to, by id. */
export interface WorkorderTemplateRef {
  accountId: string;
  id: string;
  revision: string;
}

/**
 * Every state one step reaches.
 *
 * `open` and `done` are the check itself; **`skipped`** is a step a person
 * declares not actually done but which counts as done (the job moves on with a
 * stated reason); **`not-applicable`** is a step that does apply but which the
 * person says the case does not need — dimmed and out of progress.
 */
export type WorkorderStepState = "open" | "done" | "skipped" | "not-applicable";

export const WORKORDER_STEP_STATES: readonly WorkorderStepState[] = [
  "open",
  "done",
  "skipped",
  "not-applicable",
];

/** The states that count as complete for progress: done, and skipped. */
export function isStepComplete(state: WorkorderStepState): boolean {
  return state === "done" || state === "skipped";
}

/** One step's operational state — never the controlled text, which the KB holds. */
export interface WorkorderStep {
  /** The step's path in the template, repeats expanded: `section[item].step`. */
  path: string;
  state: WorkorderStepState;
  /** The last signature: who set the state, or null when never touched. */
  by: string | null;
  at: string | null;
  /** Why a step was skipped or set not applicable; free text, optional. */
  note: string;
}

/** One chosen item of a repeated section: its key and its optional data. */
export interface WorkorderItem {
  key: string;
  /** The item's data values, keyed by the template's field keys. */
  data: Record<string, string>;
}

export interface WorkorderChecklist {
  template: WorkorderTemplateRef;
  /** The chosen value per template variant key. */
  variants: Record<string, string>;
  /** The chosen items per repeated section key. */
  items: Record<string, WorkorderItem[]>;
  steps: WorkorderStep[];
}

/** What a reference points at: a folder, a file, or a KB article. */
export type WorkorderRefKind = "folder" | "file" | "kb";

export interface WorkorderRef {
  accountId: string;
  kind: WorkorderRefKind;
  id: string;
}

export interface WorkorderDoc {
  v: 1;
  uid: string;
  /** The friendly name — on the root; a part does not carry it. */
  name?: string;
  /** The state — on the root. */
  state?: WorkorderState;
  /** The successor's uid, when the state is `replaced`. */
  replacedBy?: string | null;
  checklist: WorkorderChecklist;
  refs: WorkorderRef[];
  created: WorkorderTimes;
  updated: WorkorderTimes;
}

export function workorderFileName(uid: string): string {
  return `${uid}.json`;
}

/* ------------------------------------------------------------------ */
/* Validators                                                          */
/* ------------------------------------------------------------------ */

function isTimes(x: unknown): x is WorkorderTimes {
  return isRecord(x) && typeof x.by === "string" && typeof x.at === "string";
}

export function isWorkorderState(x: unknown): x is WorkorderState {
  return typeof x === "string" && (WORKORDER_STATES as readonly string[]).includes(x);
}

export function isWorkorderStepState(x: unknown): x is WorkorderStepState {
  return (
    typeof x === "string" && (WORKORDER_STEP_STATES as readonly string[]).includes(x)
  );
}

export function isWorkorderTemplateRef(x: unknown): x is WorkorderTemplateRef {
  return (
    isRecord(x) &&
    typeof x.accountId === "string" &&
    typeof x.id === "string" &&
    typeof x.revision === "string"
  );
}

export function isWorkorderStep(x: unknown): x is WorkorderStep {
  if (!isRecord(x)) return false;
  if (typeof x.path !== "string") return false;
  if (!isWorkorderStepState(x.state)) return false;
  if (x.by !== null && typeof x.by !== "string") return false;
  if (x.at !== null && typeof x.at !== "string") return false;
  if (typeof x.note !== "string") return false;
  return true;
}

function isWorkorderItem(x: unknown): x is WorkorderItem {
  return (
    isRecord(x) &&
    typeof x.key === "string" &&
    isRecord(x.data) &&
    Object.values(x.data).every((v) => typeof v === "string")
  );
}

function isWorkorderItemMap(x: unknown): x is Record<string, WorkorderItem[]> {
  return (
    isRecord(x) &&
    Object.values(x).every((list) => Array.isArray(list) && list.every(isWorkorderItem))
  );
}

function isStringMap(x: unknown): x is Record<string, string> {
  return isRecord(x) && Object.values(x).every((v) => typeof v === "string");
}

export function isWorkorderChecklist(x: unknown): x is WorkorderChecklist {
  return (
    isRecord(x) &&
    isWorkorderTemplateRef(x.template) &&
    isStringMap(x.variants) &&
    isWorkorderItemMap(x.items) &&
    Array.isArray(x.steps) &&
    x.steps.every(isWorkorderStep)
  );
}

export function isWorkorderRef(x: unknown): x is WorkorderRef {
  return (
    isRecord(x) &&
    typeof x.accountId === "string" &&
    (x.kind === "folder" || x.kind === "file" || x.kind === "kb") &&
    typeof x.id === "string"
  );
}

export function isWorkorderDoc(x: unknown): x is WorkorderDoc {
  if (!isRecord(x)) return false;
  if (x.v !== 1 || typeof x.uid !== "string") return false;
  if (x.name !== undefined && typeof x.name !== "string") return false;
  if (x.state !== undefined && !isWorkorderState(x.state)) return false;
  if (
    x.replacedBy !== undefined &&
    x.replacedBy !== null &&
    typeof x.replacedBy !== "string"
  )
    return false;
  if (!isWorkorderChecklist(x.checklist)) return false;
  if (!Array.isArray(x.refs) || !x.refs.every(isWorkorderRef)) return false;
  return isTimes(x.created) && isTimes(x.updated);
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

/** Mint a checklist bound to a template revision, every applicable step open. */
export function buildChecklist(input: {
  template: WorkorderTemplateRef;
  variants: Record<string, string>;
  items: Record<string, WorkorderItem[]>;
  /** The applicable step paths, in template order. */
  stepPaths: ReadonlyArray<string>;
}): WorkorderChecklist {
  return {
    template: input.template,
    variants: input.variants,
    items: input.items,
    steps: input.stepPaths.map((path) => ({
      path,
      state: "open" as const,
      by: null,
      at: null,
      note: "",
    })),
  };
}

/** Mint a workorder document — the one writer; callers must not inline it. */
export function buildWorkorderDoc(input: {
  uid: string;
  by: string;
  at: string;
  checklist: WorkorderChecklist;
  refs?: WorkorderRef[];
  name?: string;
  state?: WorkorderState;
}): WorkorderDoc {
  const times: WorkorderTimes = { by: input.by, at: input.at };
  const doc: WorkorderDoc = {
    v: 1,
    uid: input.uid,
    checklist: input.checklist,
    refs: input.refs ?? [],
    created: times,
    updated: times,
  };
  if (input.name !== undefined) doc.name = input.name;
  if (input.state !== undefined) doc.state = input.state;
  return doc;
}

/** The step a checklist holds by path, or undefined. */
export function stepOf(
  checklist: WorkorderChecklist,
  path: string,
): WorkorderStep | undefined {
  return checklist.steps.find((step) => step.path === path);
}

/* ------------------------------------------------------------------ */
/* Wire shapes: what the route answers and the client reads            */
/* ------------------------------------------------------------------ */

/** The scope a checklist belongs to: the global one, or a group's part. */
export type WorkorderScope = "global" | "group";

/** One step as a reader sees it: its controlled label and its own state. */
export interface WorkorderStepView {
  path: string;
  label: string;
  state: WorkorderStepState;
  /** The last signature: who set the state, or null. */
  by: string | null;
  at: string | null;
  note: string;
}

/** One item of a section as a reader sees it (a container, or the section). */
export interface WorkorderItemView {
  /** The item's key for a repeated section, or "" when the section is not repeated. */
  key: string;
  /** The item's label. */
  label: string;
  /** The item's data fields, label and value, for a repeated section. */
  fields: Array<{ key: string; label: string; value: string }>;
  steps: WorkorderStepView[];
}

/** One section of a part, with the items and steps that apply. */
export interface WorkorderGroupView {
  key: string;
  label: string;
  /** What one item is for a repeated section, or null when it is not repeated. */
  repeat: string | null;
  items: WorkorderItemView[];
}

/** One checklist as a reader sees it, grouped by the template's sections. */
export interface WorkorderPartView {
  scope: WorkorderScope;
  /** The group's account, or null for the global part. */
  accountId: string | null;
  /** The group's own name for a group part, null for the global. */
  group: string | null;
  checklist: WorkorderChecklist;
  groups: WorkorderGroupView[];
  /** The KB page this checklist instantiates, by title, or null if unreadable. */
  templateTitle: string | null;
  /** Whether the caller may check this part's steps. */
  canCheck: boolean;
}

/** One workorder as the panel lists and opens it. */
export interface WorkorderSummary {
  uid: string;
  name: string;
  state: WorkorderState;
  replacedBy: string | null;
  /** The parts the caller may see: the global one and their own groups'. */
  parts: WorkorderPartView[];
  refs: WorkorderRef[];
  created: WorkorderTimes;
  updated: WorkorderTimes;
  /** Whether the caller is an installation administrator. */
  canAdminister: boolean;
}

export interface WorkordersView {
  workorders: WorkorderSummary[];
}

export interface WorkorderView {
  workorder: WorkorderSummary;
}

/** One item a create names for a repeated section: its key and optional data. */
export interface WorkorderItemInput {
  key: string;
  data?: Record<string, string>;
}

/** What a creation names: a friendly name, a template, the groups and choices. */
export interface WorkorderCreateInput {
  name: string;
  template: WorkorderTemplateRef;
  /** The groups the workorder gets a part in, by name; empty is global only. */
  groups: string[];
  /** The chosen value per variant key; every variant must be named. */
  variants?: Record<string, string>;
  /** The chosen items per repeated section key; every repeat must name one. */
  items?: Record<string, WorkorderItemInput[]>;
}

/**
 * What sets one step of one part: the global checklist or a group's.
 *
 * One wire shape both tiers read: the client composes it and the server's
 * route narrows to it, so a field added on one side cannot arrive `undefined`
 * on the other.
 */
export interface WorkorderCheckInput {
  uid: string;
  scope: WorkorderScope;
  /** The group's own name for a group part; omitted for the global one. */
  group?: string;
  path: string;
  state: WorkorderStepState;
  /** Why a skipped / not-applicable step is so; free text, optional. */
  note?: string;
}

/** A reference added to or removed from a workorder. */
export interface WorkorderRefChange {
  add?: WorkorderRef;
  remove?: WorkorderRef;
}
