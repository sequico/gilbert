/**
 * The tool over the account's runs.
 *
 * One read of a run by its id: what started it, the plan and how each step
 * ended, what it waits for, every authorisation it holds, what it has spent.
 */

import { readRun } from "../runs.js";
import { argsRecord, notFound, textArg } from "./args.js";
import { defineTool } from "./define.js";

export const readRunTool = defineTool({
  name: "run.read",
  description:
    "Read one run of this account by its id: what started it, the plan and how " +
    "each step ended, what it is waiting for, every authorisation it holds, and " +
    "what it has spent.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    const record = await readRun(ctx, accountId, id);
    if (!record) throw notFound(`run "${id}" in this account`);
    return { run: record.run };
  },
});
