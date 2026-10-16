import { AGENT_LABELS } from "@gilbert/shared/labels";
import { describe, expect, it } from "vitest";
import { agentLabelsOn } from "@/lib/agentLabels";

/**
 * The reserved labels on a message.
 *
 * The `G-` namespace is the product's own, so a message's processing state is
 * rendered from the vocabulary in code and never from a group's catalog — the
 * catalog holds only the group's human labels. The point of these assertions
 * is that the entries are the shared vocabulary's own objects: a second list
 * spelled here would render the same words and still be the duplication this
 * pins away.
 */
describe("the reserved labels a message carries", () => {
  it("reads them from the product's own vocabulary", () => {
    const on = agentLabelsOn({ "G-processed": true });
    expect(on).toHaveLength(1);
    expect(on[0]).toBe(AGENT_LABELS.find((l) => l.keyword === "G-processed"));
    expect(on[0]?.name).toBe("Gilbert: processed");
  });

  it("renders nothing for a keyword the vocabulary does not name", () => {
    expect(agentLabelsOn({ "G-invented": true })).toEqual([]);
    expect(agentLabelsOn({ work: true })).toEqual([]);
    expect(agentLabelsOn(undefined)).toEqual([]);
  });

  it("carries the whole reserved vocabulary when the message does", () => {
    const carried = Object.fromEntries(AGENT_LABELS.map((l) => [l.keyword, true]));
    expect(agentLabelsOn(carried)).toEqual(AGENT_LABELS);
  });
});
