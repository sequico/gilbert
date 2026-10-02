import type { KnowledgeSummary } from "@gilbert/shared/knowledge";
import { describe, expect, it } from "vitest";
import { siblingDropPlan } from "@/lib/knowledge";

/** Just the fields the drop plan reads; the rest of the summary is not its concern. */
const sib = (nodeId: string, order: number): KnowledgeSummary =>
  ({ nodeId, folder: nodeId, order }) as unknown as KnowledgeSummary;

describe("a sibling drop's plan", () => {
  it("writes the midpoint of the neighbours it lands between", () => {
    const siblings = [sib("a", 1), sib("b", 2), sib("c", 4)];
    // C after A: between A(1) and B(2), so 1.5.
    expect(siblingDropPlan(siblings, "c", "a", "after")).toEqual({
      kind: "order",
      folder: "c",
      order: 1.5,
    });
  });

  it("renumbers the family once the midpoint collapses onto a sibling", () => {
    // B sits on the next representable double after A, so the midpoint of A and
    // B is A again: the drop cannot order them, and the family is renumbered.
    const siblings = [sib("a", 1), sib("b", 1 + Number.EPSILON), sib("c", 5)];
    const plan = siblingDropPlan(siblings, "c", "b", "before");
    expect(plan?.kind).toBe("renumber");
    if (plan?.kind !== "renumber") return;
    // The drop leaves A, C, B: C takes 2 and B takes 3; A already holds 1.
    expect(plan.orders).toEqual([
      { folder: "c", order: 2 },
      { folder: "b", order: 3 },
    ]);
  });

  it("lands after the last sibling without a collision", () => {
    const siblings = [sib("a", 1), sib("b", 2), sib("c", 3)];
    expect(siblingDropPlan(siblings, "a", "c", "after")).toEqual({
      kind: "order",
      folder: "a",
      order: 4,
    });
  });
});
