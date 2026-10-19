import type { RunSummary } from "@/lib/agentAdmin";

/** What a set of runs spent, and how they ended: the numbers the pages show. */
export interface RunMetrics {
  runs: number;
  steps: number;
  calls: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  /** The prompt tokens the provider served from its cache. */
  cachedTokens: number;
  /** Steps the agent refused, across the runs. */
  refused: number;
  /** Runs in flight: the one ending a table draws. */
  running: number;
}

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
 * The tally of a listing, run by run; a run this build cannot read is not
 * counted. `since` keeps a run whose end is inside the window — a run still
 * running is now, and belongs to the period being lived in.
 */
export function metricsOf(list: readonly RunSummary[], since?: Date): RunMetrics {
  const total: RunMetrics = {
    runs: 0,
    steps: 0,
    calls: 0,
    ms: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    refused: 0,
    running: 0,
  };
  for (const run of list) {
    if (!run.state) continue;
    if (since) {
      const at = run.ended ? Date.parse(run.ended.at) : Date.now();
      if (Number.isFinite(at) && at < since.getTime()) continue;
    }
    total.runs += 1;
    total.steps += run.spent.steps;
    total.calls += run.spent.calls;
    total.ms += run.spent.ms;
    total.promptTokens += run.spent.promptTokens ?? 0;
    total.completionTokens += run.spent.completionTokens ?? 0;
    total.cachedTokens += run.spent.cachedPromptTokens ?? 0;
    total.refused += run.refused;
    if (run.state === "running") total.running += 1;
  }
  return total;
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
    a.refused === b.refused &&
    a.steps === b.steps
  );
}
