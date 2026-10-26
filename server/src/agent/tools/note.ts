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

import { writeCaseNote } from "../case.js";
import { argsRecord, optionalTextArg, textArg } from "./args.js";
import { defineTool } from "./define.js";

export const noteTool = defineTool<{ text: string; key?: string }>({
  name: "note",
  description:
    "Keep what this case must not forget: the key the group's report calls it by, " +
    "where its work goes, the rule it follows, what was already reported, and what is " +
    "still owed. Give `key` the first time you know the case's name — it becomes the " +
    "case the next increment reads — and the whole note as `text`, which replaces what " +
    "was there. An empty `text` clears it.",
  authority: "reversible",
  writes: true,
  spend: {},
  args: { text: { type: "text" }, key: { type: "text" } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { text: textArg(args, "text"), key: optionalTextArg(args, "key") };
  },
  run: async ({ ctx, accountId, run }, { text, key }) => {
    /*
     * The case a run works: the one its own document names, or — the first time a
     * case is named — the change that woke it. Naming it here is how the note moves
     * from the run's own id to the group's name for the case, and every later turn of
     * this run reads it back under the new name.
     */
    const held = key?.trim() || run.caseKey || run.id;
    await writeCaseNote(ctx, accountId, held, text);
    return { case: held, note: text.trim() };
  },
});

/** The case key a note call answered with, when it answered with one. */
export function caseOf(outcome: unknown): string | undefined {
  if (!outcome || typeof outcome !== "object") return undefined;
  const key = (outcome as { case?: unknown }).case;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}
