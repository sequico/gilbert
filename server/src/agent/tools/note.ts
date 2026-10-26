/**
 * The case's scratchpad: what the run must not have to learn twice (ADR 0034).
 *
 * The instruction asks the agent to **record what it needs** and not to re-read a
 * page it has already read; a live run obeyed by re-reading instead, because the
 * harness gave it nowhere to write. This is that place. The note is the run's
 * working memory — the reference the case is known by, where its work goes, the rule
 * it followed, what was already reported, what is still owed — and every turn of the
 * run carries it whole.
 *
 * It changes the **run document**, not the account: the tool answers the text and
 * the loop keeps it (`noteOf`), so a note costs no step and needs no authority over
 * the group's data.
 */
import { setNote } from "../../shared/run.js";
import { argsRecord, textArg } from "./args.js";
import { defineTool } from "./define.js";

export const noteTool = defineTool<{ text: string }>({
  name: "note",
  description:
    "Keep what this case must not forget: the reference it is known by, where its " +
    "work goes, the rule it follows, what was already reported, and what is still " +
    "owed. The next turn reads it whole, so write what you would otherwise look up " +
    "again. Rewriting it replaces it; an empty text clears it.",
  authority: "reversible",
  writes: false,
  spend: {},
  args: { text: { type: "text" } },
  parse: (raw: unknown) => ({ text: textArg(argsRecord(raw), "text") }),
  run: async (_call, { text }) => ({ note: text }),
});

/** The note a tool's answer asked the run to keep, when it asked for one. */
export function noteOf(outcome: unknown): string | undefined {
  if (!outcome || typeof outcome !== "object") return undefined;
  const note = (outcome as { note?: unknown }).note;
  return typeof note === "string" ? note : undefined;
}
