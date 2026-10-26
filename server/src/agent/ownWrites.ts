/**
 * What this process wrote into a group's account, so the change reading can tell
 * the agent's own act from a person's (ADR 0038).
 *
 * An agent woken by its own write is a loop: a run that saves a file would be
 * woken by the folder it just wrote into, propose against the page it drafted,
 * settle the step it settled, and the next run writes again. The calendar had
 * this guard first; this is the one set for every surface — a node's path, an
 * event's id — so there is one policy and one bound rather than a set per tool.
 *
 * The marks are **process state beside the claim**, never a store: a restart
 * loses them, so the first change after a restart is read as a person's, once,
 * and a run that writes again is not read by itself. The set is bounded because
 * it is a speed-up: a mark is taken by the first change it explains, one write
 * being one change, and a path a person also wrote before that change is read is
 * the price the calendar's guard already pays.
 */

/** How many marks one process keeps; the oldest goes first. */
const KEPT = 500;

const marks = new Set<string>();

function keyOf(accountId: string, what: string): string {
  return `${accountId}\u0000${what}`;
}

/** Note that this process wrote `what` in `accountId`, so its change is not news. */
export function markOwnWrite(accountId: string, what: string): void {
  const key = keyOf(accountId, what);
  if (marks.has(key)) return;
  marks.add(key);
  if (marks.size > KEPT) {
    const oldest = marks.values().next().value;
    if (oldest !== undefined) marks.delete(oldest);
  }
}

/** Whether the next change of `what` is this process's own write, taking the mark. */
export function takeOwnWrite(accountId: string, what: string): boolean {
  return marks.delete(keyOf(accountId, what));
}

/** The key a Files node's change is marked under: its path. */
export function fileWriteKey(path: string): string {
  return `file:${path}`;
}

/** The key a calendar event's change is marked under: its id. */
export function eventWriteKey(id: string): string {
  return `event:${id}`;
}

/** Forget every mark, for a test that shares one account between cases. */
export function forgetOwnWrites(): void {
  marks.clear();
}
