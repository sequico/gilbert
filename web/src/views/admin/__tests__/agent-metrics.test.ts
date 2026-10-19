import { describe, expect, it } from "vitest";
import type { RunSummary } from "@/lib/agentAdmin";
import { metricsOf, periodSince, sameRunHeader } from "../agents/metrics";

/** One run as the listing carries it, with only the fields the tally reads. */
function listed(id: string, run: Record<string, unknown> | null): RunSummary {
  if (!run) {
    return {
      id,
      problem: "not readable",
      state: null,
      ended: null,
      rule: null,
      woke: null,
      steps: 0,
      refused: 0,
      spent: { steps: 0, calls: 0, ms: 0 },
    };
  }
  const plan = (run.plan ?? []) as Array<{ state?: string }>;
  return {
    id,
    problem: null,
    state: run.state as RunSummary["state"],
    ended: (run.ended ?? null) as RunSummary["ended"],
    rule: null,
    woke: null,
    steps: plan.length,
    refused: plan.filter((step) => step.state === "failed").length,
    spent: run.spent as RunSummary["spent"],
  };
}

describe("the runs' tally", () => {
  it("sums what the runs spent, and skips what it cannot read", () => {
    const runs = [
      listed("a", {
        state: "done",
        plan: [{ state: "done" }, { state: "failed" }],
        spent: { steps: 2, calls: 3, ms: 1000, promptTokens: 100, completionTokens: 40 },
      }),
      listed("b", {
        state: "running",
        plan: [{ state: "done" }],
        spent: { steps: 1, calls: 1, ms: 500 },
      }),
      listed("c", null),
      listed("d", {
        state: "cancelled",
        plan: [],
        spent: { steps: 0, calls: 0, ms: 0 },
      }),
    ];

    const total = metricsOf(runs);
    expect(total.runs).toBe(3);
    expect(total.steps).toBe(3);
    expect(total.calls).toBe(4);
    expect(total.ms).toBe(1500);
    expect(total.promptTokens).toBe(100);
    expect(total.completionTokens).toBe(40);
    expect(total.refused).toBe(1);
    expect(total.running).toBe(1);
  });

  it("keeps only the runs that ended inside the window", () => {
    const now = new Date(2026, 9, 19, 12, 0, 0);
    const runs = [
      listed("today", {
        state: "done",
        plan: [],
        spent: { steps: 1, calls: 1, ms: 10 },
        ended: { at: new Date(2026, 9, 19, 9, 0, 0).toISOString(), why: "done" },
      }),
      listed("lastweek", {
        state: "done",
        plan: [],
        spent: { steps: 1, calls: 1, ms: 10 },
        ended: { at: new Date(2026, 9, 12, 9, 0, 0).toISOString(), why: "done" },
      }),
    ];

    expect(metricsOf(runs, periodSince("day", now)).runs).toBe(1);
    expect(metricsOf(runs, periodSince("week", now)).runs).toBe(1);
    expect(metricsOf(runs, periodSince("month", now)).runs).toBe(2);
    expect(metricsOf(runs, periodSince("all", now)).runs).toBe(2);
    expect(periodSince("week", now)?.getDay()).toBe(1);
  });

  it("is all zeroes for an empty listing", () => {
    const total = metricsOf([]);
    expect(total.runs).toBe(0);
    expect(total.calls).toBe(0);
    expect(total.promptTokens).toBe(0);
  });
});

describe("the list's header", () => {
  it("sees the wall time of a wave even when no call or state moved", () => {
    const base = listed("slow", {
      state: "running",
      plan: [{ state: "open" }],
      spent: { steps: 0, calls: 1, ms: 10 },
    });
    expect(sameRunHeader(base, { ...base })).toBe(true);
    expect(sameRunHeader(base, { ...base, spent: { ...base.spent, ms: 20 } })).toBe(
      false,
    );
  });
});
