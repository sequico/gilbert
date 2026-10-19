import type { RunListing } from "@/lib/agentAdmin";

/** What a set of runs spent, and how they ended: the numbers the pages show. */
export interface RunMetrics {
  runs: number;
  steps: number;
  calls: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  /** Steps the agent refused, across the runs. */
  refused: number;
  running: number;
  done: number;
  blocked: number;
  outOfBudget: number;
}

/** The tally of a listing, run by run; a run this build cannot read is not counted. */
export function metricsOf(list: readonly RunListing[]): RunMetrics {
  const total: RunMetrics = {
    runs: 0,
    steps: 0,
    calls: 0,
    ms: 0,
    promptTokens: 0,
    completionTokens: 0,
    refused: 0,
    running: 0,
    done: 0,
    blocked: 0,
    outOfBudget: 0,
  };
  for (const listed of list) {
    const run = listed.run;
    if (!run) continue;
    total.runs += 1;
    total.steps += run.spent.steps;
    total.calls += run.spent.calls;
    total.ms += run.spent.ms;
    total.promptTokens += run.spent.promptTokens ?? 0;
    total.completionTokens += run.spent.completionTokens ?? 0;
    total.refused += run.plan.filter((step) => step.state === "failed").length;
    if (run.state === "running") total.running += 1;
    else if (run.state === "done") total.done += 1;
    else if (run.state === "blocked") total.blocked += 1;
    else total.outOfBudget += 1;
  }
  return total;
}
