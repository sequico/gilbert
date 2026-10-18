/**
 * The one place a rule is addressed (ADR 0035).
 *
 * A rule is one document named `<id>.json` under `rules/` in the **group's own
 * account** — the group's `gilbert` app folder — so reading a group's rules is
 * reading its own documents, under the group's own access, like its runs and
 * its workorders. The shape, its parser and the one test of what a rule watches
 * are `./rule`; what lives here is where the document is, how it is read and
 * how it is written.
 *
 * JMAP offers no lock, so a replace carries the account's FileNode state as
 * `ifInState` (`appFolder.ts`), and the token is read **before** the document:
 * a write landing between the two advances the state past the token, so a
 * replace carrying it is refused rather than overwriting a change this read
 * never saw. Holding that token from a read to the replace that follows it is
 * the caller's — `RuleRecord` carries it.
 */

import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  ensureFolderPath,
  findAppFileAt,
  listAppSheets,
  readAppFileAt,
  writeAppFileAt,
} from "../appFolder.js";
import { errorMessage, isStateMismatch } from "../shared/errors.js";
import { RULES_DIR, RuleError, rulePath } from "../shared/rule.js";
import { parseRuleDocumentDetailed, type RuleDoc } from "./rule.js";

export { RULES_DIR, RuleError, rulePath } from "../shared/rule.js";

/** A rule together with the compare-and-set token its read saw. */
interface RuleRecord {
  rule: RuleDoc;
  /** The account's FileNode state at read time: pass it as `ifInState` to replace. */
  state: string;
}

function unreadable(path: string, why: string): RuleError {
  return new RuleError(
    "rule_unreadable",
    `The rule at ${path} is not readable: ${why} It has been left exactly as it is.`,
  );
}

/** One rule's document by id, or null when there is none. */
async function readRuleDoc(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<RuleDoc | null> {
  const path = rulePath(id);
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, path);
  } catch (err) {
    // A document that is there with bytes that do not come back is unreadable,
    // not absent: the alternative is a rule this build replaces or ignores.
    throw unreadable(path, errorMessage(err));
  }
  if (!found) return null;
  const parsed = parseRuleDocumentDetailed(found.text);
  if ("problem" in parsed) throw unreadable(path, parsed.problem);
  if (parsed.rule.id !== id)
    throw unreadable(path, `it names the rule "${parsed.rule.id}".`);
  return parsed.rule;
}

/** A rule by id, with the token a replace of it needs, or null when there is none. */
export async function readRule(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<RuleRecord | null> {
  const state = await appFolderState(ctx, accountId);
  const rule = await readRuleDoc(ctx, accountId, id);
  return rule ? { rule, state } : null;
}

/**
 * Store a new rule.
 *
 * A rule's id is its own, and a document already filed under it is another
 * rule: writing over it would erase text a group wrote, so the create refuses
 * instead. A change to a rule that is there is a `replaceRule`.
 */
export async function createRule(
  ctx: Ctx,
  accountId: string,
  rule: RuleDoc,
): Promise<void> {
  /*
   * A create is a compare-and-set against the state the absence was read at
   * (ADR 0035): two writers who both find the name free — this one and a
   * member's own client — cannot both create it, because the first write moves
   * the state and the second is refused. Without the token the check is a
   * check-then-write, and the second silently replaces the first's text.
   */
  // The folder exists before the state is read: creating it would move the state
  // this create is conditioned on, and a first rule would be refused by itself.
  await ensureFolderPath(ctx, accountId, RULES_DIR);
  const state = await appFolderState(ctx, accountId);
  if (await readRuleDoc(ctx, accountId, rule.id))
    throw new RuleError("rule_exists", `A rule "${rule.id}" is already there.`, 409);
  try {
    await writeAppFileAt(ctx, accountId, rulePath(rule.id), rule, { ifInState: state });
  } catch (err) {
    if (isStateMismatch(err))
      throw new RuleError(
        "rule_moved",
        `The rules changed while "${rule.id}" was being created, so nothing was written.`,
        409,
      );
    throw err;
  }
}

/**
 * Write a rule whole, conditionally on `ifInState` when one is given.
 *
 * The token is the one a read handed back, and passing it is what turns the
 * write into a compare-and-set: a stale one is refused rather than overwriting
 * whatever moved in between.
 */
export async function replaceRule(
  ctx: Ctx,
  accountId: string,
  rule: RuleDoc,
  opts: { ifInState?: string } = {},
): Promise<void> {
  await writeAppFileAt(ctx, accountId, rulePath(rule.id), rule, opts);
}

/**
 * Remove one rule's document, conditioned on the state its absence was read at.
 *
 * The one delete the agent's documents have, and it belongs to the administrator
 * route: a rule is decided by an administrator and by nobody else (owner decision
 * 2026-10-18), so the boundary is the door rather than the surface.
 */
export async function deleteRule(
  ctx: Ctx,
  accountId: string,
  id: string,
  opts: { ifInState?: string } = {},
): Promise<void> {
  const found = await findAppFileAt(ctx, accountId, rulePath(id));
  if (!found?.file || typeof found.file.id !== "string") return;
  await destroyAppNode(ctx, accountId, found.file.id, opts);
}

/**
 * A group's rules, each with the token a replace of it needs.
 *
 * A document in `rules/` that cannot be read is reported, not skipped: it is one
 * rule the group can no longer see, and a listing that hid it would answer
 * "these are all of them" about a folder it could not read.
 */
export async function listRules(ctx: Ctx, accountId: string): Promise<RuleRecord[]> {
  const state = await appFolderState(ctx, accountId);
  // The same stamp cache its siblings use: a rule whose node has not moved is
  // not downloaded again, and a pass reads a folder of unchanged rules for the
  // price of one listing.
  const rows = await listAppSheets(ctx, accountId, RULES_DIR, (id, text) => {
    const parsed = parseRuleDocumentDetailed(text);
    if ("problem" in parsed) throw unreadable(rulePath(id), parsed.problem);
    if (parsed.rule.id !== id)
      throw unreadable(rulePath(id), `Its "id" is "${parsed.rule.id}".`);
    return parsed.rule;
  });
  const first = rows.find((row) => row.problem);
  if (first?.problem) throw unreadable(RULES_DIR, first.problem);
  return rows.flatMap((row) => (row.doc ? [{ rule: row.doc, state }] : []));
}
