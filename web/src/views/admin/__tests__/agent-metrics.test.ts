import { describe, expect, it } from "vitest";
import type { RunListing } from "@/lib/agentAdmin";
import { metricsOf } from "../agents/metrics";

/** One run as the listing carries it, with only the fields the tally reads. */
function listed(id: string, run: Record<string, unknown> | null): RunListing {
  return { id, run: run as never, problem: run ? null : "not readable" };
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
    ];

    const total = metricsOf(runs);
    expect(total.runs).toBe(2);
    expect(total.steps).toBe(3);
    expect(total.calls).toBe(4);
    expect(total.ms).toBe(1500);
    expect(total.promptTokens).toBe(100);
    expect(total.completionTokens).toBe(40);
    expect(total.refused).toBe(1);
    expect(total.done).toBe(1);
    expect(total.running).toBe(1);
  });

  it("is all zeroes for an empty listing", () => {
    const total = metricsOf([]);
    expect(total.runs).toBe(0);
    expect(total.calls).toBe(0);
    expect(total.promptTokens).toBe(0);
  });
});
