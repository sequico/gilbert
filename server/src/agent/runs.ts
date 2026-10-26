/**
 * The one place a run is addressed (ADR 0030).
 *
 * A run is one document named `<id>.json` under `runs/` in the **group's own
 * account** — the group's `gilbert` app folder — so reading a group's history is
 * reading its own documents, under the group's own access, like its instruction and
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
 *
 * The listing comes in two answers over one walk: `listRuns` is the loop's and
 * refuses the first document it cannot read, while `listRunsForReading` is a
 * **surface's** and says each one beside the runs it can show.
 */

import {
  appFolderState,
  type Ctx,
  listAppSheets,
  readAppFileAt,
  writeAppFileAt,
} from "../appFolder.js";
import { CodedError, errorMessage } from "../shared/errors.js";
import { parseRunDocumentDetailed, type RunDoc, type RunListing } from "../shared/run.js";

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
 * shape it guesses at (ADR 0030): a document that is not the shape this build
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

/**
 * One run's document, from its bytes, or the refusal this build answers with.
 *
 * The one place a run's bytes become a run: what a document names, whether it is
 * the run it is filed as, and whether this build can read it at all — so the
 * single read and the walk of the folder (`listAppSheets`) refuse a document in
 * exactly the same words.
 */
function parseRun(id: string, text: string): RunDoc {
  const parsed = parseRunDocumentDetailed(text);
  if ("problem" in parsed) throw unreadable(runPath(id), parsed.problem);
  if (parsed.run.id !== id)
    throw unreadable(runPath(id), `it names the run "${parsed.run.id}".`);
  return parsed.run;
}

/** One run's document by id, or null when there is none. */
async function readRunDoc(
  ctx: Ctx,
  accountId: string,
  id: string,
  dir: string = RUNS_DIR,
): Promise<RunDoc | null> {
  const path = `${dir}/${id}.json`;
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, path);
  } catch (err) {
    // A document that is there with bytes that do not come back is unreadable,
    // not absent: the alternative is a run this build replaces or ignores.
    throw unreadable(path, errorMessage(err));
  }
  if (!found) return null;
  return parseRun(id, found.text);
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
 * One run document in a named folder, without the token a write needs.
 *
 * The detail surface reads a document it will never write, so it does not pay
 * for the account's state; the working path and the archive differ only by the
 * folder.
 */
export async function readRunAt(
  ctx: Ctx,
  accountId: string,
  dir: string,
  id: string,
): Promise<RunDoc | null> {
  return await readRunDoc(ctx, accountId, id, dir);
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
  opts: { ifInState?: string; onState?: (state: string) => void } = {},
): Promise<void> {
  await writeAppFileAt(ctx, accountId, runPath(run.id), run, opts);
}

/**
 * Every document in `runs/`, each read or each said.
 *
 * `listRuns` is the loop's answer and refuses the first document it cannot read
 * — a listing that skipped one would tell the agent that a folder it could not
 * read holds nothing else. A **surface** wants the opposite: the runs it can show
 * beside the one it cannot, so a reader is not left with an empty list and no
 * idea that anything is wrong. One walk, two answers, and the sentences are the
 * same ones the refusal above carries.
 *
 * The walk is `listAppSheets`: a document whose stamp has not moved since this
 * unit read it is not downloaded again, which is what a pass that reads the
 * working set every ten seconds needs. The working set is kept small by the
 * archive (`agent/archive.ts`): a run that ended more than a year ago is moved
 * to `runs/archive/<year-month>/` in the same account, never deleted.
 */
export async function listRunsForReading(
  ctx: Ctx,
  accountId: string,
  dir: string = RUNS_DIR,
): Promise<RunListing[]> {
  const rows = await listAppSheets(ctx, accountId, dir, parseRun);
  return rows.map((row) => ({ id: row.id, run: row.doc, problem: row.problem }));
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
  for (const row of await listRunsForReading(ctx, accountId)) {
    if (row.problem) throw new RunError("run_unreadable", row.problem);
    if (row.run) records.push({ run: row.run, state });
  }
  return records;
}

/**
 * The runs a pass may work, and the documents it could not read.
 *
 * The loop's own listing: a document this build cannot read is **said** and the
 * readable runs are still worked, so one corrupt file cannot stop a group's
 * agent for ever (the surface's answer has always been the two lists; this is
 * the working half taking the same shape).
 */
export async function listRunsForWorking(
  ctx: Ctx,
  accountId: string,
  /** The state the caller already read, so a quiet pass asks for it once. */
  state?: string,
): Promise<{ records: RunRecord[]; problems: string[] }> {
  const token = state ?? (await appFolderState(ctx, accountId));
  const records: RunRecord[] = [];
  const problems: string[] = [];
  for (const row of await listRunsForReading(ctx, accountId)) {
    if (row.problem) {
      problems.push(row.problem);
      continue;
    }
    if (row.run) records.push({ run: row.run, state: token });
  }
  return { records, problems };
}
