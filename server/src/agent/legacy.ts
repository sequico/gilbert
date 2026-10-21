/**
 * The one-off clear of what the rules left behind (ADR 0038, owner decision
 * 2026-10-22).
 *
 * A group used to keep its engagement in `rules/<id>.json`, and an older build
 * kept one in `agent/rules.json`. This build reads neither: a group has one
 * instruction and nothing else. The documents are removed rather than left to
 * age, once per account, and a marker in the account says the clear happened —
 * so a process that restarts does not walk the folder again, and an
 * administrator can see that it was done.
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

/** What the clear removed, for the pass's own log; empty when it was done before. */
export async function clearLegacyAgentState(
  ctx: Ctx,
  accountId: string,
): Promise<string[]> {
  if (!(await findAppFolder(ctx, accountId))) return [];
  const done = await findAppFileAt(ctx, accountId, RESET_FILE);
  if (done?.file) return [];
  const removed: string[] = [];
  const rules = await findFolderPath(ctx, accountId, "rules");
  if (rules) {
    await destroyAppNode(ctx, accountId, rules, { removeChildren: true });
    removed.push("rules/");
  }
  const legacy = await findAppFileAt(ctx, accountId, "agent/rules.json");
  const id = legacy?.file && typeof legacy.file.id === "string" ? legacy.file.id : null;
  if (id) {
    await destroyAppNode(ctx, accountId, id);
    removed.push("agent/rules.json");
  }
  await writeAppFileAt(ctx, accountId, RESET_FILE, {
    at: new Date().toISOString(),
    removed,
  });
  return removed;
}
