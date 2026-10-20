/**
 * What a set of runs spent, and how they ended (ADR 0030).
 *
 * One definition for both tiers: the Administration page draws these numbers
 * and the server computes them over a group's runs, so a page and the answer it
 * was given cannot disagree about a total. A run this build cannot read is not
 * counted — it has no state to tally — and the window keeps a run whose end is
 * inside it, with a run still in flight counted as now.
 */

import type { RunSummary } from "./run.js";

export interface RunMetrics {
  runs: number;
  steps: number;
  calls: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  /** The prompt tokens the provider served from its cache. */
  cachedTokens: number;
  /** Plan entries that ended failed, across the runs. */
  failed: number;
  /** Runs in flight: the one ending a table draws. */
  running: number;
}

/** The zero tally: a period with no run, and the base of a sum. */
export function emptyMetrics(): RunMetrics {
  return {
    runs: 0,
    steps: 0,
    calls: 0,
    ms: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    failed: 0,
    running: 0,
  };
}

/** The tally of a listing, run by run; `since` is the window's first instant. */
export function metricsOf(list: readonly RunSummary[], since?: Date): RunMetrics {
  const total = emptyMetrics();
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
    total.failed += run.failed;
    if (run.state === "running") total.running += 1;
  }
  return total;
}

/** The sum of two tallies, for a page that adds one group's to another's. */
export function addMetrics(a: RunMetrics, b: RunMetrics): RunMetrics {
  return {
    runs: a.runs + b.runs,
    steps: a.steps + b.steps,
    calls: a.calls + b.calls,
    ms: a.ms + b.ms,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    failed: a.failed + b.failed,
    running: a.running + b.running,
  };
}
