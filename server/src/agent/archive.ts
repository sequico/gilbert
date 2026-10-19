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
 * the pass reports and the next pass tries again — the document is never left in
 * two places.
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

/** How long a closed run stays in the working set. */
export const RUN_RETENTION_DAYS = 365;

/**
 * The month a run's drawer is named after, from the instant it ended — or null
 * for a run still running, which is never archived.
 */
export function archiveMonth(run: RunRecord["run"]): string | null {
  if (run.state === "running") return null;
  const at = run.ended?.at;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  return at.slice(0, 7);
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
): Promise<string[]> {
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const gaps: string[] = [];
  for (const { run } of records) {
    const month = archiveMonth(run);
    if (!month) continue;
    const ended = Date.parse(run.ended?.at ?? "");
    if (!Number.isFinite(ended) || ended >= cutoff.getTime()) continue;
    try {
      const found = await findAppFileAt(ctx, accountId, runPath(run.id));
      if (!found.file?.id) continue;
      const folder = await ensureFolderPath(
        ctx,
        accountId,
        `${RUNS_ARCHIVE_DIR}/${month}`,
      );
      await move(ctx, accountId, String(found.file.id), folder);
    } catch (err) {
      gaps.push(`the run "${run.id}" could not be archived: ${errorMessage(err)}`);
    }
  }
  return gaps;
}
