/**
 * Where a run goes when it is no longer the working set (ADR 0034).
 *
 * `runs/` is what every pass lists and what the surface draws; keeping every run
 * a group ever worked there makes the cheap pass grow with the group's history.
 * A run that ended more than twelve months ago is **moved**, not deleted, to
 * `runs/archive/<year-month>/` in the same account: the record is still the
 * group's, still a document, and the month it ended in is its drawer. A run that
 * is still running, or ended inside the year, stays where it is.
 *
 * The move is a conditional FileNode write (the account's state as `ifInState`),
 * retried once like every other writer here; a move that keeps losing is a gap
 * the pass reports and is tried again an hour later, so one document that can
 * never move does not cost an attempt every ten seconds. The pass moves a
 * bounded batch; the rest follow. The document is never left in two places.
 */

import {
  appFolderState,
  type Ctx,
  ensureFolderPath,
  findAppFileAt,
  updateAppNode,
} from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { errorMessage } from "../shared/errors.js";
import { refusalOf } from "../shared/jmap.js";
import { type RunRecord, runPath } from "./runs.js";

/** The drawer the archived runs sit in, under the runs folder. */
export const RUNS_ARCHIVE_DIR = "runs/archive";

/** How long a closed run stays in the working set, in days. */
export const RUN_RETENTION_DAYS = 365;

/** How long a move that failed is left alone before it is tried again. */
const RETRY_AFTER_MS = 60 * 60_000;

/**
 * When a run's move may be tried again, by account and run.
 *
 * A move the account refuses (a right, a locked node) would otherwise be
 * retried on every ten-second pass, for ever. The map is process state beside
 * the claim: a restart clears it, and a run that can never move costs one
 * attempt an hour.
 */
const retryAt = new Map<string, number>();

/**
 * The month a run's drawer is named after, from the instant it ended — or null
 * for a run still running, which is never archived.
 */
export function archiveMonth(run: RunRecord["run"]): string | null {
  if (run.state === "running") return null;
  const at = run.ended?.at;
  if (typeof at !== "string") return null;
  const ended = new Date(at);
  if (!Number.isFinite(ended.getTime())) return null;
  // The server's own clock, as its log lines read: a run ended late on the last
  // day of a month stays in that month.
  return `${ended.getFullYear()}-${String(ended.getMonth() + 1).padStart(2, "0")}`;
}

/** Move one run's document into its month's drawer, under the account's state. */
async function move(
  ctx: Ctx,
  accountId: string,
  id: string,
  folderId: string,
): Promise<void> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = await appFolderState(ctx, accountId);
    try {
      const res = await updateAppNode(ctx, accountId, id, { parentId: folderId }, token);
      const refused = res.notUpdated?.[id];
      if (refused) throw new Error(refusalOf(refused));
      return;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  throw new Error("another write kept winning the race for the account");
}

/**
 * Move every closed run older than the year out of `records`, and answer what
 * could not be moved.
 *
 * One listing answers both halves of the pass already (the records `workDue`
 * read); nothing here re-lists the folder. A run whose document cannot be read
 * was not handed over (the listing says it as a problem), and a run still
 * running is never touched.
 */
export async function archiveOldRuns(
  ctx: Ctx,
  accountId: string,
  records: readonly RunRecord[],
  now: Date,
  opts: {
    max?: number;
    beforeMove?: () => Promise<void>;
    /** The run ids this batch moved, so the caller can drop them from its list. */
    moved?: Set<string>;
  } = {},
): Promise<string[]> {
  const cutoff = now.getTime() - RUN_RETENTION_DAYS * 86_400_000;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const gaps: string[] = [];
  /** One folder per month, looked up once for the whole batch. */
  const folders = new Map<string, string>();
  let moved = 0;
  for (const { run } of records) {
    if (moved >= max) break;
    const month = archiveMonth(run);
    if (!month) continue;
    const ended = Date.parse(run.ended?.at ?? "");
    if (!Number.isFinite(ended) || ended >= cutoff) continue;
    const key = `${accountId}\u0000${run.id}`;
    if ((retryAt.get(key) ?? 0) > now.getTime()) continue;
    try {
      await opts.beforeMove?.();
      const found = await findAppFileAt(ctx, accountId, runPath(run.id));
      if (!found.file?.id) continue;
      let folder = folders.get(month);
      if (!folder) {
        folder = await ensureFolderPath(ctx, accountId, `${RUNS_ARCHIVE_DIR}/${month}`);
        folders.set(month, folder);
      }
      await move(ctx, accountId, String(found.file.id), folder);
      retryAt.delete(key);
      opts.moved?.add(run.id);
      moved += 1;
    } catch (err) {
      retryAt.set(key, now.getTime() + RETRY_AFTER_MS);
      gaps.push(`the run "${run.id}" could not be archived: ${errorMessage(err)}`);
    }
  }
  return gaps;
}
