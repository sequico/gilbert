/**
 * Time triggers on documents (ADR 0003).
 *
 * The schedule is a document in the group's own account (`agent/schedule.json`)
 * holding the next run instant of every `schedule` rule, so no container has to
 * live for a run to happen: a replacement agent re-plans from Stalwart and
 * re-arms its timers. The planning, the due check and the advance are pure
 * functions, testable without a clock; `armTimers` is the only part that
 * touches a timer, and it takes the clock and the timers from its options (the
 * globals by default) so a test can drive it without waiting. It caps every
 * delay so a far-future instant is re-checked rather than trusted to one long
 * sleep.
 */

import { type AgentRule, type AgentScheduleEntry, nextRunAfter } from "./documents.js";

/** The clock and the timers a schedule is armed with, and the cap it arms under. */
export interface ArmTimersOpts {
  /**
   * The longest a single `setTimeout` may be, in milliseconds. A longer gap is
   * re-checked when the short timer fires instead of being trusted to one
   * timer — a container that was paused or a clock that jumped must not shift
   * a run by hours.
   */
  maxDelayMs: number;
  /**
   * The clock the cap and the due check are measured against. Injected so a
   * test can move time instead of waiting for it; `Date.now` by default.
   */
  now?: () => number;
  /**
   * How a re-check timer is armed and cleared. Injected so a test can run the
   * arming and the cap without real time passing; the globals by default.
   */
  setTimeoutFn?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
  /**
   * What a due handler that threw synchronously is reported to. A throw from
   * `onDue` must not escape a timer callback and take the process down; the
   * entry is then left to the pass's own catch-up rather than re-armed against
   * an instant that has already arrived.
   */
  onError?: (err: unknown) => void;
}

/** What to call when an entry is due. */
export type OnDue = (entry: AgentScheduleEntry) => void;

/**
 * The next run of every enabled `schedule` rule.
 *
 * An entry that is still in the future is kept as it is: re-planning from the
 * current instant every pass would slide a rule's due time forward and a rule
 * that runs hourly would never come round.
 */

/**
 * Whether an entry is one no rule can run any more.
 *
 * A due entry is normally fired late rather than dropped — a agent that was
 * away catches up — so what cannot run is the entry whose rule is disabled,
 * gone, or no longer a rule the clock wakes: its instant has arrived, nothing
 * will run it, and the schedule moves on with nothing anywhere saying the
 * group's automation did not happen. Those are the entries worth a line in the
 * trail.
 *
 * One predicate for that question, read by the pass that records the vanished
 * runs (`unrunEntries`) and by the writer that carries an entry a peer owns
 * (`carryingForeign`): two answers to "can this entry still run" would leave a
 * run dropped by one of them and unrecorded by the other.
 */
export function unrunEntry(
  entry: AgentScheduleEntry,
  rules: ReadonlyArray<AgentRule>,
): boolean {
  const rule = rules.find((candidate) => candidate.id === entry.ruleId);
  return !rule?.enabled || rule.trigger.on !== "schedule";
}

/**
 * The due runs no rule can run any more.
 *
 * The caller that knows which entries it could not fire is the one that records
 * them, and it records them as `missed` runs — an automation that was due and
 * did not happen.
 */
export function unrunEntries(
  due: ReadonlyArray<AgentScheduleEntry>,
  rules: ReadonlyArray<AgentRule>,
): AgentScheduleEntry[] {
  return due.filter((entry) => unrunEntry(entry, rules));
}

export function planSchedule(
  rules: ReadonlyArray<AgentRule>,
  now: Date,
  existing: ReadonlyArray<AgentScheduleEntry> = [],
): AgentScheduleEntry[] {
  const kept = new Map(existing.map((entry) => [entry.ruleId, entry]));
  const out: AgentScheduleEntry[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger.on !== "schedule") continue;
    const previous = kept.get(rule.id);
    if (previous && Date.parse(previous.at) > now.getTime()) {
      out.push(previous);
      continue;
    }
    const next = nextRunAfter(rule, now);
    if (next) out.push({ ruleId: rule.id, at: next.toISOString() });
  }
  return out;
}

/** The entries whose instant has arrived. */
export function dueEntries(
  entries: ReadonlyArray<AgentScheduleEntry>,
  now: Date,
): AgentScheduleEntry[] {
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at <= now.getTime();
  });
}

/**
 * The schedule document after `fired` ran: the fired entries are re-planned
 * from `now` (so a run that took minutes does not immediately fire again) and
 * everything else is carried over.
 */
