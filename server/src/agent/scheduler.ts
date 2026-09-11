/**
 * Time triggers on documents (ADR 0003 §5).
 *
 * The schedule is a document in the group's own account (`agent/schedule.json`)
 * holding the next run instant of every `schedule` rule, so no container has to
 * live for a run to happen: a replacement worker re-plans from Stalwart and
 * re-arms its timers. The planning, the due check and the advance are pure
 * functions, testable without a clock; `armTimers` is the only part that
 * touches a timer, and it takes the clock and the timers from its options (the
 * globals by default) so a test can drive it without waiting. It caps every
 * delay so a far-future instant is re-checked rather than trusted to one long
 * sleep.
 */

import { type AgentRule, type AgentScheduleEntry, nextRunAfter } from "./documents.js";

/** How much of a schedule the executor keeps in memory at once, in entries. */
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
 * The due runs no rule can run any more.
 *
 * A due entry is normally fired late rather than dropped — a worker that was
 * away catches up — so the runs that vanish are the ones whose rule is disabled
 * or gone: the schedule moves to the next instant and nothing anywhere says the
 * group's automation did not happen. These are the entries worth a line in the
 * trail, and the caller that knows which ones it could not fire is the one that
 * records them.
 */
export function unrunEntries(
  due: ReadonlyArray<AgentScheduleEntry>,
  rules: ReadonlyArray<AgentRule>,
): AgentScheduleEntry[] {
  return due.filter((entry) => {
    const rule = rules.find((candidate) => candidate.id === entry.ruleId);
    return !rule?.enabled;
  });
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
 * The schedule document as one worker may write it.
 *
 * `next` is what a worker holding the account's claim would write, and `stored`
 * is what the document holds. A claim is the account's, and so is the schedule:
 * a worker that does not hold it owns none of the entries, and each is carried
 * over exactly as it was found — still due, if it was due. Re-planning one here
 * would move its instant past the run its holder is about to start, and the run
 * would be lost with no line anywhere saying the group's automation did not
 * happen.
 *
 * A rule that is disabled or gone is not carried: the document drops it and the
 * pass records it as a missed run, which is the one vanishing the record
 * accounts for.
 */
export function carryingForeign(
  next: ReadonlyArray<AgentScheduleEntry>,
  stored: ReadonlyArray<AgentScheduleEntry>,
  rules: ReadonlyArray<AgentRule>,
  ownedRuleIds: ReadonlySet<string>,
): AgentScheduleEntry[] {
  const carried = stored.filter((entry) => {
    if (ownedRuleIds.has(entry.ruleId)) return false;
    const rule = rules.find((candidate) => candidate.id === entry.ruleId);
    return Boolean(rule?.enabled && rule.trigger.on === "schedule");
  });
  if (!carried.length) return [...next];
  const carriedIds = new Set(carried.map((entry) => entry.ruleId));
  return [...next.filter((entry) => !carriedIds.has(entry.ruleId)), ...carried];
}

/**
 * Arm a timer per entry. Returns the disposer that clears them all.
 *
 * A capped timer fires before its entry is due; that is not a due entry, so it
 * re-arms for the rest instead of reporting one — the cap buys a re-check, it
 * never stands in for the instant.
 */
/**
 * The shortest delay a timer is armed with.
 *
 * Nothing here measures time more finely than a person would notice, and an
 * arm of zero is always a bug: the entry is re-checked, found not due, and
 * re-armed in the same tick.
 */
const MIN_ARM_MS = 250;

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
    // The cap is floored as well as applied: `maxDelayMs` of zero (or a
    // negative one) would arm an instant timer for an entry that is not due,
    // over and over, which is a spin loop that looks like a scheduler.
    const cap = Math.max(opts.maxDelayMs, MIN_ARM_MS);
    const delay = Math.min(Math.max(due - now(), 0), cap);
    const timer = setTimeoutFn(() => {
      timers.delete(timer);
      if (stopped) return;
      if (now() >= due) onDue(entry);
      else arm(entry);
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
