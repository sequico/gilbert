/**
 * The tool over the account's runs.
 *
 * One read of a run by its id: what started it, the plan and how each step
 * ended, what it waits for, every authorisation it holds, what it has spent. A
 * run older than the retention year lives in its month's drawer, and the id is
 * enough to find it there: the reading looks through the archive's months after
 * the working set.
 */

import { type Ctx, listAppDir } from "../../appFolder.js";
import type { RunDoc } from "../../shared/run.js";
import { RUNS_ARCHIVE_DIR } from "../archive.js";
import { RUNS_DIR, readRunAt } from "../runs.js";
import { argsRecord, notFound, textArg } from "./args.js";
import { defineTool } from "./define.js";

/** A drawer's name: the month the archiver filed it under. */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * A run in the archive, by id, and the month that holds it.
 *
 * The months are listed rather than guessed: a run is filed under the month it
 * ended in, which the id alone does not say.
 */
async function archivedRun(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<{ run: RunDoc; month: string } | null> {
  const months = (await listAppDir(ctx, accountId, RUNS_ARCHIVE_DIR))
    .flatMap((node) =>
      node.nodeType === "directory" &&
      typeof node.name === "string" &&
      MONTH.test(node.name)
        ? [node.name]
        : [],
    )
    .sort()
    .reverse();
  for (const month of months) {
    const run = await readRunAt(ctx, accountId, `${RUNS_ARCHIVE_DIR}/${month}`, id);
    if (run) return { run, month };
  }
  return null;
}

export const readRunTool = defineTool({
  name: "run.read",
  description:
    "Read one run of this account by its id: what started it, the plan and how " +
    "each step ended, what it is waiting for, every authorisation it holds, and " +
    "what it has spent. A run older than the retention year is found in its " +
    "month's drawer as well, and the answer names the month.",
  authority: "reversible",
  writes: false,
  args: { id: { type: "text", about: "a run id, as a report or the panel names it" } },
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    // A reader never writes the run, so it needs no compare-and-set token: the
    // one-request read is the document alone, not the account state beside it.
    const run = await readRunAt(ctx, accountId, RUNS_DIR, id);
    if (run) return { run };
    const held = await archivedRun(ctx, accountId, id);
    if (!held) throw notFound(`run "${id}" in this account`);
    return { run: held.run, month: held.month };
  },
});
