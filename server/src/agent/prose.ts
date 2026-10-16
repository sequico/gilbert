/**
 * The prose that reaches the model, in the order it is told it (ADR 0035).
 *
 * The instruction an agent carries has three levels, and the record names them
 * outermost first. One **builder** produces that order for every caller, so
 * what the agent is told is one thing however it was reached — a run woken by a
 * rule and a run woken by a sentence are told the same three levels in the same
 * order:
 *
 * 1. the **installation's own line**, one document in the Master's account,
 *    carried into every call;
 * 2. the **group's standing instruction**, in the group's account;
 * 3. the **rule's own instruction**, in the rule.
 *
 * A level that says nothing contributes nothing: an installation with no line
 * of its own does not leave a heading in the prompt with prose missing under
 * it. The prose is data to the rest of the prompt like any other text — it says
 * how to work, and never what may be done, because what bounds the agent is the
 * authority classes (ADR 0032) and nothing here changes them.
 */

/** The three levels of prose, outermost first (ADR 0035). */
export const PROSE_LEVELS = ["installation", "group", "rule"] as const;

/** One level of prose, named by where it is written. */
export type ProseLevel = (typeof PROSE_LEVELS)[number];

/** What each level is, as the model is told it. */
const LEVEL_HEADINGS: Record<ProseLevel, string> = {
  installation: "The installation's own rules, from whoever runs it:",
  group: "The group's standing instruction, from its members:",
  rule: "The rule's own instruction:",
};

/** One level's block, or "" when that level says nothing. */
export function proseBlock(level: ProseLevel, text?: string): string {
  const body = (text ?? "").trim();
  if (!body) return "";
  return `${LEVEL_HEADINGS[level]}\n${body}`;
}

/**
 * The prose a call carries, in the record's order: the installation, the
 * group's standing instruction, the rule's own instruction.
 *
 * The order is the whole of this function, and it is stated once: `PROSE_LEVELS`
 * is the only place it is written, and a caller cannot reorder it because it
 * never names the levels itself.
 */
export function proseForModel(levels: Partial<Record<ProseLevel, string>>): string[] {
  return PROSE_LEVELS.map((level) => proseBlock(level, levels[level])).filter(Boolean);
}
