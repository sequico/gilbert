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
 * template's id and the revision it was bound to, the step ids, and each step's
 * state and last signature — never a copy of the controlled text, which is read
 * from the template revision. This module carries the shape, its validators, the
 * pure helpers and the wire views the route answers, so the client and the
 * server cannot drift.
 */

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

export type WorkorderStepState = "open" | "done";

/** One step's operational state — never the controlled text, which the KB holds. */
export interface WorkorderStep {
  id: string;
  state: WorkorderStepState;
  /** The last signature: who checked it, or null when never checked. */
  by: string | null;
  at: string | null;
}

export interface WorkorderChecklist {
  template: WorkorderTemplateRef;
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

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isTimes(x: unknown): x is WorkorderTimes {
  return isRecord(x) && typeof x.by === "string" && typeof x.at === "string";
}

export function isWorkorderState(x: unknown): x is WorkorderState {
  return typeof x === "string" && (WORKORDER_STATES as readonly string[]).includes(x);
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
  if (typeof x.id !== "string") return false;
  if (x.state !== "open" && x.state !== "done") return false;
  if (x.by !== null && typeof x.by !== "string") return false;
  if (x.at !== null && typeof x.at !== "string") return false;
  return true;
}

export function isWorkorderChecklist(x: unknown): x is WorkorderChecklist {
  return (
    isRecord(x) &&
    isWorkorderTemplateRef(x.template) &&
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

/** Mint a checklist bound to a template revision, every step open. */
export function buildChecklist(
  template: WorkorderTemplateRef,
  stepIds: ReadonlyArray<string>,
): WorkorderChecklist {
  return {
    template,
    steps: stepIds.map((id) => ({ id, state: "open" as const, by: null, at: null })),
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

/** The step a document holds by id, or undefined. */
export function stepOf(
  checklist: WorkorderChecklist,
  stepId: string,
): WorkorderStep | undefined {
  return checklist.steps.find((step) => step.id === stepId);
}

/* ------------------------------------------------------------------ */
/* Wire shapes: what the route answers and the client reads            */
/* ------------------------------------------------------------------ */

/** The scope a checklist belongs to: the global one, or a group's part. */
export type WorkorderScope = "global" | "group";

/** One checklist as a reader sees it, with the template's labels resolved. */
export interface WorkorderPartView {
  scope: WorkorderScope;
  /** The group's account, or null for the global part. */
  accountId: string | null;
  /** The group's own name for a group part, null for the global. */
  group: string | null;
  checklist: WorkorderChecklist;
  /** Each step's label, read from the template revision, keyed by step id. */
  labels: Record<string, string>;
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

/** What a creation names: a friendly name, a template, and the groups. */
export interface WorkorderCreateInput {
  name: string;
  template: WorkorderTemplateRef;
  /** The groups the workorder gets a part in, by name; empty is global only. */
  groups: string[];
}

/**
 * What checks one step of one part: the global checklist or a group's.
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
  stepId: string;
  checked: boolean;
}

/** A reference added to or removed from a workorder. */
export interface WorkorderRefChange {
  add?: WorkorderRef;
  remove?: WorkorderRef;
}
