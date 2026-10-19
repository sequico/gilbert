import type { WorkorderStepState, WorkorderSummary } from "@gilbert/shared/workorder";
import { describe, expect, it } from "vitest";
import { listEntryOf } from "@/lib/workorder";

/*
 * The list's card is derived from the one read an open composes: the panel
 * writes a mutation's answer back as a card, and the counts must be the same
 * ones the server's list answers (`WorkorderListPart`). A card that counted
 * `not-applicable` as progress, or dropped the template, would disagree with
 * the part it opens.
 */

const summary = (states: WorkorderStepState[]): WorkorderSummary => ({
  uid: "w1",
  name: "Packing",
  state: "running",
  refs: [],
  created: { by: "demo@example.com", at: "2026-10-20T00:00:00.000Z" },
  updated: { by: "demo@example.com", at: "2026-10-20T00:00:00.000Z" },
  replacedBy: null,
  canAdminister: false,
  parts: [
    {
      scope: "group",
      accountId: "a3",
      group: "team@example.org",
      checklist: {
        template: { accountId: "a1", id: "template-1", revision: "revision-1" },
        variants: {},
        items: {},
        steps: [],
      },
      groups: [
        {
          key: "loading",
          label: "Loading",
          repeat: "Container",
          items: [
            {
              key: "CONT-1",
              label: "CONT-1",
              fields: [],
              steps: states.map((state, index) => ({
                path: `loading[CONT-1].${index}`,
                label: `Step ${index}`,
                state,
                by: null,
                at: null,
                note: "",
              })),
            },
          ],
        },
      ],
      templateTitle: "Packing checklist",
      templateRev: 2,
      canCheck: true,
    },
  ],
});

describe("a workorder's list card", () => {
  it("counts done and skipped, and leaves the other two out of progress", () => {
    const entry = listEntryOf(summary(["done", "skipped", "open", "not-applicable"]));
    expect(entry.parts[0]?.complete).toBe(2);
    expect(entry.parts[0]?.total).toBe(4);
  });

  it("names the template the part is bound to, and its progress", () => {
    const part = listEntryOf(summary(["done"]))?.parts[0];
    expect(part?.template).toEqual({
      accountId: "a1",
      id: "template-1",
      revision: "revision-1",
    });
    expect(part?.templateTitle).toBe("Packing checklist");
    expect(part?.templateRev).toBe(2);
    expect(part?.group).toBe("team@example.org");
  });
});
