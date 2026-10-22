/**
 * The one-off clear of what the rules left behind (ADR 0038, owner decision
 * 2026-10-22).
 *
 * A group used to keep its engagement in `rules/<id>.json`, and an older build
 * kept one in `agent/rules.json`. This build reads neither: a group has one
 * instruction and nothing else. The documents are removed rather than left to
 * age, and a marker in the account says the clear happened — so a process that
 * restarts does not walk the folder again. An account that had nothing to clear
 * writes no marker and is re-checked on the next process's first pass: two reads,
 * no document.
 *
 * Nothing else is touched: the instruction, the runs, the cursors and the
 * memory are the group's present, not the old shape's residue.
 */

import {
  type Ctx,
  destroyAppNode,
  findAppFileAt,
  findAppFolder,
  findFolderPath,
  writeAppFileAt,
} from "../appFolder.js";

/** Where the marker that says this account was cleared lives. */
export const RESET_FILE = "agent/reset-0038.json";

/**
 * The folder the old rules lived in. It is the agent's own bookkeeping, so the
 * change log's "is this activity" test skips it while a clear may still run.
 */
export const LEGACY_RULES_DIR = "rules";

/** What the clear removed, for the pass's own log; empty when it was done before. */
export async function clearLegacyAgentState(
  ctx: Ctx,
  accountId: string,
): Promise<string[]> {
  if (!(await findAppFolder(ctx, accountId))) return [];
  const done = await findAppFileAt(ctx, accountId, RESET_FILE);
  if (done?.file) return [];
  const removed: string[] = [];
  const rules = await findFolderPath(ctx, accountId, LEGACY_RULES_DIR);
  if (rules) {
    await destroyAppNode(ctx, accountId, rules, { removeChildren: true });
    removed.push(`${LEGACY_RULES_DIR}/`);
  }
  const legacy = await findAppFileAt(ctx, accountId, "agent/rules.json");
  const id = legacy?.file && typeof legacy.file.id === "string" ? legacy.file.id : null;
  if (id) {
    await destroyAppNode(ctx, accountId, id);
    removed.push("agent/rules.json");
  }
  /*
   * The marker is written only when something was removed: it says "the clear
   * happened here", and an account that had nothing to clear has no clear to
   * report — writing one would put a document in every group the agent works.
   */
  if (!removed.length) return [];
  await writeAppFileAt(ctx, accountId, RESET_FILE, {
    at: new Date().toISOString(),
    removed,
  });
  return removed;
}
