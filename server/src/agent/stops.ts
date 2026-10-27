/**
 * A person's press of Stop, handed to the pass that is writing the run.
 *
 * The document's compare-and-set is what makes a stop **durable**, and it is not
 * enough on its own: the loop writes a step every few seconds, so a press that
 * retries a handful of times can lose every attempt and answer "the run moved"
 * while the run carries on working — which is what a person experiences as a
 * stop that does nothing (`{"stopped":2,"left":2}`, live on 2026-10-27).
 *
 * The press and the pass are the same process, so the intent is also recorded
 * here, in memory, and the loop's own write path reads it before every write: a
 * stop that arrives mid-step ends the run on the next write instead of being
 * out-raced. Nothing here outlives the process; the document is the record, and
 * a press whose process died before it landed is one somebody presses again.
 */

/** Who asked for a stop, and when, as the ending's own sentence needs it. */
export interface StopAsk {
  by: string;
  at: string;
}

const asked = new Map<string, StopAsk>();

/** `accountId\0runId`: a run id is unique per account, not per installation. */
const keyOf = (accountId: string, runId: string) => `${accountId}\u0000${runId}`;

/** Record a person's stop, so the pass working the run honours it. */
export function askToStop(accountId: string, runId: string, by: string): void {
  asked.set(keyOf(accountId, runId), { by, at: new Date().toISOString() });
}

/** The stop asked for this run, if one is still owed to the person. */
export function stopAsked(accountId: string, runId: string): StopAsk | undefined {
  return asked.get(keyOf(accountId, runId));
}

/** Forget the ask: the document carries the ending now, whichever writer wrote it. */
export function forgetStop(accountId: string, runId: string): void {
  asked.delete(keyOf(accountId, runId));
}
