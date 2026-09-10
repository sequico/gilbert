/**
 * Time triggers on documents (ADR 0003 §5).
 *
 * The schedule is a document in the group's own account (`agent/schedule.json`)
 * holding the next run instant of every `schedule` rule, so no container has to
 * live for a run to happen: a replacement worker re-plans from Stalwart and
 * re-arms its timers. The planning, the due check and the advance are pure
 * functions, testable without a clock; `armTimers` is the only part that
 * touches a timer, and it caps every delay so a far-future instant is
 * re-checked rather than trusted to one long sleep.
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
 * Arm a timer per entry. Returns the disposer that clears them all.
 *
 * A capped timer fires before its entry is due; that is not a due entry, so it
 * re-arms for the rest instead of reporting one.
 */
export function armTimers(
  entries: ReadonlyArray<AgentScheduleEntry>,
  onDue: OnDue,
  opts: ArmTimersOpts,
): () => void {
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const arm = (entry: AgentScheduleEntry) => {
    if (stopped) return;
    const due = Date.parse(entry.at);
    if (!Number.isFinite(due)) return;
    const delay = Math.min(Math.max(due - Date.now(), 0), opts.maxDelayMs);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      if (Date.now() >= due) onDue(entry);
      else arm(entry);
    }, delay);
    timers.add(timer);
  };

  for (const entry of entries) arm(entry);
  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
