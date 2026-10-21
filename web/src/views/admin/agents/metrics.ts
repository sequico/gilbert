import type { RunSummary } from "@/lib/agentAdmin";

/*
 * The tally is the shared one (`@gilbert/shared/agentMetrics`): the server
 * computes a group's numbers over its runs and this tier draws them, so the
 * table and the answer behind it cannot disagree about a total. What lives here
 * is the reader's own clock and the one comparison a poll makes.
 */
export {
  addMetrics,
  emptyMetrics,
  metricsOf,
  type RunMetrics,
} from "@gilbert/shared/agentMetrics";

/** The window a set of numbers is read over. */
export type MetricsPeriod = "day" | "week" | "month" | "all";

/**
 * The first instant of a period, in the reader's own clock — or undefined for
 * all time. A week starts on Monday, which is what the calendars here do.
 */
export function periodSince(period: MetricsPeriod, now = new Date()): Date | undefined {
  if (period === "all") return undefined;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === "month") start.setDate(1);
  return start;
}

/**
 * Whether a poll changed the header a row is drawn from.
 *
 * `spent.ms` is part of it: a wave records its outcomes and wall time without
 * a new model call, and an open detail reads the document when this changes.
 */
export function sameRunHeader(a: RunSummary, b: RunSummary): boolean {
  return (
    a.state === b.state &&
    a.ended?.at === b.ended?.at &&
    a.spent.calls === b.spent.calls &&
    a.spent.steps === b.spent.steps &&
    a.spent.ms === b.spent.ms &&
    a.failed === b.failed &&
    a.steps === b.steps &&
    /*
     * A step that turned from open to done is a new answer on the same numbers:
     * the live list draws what the run is doing, so the plan is part of what
     * "the same run" means.
     */
    planKey(a.plan) === planKey(b.plan)
  );
}

/** A plan as one comparable string: each step's words and where it stands. */
function planKey(plan: RunSummary["plan"]): string {
  return (plan ?? []).map((step) => `${step.state}\u0000${step.what}`).join("\u0001");
}
