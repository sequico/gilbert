/**
 * The prose that reaches the model, in the order it is told it (ADR 0038).
 *
 * The instruction an agent carries has two levels, and the record names them
 * outermost first. One **builder** produces that order for every caller, so
 * what the agent is told is one thing however it was reached — a run woken by a
 * change and a run woken by a sentence are told the same two levels in the same
 * order:
 *
 * 1. the **installation's own line**, one document in the Master's account,
 *    carried into every call;
 * 2. the **group's one instruction**, in the group's account.
 *
 * A level that says nothing contributes nothing: an installation with no line
 * of its own does not leave a heading in the prompt with prose missing under
 * it. The levels travel in the system turn as what the agent works by, and they
 * are not fenced there: they are the instruction the agent carries, and fencing
 * them would tell the model to read past them. A group's instruction is the
 * group's own way of saying how its agent works, so it belongs in that
 * instruction and not behind a fence; what bounds the agent is not the fence but
 * the authority classes (ADR 0028), which nothing here changes.
 */

/** The two levels of prose, outermost first (ADR 0038). */
export const PROSE_LEVELS = ["installation", "group"] as const;

/** One level of prose, named by where it is written. */
export type ProseLevel = (typeof PROSE_LEVELS)[number];

/** What each level is, as the model is told it. */
const LEVEL_HEADINGS: Record<ProseLevel, string> = {
  installation: "The installation's own rules, from whoever runs it:",
  group: "The group's standing instruction, from its members:",
};

/** One level's block, or "" when that level says nothing. */
export function proseBlock(level: ProseLevel, text?: string): string {
  const body = (text ?? "").trim();
  if (!body) return "";
  return `${LEVEL_HEADINGS[level]}\n${body}`;
}

/**
 * The prose a call carries, in the record's order: the installation's own line,
 * then the group's instruction.
 *
 * The order is the whole of this function, and it is stated once: `PROSE_LEVELS`
 * is the only place it is written, and a caller cannot reorder it because it
 * never names the levels itself.
 */
export function proseForModel(levels: Partial<Record<ProseLevel, string>>): string[] {
  return PROSE_LEVELS.map((level) => proseBlock(level, levels[level])).filter(Boolean);
}
