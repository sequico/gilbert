/**
 * Where a group's rules live, and what a rule's name may be (ADR 0035).
 *
 * A rule is one document named `<id>.json` under `rules/` in the **group's own
 * account** — the group's `gilbert` app folder. The address is here because both
 * tiers name it: the server reads and writes a rule, and a member's client writes
 * one with the group's own session. The shape and its parser are
 * `agent/rule.ts`; where the document is read and written is `agent/rules.ts`.
 */

import { CodedError } from "./errors.js";

/** Where a group's rules live under its app folder: the one path constant. */
export const RULES_DIR = "rules";

/**
 * A rule this build cannot use.
 *
 * A rule that is there but unreadable is a **defect the agent reports**, never a
 * shape it guesses at (ADR 0035): a document that is not the shape this build
 * writes, or whose `id` is not the name it is filed under, is refused with its
 * path and the reason rather than read as a rule with nothing in it — which
 * would be a rule the agent then carries out as though it said nothing. The code
 * is what a surface composes its own sentence from.
 */
export class RuleError extends CodedError {
  constructor(code: string, message: string, status = 502) {
    super(code, message, status, "RuleError");
  }
}

/**
 * A rule's file name inside `rules/`.
 *
 * A rule's id is a file name and nothing else: a member names a rule, and an id
 * carrying a path separator would file it in a folder of its own rather than
 * beside its siblings. `.` and `..` are refused by the same test, and by
 * `pathSegments` after it. A writer that already holds the `rules/` folder names
 * the file with this; a reader of the account walks the path below.
 */
function ruleFileName(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new RuleError(
      "rule_id_invalid",
      `"${id}" is not a rule name: a rule is named by one plain file name.`,
    );
  return `${id}.json`;
}

/** A rule's document path, app-folder-relative: `rules/` and the file name. */
export function rulePath(id: string): string {
  return `${RULES_DIR}/${ruleFileName(id)}`;
}
