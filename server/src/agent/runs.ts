/**
 * The one place a run is addressed (ADR 0034).
 *
 * A run is one document named `<id>.json` under `runs/` in the **group's own
 * account** — the group's `gilbert` app folder — so reading a group's history is
 * reading its own documents, under the group's own access, like its rules and
 * its workorders. The shape and the transitions over it are
 * `@gilbert/shared/run`; what lives here is where the document is, how it is
 * read and how it is written.
 *
 * JMAP offers no lock, so a write that must not lose a race carries the
 * account's FileNode state as `ifInState` (`appFolder.ts`), and the token is
 * read **before** the document: a write landing between the two advances the
 * state past the token, so a replace carrying it is refused rather than
 * overwriting a change this read never saw. Holding that token from a read to
 * the replace that follows it is the caller's — `RunRecord` carries it.
 */

import {
  appFolderState,
  type Ctx,
  listAppDir,
  readAppFileAt,
  writeAppFileAt,
} from "../appFolder.js";
import { CodedError, errorMessage } from "../shared/errors.js";
import { isRunDue, parseRunDocumentDetailed, type RunDoc } from "../shared/run.js";

/** Where a group's runs live under its app folder: the one path constant. */
export const RUNS_DIR = "runs";

/** A run's document path, app-folder-relative. */
export function runPath(id: string): string {
  return `${RUNS_DIR}/${id}.json`;
}

/**
 * A run this build cannot use.
 *
 * A run that is there but unreadable is a **defect the agent reports**, never a
 * shape it guesses at (ADR 0034): a document that is not the shape this build
 * writes, or whose `id` is not the name it is filed under, is refused with its
 * path and the reason rather than read as an empty run — which would be a run
 * the agent then acts on as though it had no plan and no history. The code is
 * what a surface composes its own sentence from.
 */
export class RunError extends CodedError {
  constructor(code: string, message: string, status = 502) {
    super(code, message, status, "RunError");
  }
}

/** A run together with the compare-and-set token its read saw. */
export interface RunRecord {
  run: RunDoc;
  /** The account's FileNode state at read time: pass it as `ifInState` to replace. */
  state: string;
}

function unreadable(path: string, why: string): RunError {
  return new RunError(
    "run_unreadable",
    `The run at ${path} is not readable: ${why} It has been left exactly as it is.`,
  );
}

/** One run's document by id, or null when there is none. */
async function readRunDoc(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<RunDoc | null> {
  const path = runPath(id);
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, path);
  } catch (err) {
    // A document that is there with bytes that do not come back is unreadable,
    // not absent: the alternative is a run this build replaces or ignores.
    throw unreadable(path, errorMessage(err));
  }
  if (!found) return null;
  const parsed = parseRunDocumentDetailed(found.text);
  if ("problem" in parsed) throw unreadable(path, parsed.problem);
  if (parsed.run.id !== id)
    throw unreadable(path, `it names the run "${parsed.run.id}".`);
  return parsed.run;
}

/** A run by id, with the token a replace of it needs, or null when there is none. */
export async function readRun(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<RunRecord | null> {
  const state = await appFolderState(ctx, accountId);
  const run = await readRunDoc(ctx, accountId, id);
  return run ? { run, state } : null;
}

/**
 * Store a new run.
 *
 * A run's id is its own, and a document already filed under it is another run:
 * writing over it would erase a record this build cannot restore, so the create
 * refuses instead.
 */
export async function createRun(ctx: Ctx, accountId: string, run: RunDoc): Promise<void> {
  if (await readRunDoc(ctx, accountId, run.id))
    throw new RunError("run_exists", `A run "${run.id}" is already there.`, 409);
  await writeAppFileAt(ctx, accountId, runPath(run.id), run);
}

/**
 * Write a run whole, conditionally on `ifInState` when one is given.
 *
 * The token is the one a read handed back, and passing it is what turns the
 * write into a compare-and-set: a stale one is refused rather than overwriting
 * whatever moved in between.
 */
export async function replaceRun(
  ctx: Ctx,
  accountId: string,
  run: RunDoc,
  opts: { ifInState?: string } = {},
): Promise<void> {
  await writeAppFileAt(ctx, accountId, runPath(run.id), run, opts);
}

/**
 * A group's runs, each with the token a replace of it needs.
 *
 * A document in `runs/` that cannot be read is reported, not skipped: it is one
 * run the group can no longer see, and a listing that hid it would answer
 * "these are all of them" about a folder it could not read.
 */
export async function listRuns(ctx: Ctx, accountId: string): Promise<RunRecord[]> {
  const state = await appFolderState(ctx, accountId);
  const records: RunRecord[] = [];
  for (const node of await listAppDir(ctx, accountId, RUNS_DIR)) {
    if (node.nodeType !== "file" || typeof node.name !== "string") continue;
    if (!node.name.endsWith(".json")) continue;
    const run = await readRunDoc(ctx, accountId, node.name.slice(0, -".json".length));
    if (run) records.push({ run, state });
  }
  return records;
}

/** The group's runs whose wait has come due at `now`. */
export async function dueRuns(
  ctx: Ctx,
  accountId: string,
  now: Date,
): Promise<RunRecord[]> {
  return (await listRuns(ctx, accountId)).filter(({ run }) => isRunDue(run, now));
}
