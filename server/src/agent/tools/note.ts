/**
 * The case's scratchpad, kept as a file the agent writes for itself (ADR 0034).
 *
 * The instruction asks the agent to **record what it needs** and not to re-read a
 * page it has already read; a live run obeyed by re-reading because the harness gave
 * it nowhere to write. This is that place, and it belongs to the **case** rather than
 * to the run: the next increment of the same case reads what this one learned
 * (`agent/case.ts`, `gilbert/cases/<key>.md`).
 *
 * The tool writes the note; what it answers is the key it filed it under, so the run
 * records which case it worked.
 */

import { casePath, writeCaseNote } from "../case.js";
import { argsRecord, optionalTextArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

export const noteTool = defineTool<{ text: string; key?: string }>({
  name: "note",
  description:
    "Keep what this case must not forget: the key the group's report calls it by, " +
    "where its work goes, the instruction it follows, what was already reported, and what is " +
    "still owed. Give `key` the first time you know the case's name — it becomes the " +
    "case the next increment reads — and the whole note as `text`, which replaces what " +
    "was there. An empty `text` clears it.",
  authority: "reversible",
  writes: true,
  spend: {},
  args: {
    text: {
      type: "text",
      about: "the whole note, replacing what was there; empty clears it",
    },
    key: { type: "text", about: "the case's name, as the group's report calls it" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    /*
     * The text is required and may be empty: the description says an empty note
     * clears the scratchpad, and the one writer does exactly that (`case.ts`).
     * Every other text argument in the catalogue refuses a blank value, which is
     * why this one reads its own.
     */
    if (typeof args.text !== "string")
      throw new ToolError(
        "bad_arguments",
        '"text" must be text, or empty to clear the note.',
      );
    return { text: args.text, key: optionalTextArg(args, "key") };
  },
  run: async ({ ctx, accountId, run }, { text, key }) => {
    /*
     * The case a run works: the name the call gives, or the one the run already
     * holds. A run whose case has no name yet keeps its note under its own id — the
     * place it is kept, never a case the record claims to work.
     */
    const named = key?.trim() || run.caseKey;
    const held = named ?? run.id;
    await writeCaseNote(ctx, accountId, held, text);
    /*
     * A note filed under the group's name leaves the run id it was provisionally
     * kept under: a run id is not a case, and a folder of them would crowd the list
     * a turn reads (ADR 0034). A case renamed to another case keeps its own file —
     * only the provisional one is dropped.
     */
    if (named && run.caseKey === undefined && casePath(named) !== casePath(run.id))
      await writeCaseNote(ctx, accountId, run.id, "");
    return { ...(named ? { case: named } : {}), note: text.trim() };
  },
});

/** The case key a note call answered with, when it answered with one. */
export function caseOf(outcome: unknown): string | undefined {
  if (!outcome || typeof outcome !== "object") return undefined;
  const key = (outcome as { case?: unknown }).case;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}