export function advance(
  entries: ReadonlyArray<AgentScheduleEntry>,
  fired: ReadonlyArray<AgentScheduleEntry>,
  rules: ReadonlyArray<AgentRule>,
  now: Date,
): AgentScheduleEntry[] {
  const firedRules = new Set(fired.map((entry) => entry.ruleId));
  const remaining = entries.filter(
    (entry) => !firedRules.has(entry.ruleId) || Date.parse(entry.at) > now.getTime(),
  );
  return planSchedule(rules, now, remaining);
}

/**
 * The schedule document as one agent may write it.
 *
 * `next` is what a agent holding the account's claim would write, and `stored`
 * is what the document holds. A claim is the account's, and so is the schedule:
 * a agent that does not hold it owns none of the entries, and each is carried
 * over exactly as it was found — still due, if it was due. Re-planning one here
 * would move its instant past the run its holder is about to start, and the run
 * would be lost with no line anywhere saying the group's automation did not
 * happen.
 *
 * A rule that is disabled, gone, or no longer on the clock is not carried: the
 * document drops it and the pass records it as a missed run, which is the one
 * vanishing the record accounts for.
 */
export function carryingForeign(
  next: ReadonlyArray<AgentScheduleEntry>,
  stored: ReadonlyArray<AgentScheduleEntry>,
  rules: ReadonlyArray<AgentRule>,
  ownedRuleIds: ReadonlySet<string>,
): AgentScheduleEntry[] {
  const carried = stored.filter((entry) => {
    if (ownedRuleIds.has(entry.ruleId)) return false;
    return !unrunEntry(entry, rules);
  });
  if (!carried.length) return [...next];
  const carriedIds = new Set(carried.map((entry) => entry.ruleId));
  return [...next.filter((entry) => !carriedIds.has(entry.ruleId)), ...carried];
}

/**
 * The shortest wait a timer is armed with.
 *
 * Nothing here measures time more finely than a person would notice, and zero is
 * the one wait that cannot be: a timer armed for zero fires in the tick it was
 * armed in, and an entry that is still due is then re-checked, found due, and
 * armed again. This is what an entry whose instant has arrived waits before it
 * is reported.
 */
const MIN_ARM_MS = 250;

/**
 * Arm a timer per entry. Returns the disposer that clears them all.
 *
 * A capped timer fires before its entry is due; that is not a due entry, so it
 * re-arms for the rest instead of reporting one — the cap buys a re-check, it
 * never stands in for the instant. An entry whose instant has already arrived is
 * reported on the shortest wait there is rather than in the tick it was armed
 * in, so a schedule armed against an instant that has passed cannot spin.
 */
export function armTimers(
  entries: ReadonlyArray<AgentScheduleEntry>,
  onDue: OnDue,
  opts: ArmTimersOpts,
): () => void {
  const now = opts.now ?? Date.now;
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const arm = (entry: AgentScheduleEntry) => {
    if (stopped) return;
    const due = Date.parse(entry.at);
    if (!Number.isFinite(due)) return;
    // The wait is a wait, never zero. An entry whose instant has already
    // arrived — the state a fire the account's lock deferred leaves behind, and
    // the state a clock behind the one the plan was made against produces — is
    // re-checked after the shortest wait there is rather than armed for this
    // tick: a zero delay fires, is reported, and is armed again before the
    // account could act on any of it, which is a request loop wearing a
    // scheduler's clothes.
    const until = due - now();
    // The cap is floored too, and for the same reason from the other end:
    // `maxDelayMs` of zero (or a negative one) would make every wait zero, so a
    // far-future entry would be re-checked in a spin loop instead of at the
    // cap.
    const cap = Math.max(opts.maxDelayMs, MIN_ARM_MS);
    const delay = until > 0 ? Math.min(until, cap) : MIN_ARM_MS;
    const timer = setTimeoutFn(() => {
      timers.delete(timer);
      if (stopped) return;
      if (now() >= due) {
        // One entry's handler must not be able to kill the agent: a throw that
        // escaped here would be an uncaught exception in a timer callback. It is
        // reported and the entry is **not** re-armed: the instant has already
        // arrived, so re-arming would fire again at the shortest wait for as long
        // as the handler keeps throwing — a spin wearing a scheduler's clothes.
        // The entry stays due in the document, and the pass's own catch-up
        // (`runDueSchedules`) is what picks it up again.
        try {
          onDue(entry);
        } catch (err) {
          opts.onError?.(err);
        }
      } else arm(entry);
    }, delay);
    timers.add(timer);
  };

  for (const entry of entries) arm(entry);
  return () => {
    stopped = true;
    for (const timer of timers) clearTimeoutFn(timer);
    timers.clear();
  };
}
