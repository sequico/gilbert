/**
 * The phone's local policy (ADR 0023): how many calls one line carries, and
 * whether the next invitation must be answered busy.
 *
 * Pure, so the rule is testable without a SIP server, a microphone or a
 * browser. It is the busy half of the decision: the second call is call
 * waiting, and a call beyond what the line carries is refused with 486.
 */

/** How many calls one line carries: one active and one waiting. */
export const MAX_CALLS = 2;

/** Whether an invitation must be answered busy, given the calls already live. */
export function shouldRefuseAsBusy(liveCalls: number): boolean {
  return liveCalls >= MAX_CALLS;
}

/** What to do with an invitation that just arrived. */
export type RingAction = "refuse-busy" | "supersede" | "ring";

/**
 * The one decision an arriving invitation gets: refused busy when the line is
 * full, superseding a ring already waiting, or ringing.
 */
export function ringAction(liveCalls: number, alreadyRinging: boolean): RingAction {
  if (shouldRefuseAsBusy(liveCalls)) return "refuse-busy";
  return alreadyRinging ? "supersede" : "ring";
}
